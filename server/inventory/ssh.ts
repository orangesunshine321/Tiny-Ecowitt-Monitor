/**
 * ssh2-based CommandRunner for the forced-command helpers (docs/HELPER_PROTOCOL.md "Transport").
 *
 * - One connection per command; the "command" is only the protocol argument string (it reaches the helper as
 *   SSH_ORIGINAL_COMMAND), e.g. "inventory 102".
 * - Host keys are pinned from an OpenSSH known_hosts file. The Proxmox host (config.inventory.host) must already be
 *   pinned there (the installer writes it); other targets (VMs reached directly) are trust-on-first-use: an unknown key
 *   is appended after a successful handshake, and a different key later is refused.
 * - Bounded by ssh2's readyTimeout (handshake) and a hard overall timer. Closing the connection does not kill the
 *   remote process, which is why the helpers bound their own work with `timeout`.
 * - stdout is capped (the call fails beyond it); stderr is truncated silently.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2'; // CommonJS: named imports fail under Node ESM, use the default export
import type { ConnectConfig, ServerHostKeyAlgorithm } from 'ssh2';
import type { SshTarget } from '../config.js';
import type { AppContext, CommandResult, CommandRunner, Logger } from '../context.js';

const { Client } = ssh2;

export const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const READY_TIMEOUT_MS = 10_000;

// ───────────────────────────────────────────────────────────── known_hosts

export interface KnownHostEntry {
  marker?: 'revoked' | 'cert-authority';
  /** comma-separated host patterns of a plain entry ("host", "[host]:2222", "*.lan", "!bad.lan") */
  patterns: string[];
  /** hashed entry ("|1|salt|hash"): HMAC-SHA1(salt, hostname) */
  hashed?: { salt: Buffer; hash: Buffer };
  keyType: string;
  /** raw public key in SSH wire format (what ssh2 hands to hostVerifier) */
  blob: Buffer;
  line: number;
}

/** Decode a base64 public key and check that its embedded type matches. */
export function parseKeyBlob(type: string, b64: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const blob = Buffer.from(b64, 'base64');
  if (blob.length < 4) return null;
  const tlen = blob.readUInt32BE(0);
  if (4 + tlen > blob.length || blob.subarray(4, 4 + tlen).toString('latin1') !== type) return null;
  return blob;
}

/** Key type embedded in a wire-format public key ("ssh-ed25519", "ssh-rsa", ...). */
export function blobKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const tlen = blob.readUInt32BE(0);
  if (tlen === 0 || 4 + tlen > blob.length) return null;
  const type = blob.subarray(4, 4 + tlen).toString('latin1');
  return /^[A-Za-z0-9@._-]+$/.test(type) ? type : null;
}

/** OpenSSH-style fingerprint, identical to `ssh-keygen -lf`: "SHA256:<base64 without padding>". */
export function sshFingerprint(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** Parse an OpenSSH known_hosts file. Malformed lines are skipped. */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const tokens = line.split(/\s+/);
    let i = 0;
    let marker: KnownHostEntry['marker'];
    if (tokens[0]!.startsWith('@')) {
      if (tokens[0] === '@revoked') marker = 'revoked';
      else if (tokens[0] === '@cert-authority') marker = 'cert-authority';
      else return;
      i = 1;
    }
    const hosts = tokens[i];
    const keyType = tokens[i + 1];
    const b64 = tokens[i + 2];
    if (!hosts || !keyType || !b64) return;
    const blob = parseKeyBlob(keyType, b64);
    if (!blob) return;
    const entry: KnownHostEntry = { patterns: [], keyType, blob, line: idx + 1, ...(marker ? { marker } : {}) };
    if (hosts.startsWith('|1|')) {
      const [, , salt, hash] = hosts.split('|');
      if (!salt || !hash) return;
      entry.hashed = { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
    } else {
      entry.patterns = hosts.split(',').filter(Boolean);
    }
    out.push(entry);
  });
  return out;
}

/** Host name as known_hosts writes it: "host" for port 22, "[host]:port" otherwise. */
export function knownHostsName(address: string, port: number): string {
  return port === 22 ? address : `[${address}]:${port}`;
}

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
    'i',
  );
  return re.test(name);
}

/** Does a known_hosts entry apply to this host name? (wildcards, negation and hashed names supported) */
export function hostMatches(entry: KnownHostEntry, name: string): boolean {
  if (entry.hashed) {
    const { salt, hash } = entry.hashed;
    return [name, name.toLowerCase()].some((n) => {
      const h = createHmac('sha1', salt).update(n).digest();
      return h.length === hash.length && timingSafeEqual(h, hash);
    });
  }
  let positive = false;
  for (const p of entry.patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), name)) return false;
    } else if (globMatch(p, name)) positive = true;
  }
  return positive;
}

const ALGORITHMS_FOR_KEY_TYPE: Record<string, ServerHostKeyAlgorithm[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};
const ALGORITHM_PREFERENCE: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa',
];

/**
 * Host key algorithms to offer so the server presents a key we have pinned (e.g. only an RSA key in known_hosts must
 * not let ssh2 negotiate ed25519 and then fail verification).
 */
export function hostKeyAlgorithms(keyTypes: string[]): ServerHostKeyAlgorithm[] {
  const wanted = new Set(keyTypes.flatMap((t) => ALGORITHMS_FOR_KEY_TYPE[t] ?? []));
  return ALGORITHM_PREFERENCE.filter((a) => wanted.has(a));
}

// ───────────────────────────────────────────────────────────── runner

export interface SshRunnerOptions {
  privateKeyPath: string;
  knownHostsPath: string;
  /** Targets that must already be pinned in known_hosts (the Proxmox host). Everything else is trust-on-first-use. */
  strictTargets: SshTarget[];
  log: Logger;
  readyTimeoutMs?: number;
  maxStdoutBytes?: number;
}

class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  /** false once the cap is exceeded */
  push(d: Buffer): boolean {
    if (this.size + d.length > this.max) {
      const room = this.max - this.size;
      if (room > 0) this.chunks.push(d.subarray(0, room));
      this.size = this.max;
      this.truncated = true;
      return false;
    }
    this.chunks.push(d);
    this.size += d.length;
    return true;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const sameTarget = (a: SshTarget, b: SshTarget) => a.address === b.address && a.port === b.port;
const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const withLine = (text: string, line: string) => (text && !text.endsWith('\n') ? `${text}\n${line}` : `${text}${line}`);

function describeError(e: unknown, label: string, verifyFailure: string | undefined): Error {
  if (verifyFailure) return new Error(`ssh ${label}: ${verifyFailure}`);
  const err = e as Error & { level?: string; code?: string };
  const code = err.code ?? '';
  let why: string;
  if (err.level === 'client-authentication') why = 'authentication failed (is the pve1-dash key authorized on the target?)';
  else if (err.level === 'client-timeout') why = 'SSH handshake timed out';
  else if (code === 'ECONNREFUSED') why = 'connection refused (is sshd running?)';
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') why = `host unreachable (${code})`;
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') why = 'cannot resolve host name';
  else if (code === 'ECONNRESET') why = 'connection reset by peer';
  else why = err.message || String(e);
  return new Error(`ssh ${label}: ${why}`);
}

export function createSshRunnerFrom(opts: SshRunnerOptions): CommandRunner {
  const log = opts.log;
  const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const readyTimeout = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const active = new Set<InstanceType<typeof Client>>();
  /** keys learned this process lifetime (also covers a read-only known_hosts file) */
  const learned = new Map<string, Buffer>();
  let closed = false;
  let keyCache: { mtimeMs: number; size: number; key: Buffer } | undefined;

  function loadPrivateKey(): Buffer {
    let st;
    try {
      st = statSync(opts.privateKeyPath);
    } catch {
      throw new Error(`SSH private key not found at ${opts.privateKeyPath} (inventory.privateKey)`);
    }
    if (keyCache && keyCache.mtimeMs === st.mtimeMs && keyCache.size === st.size) return keyCache.key;
    const key = readFileSync(opts.privateKeyPath);
    keyCache = { mtimeMs: st.mtimeMs, size: st.size, key };
    return key;
  }

  function readKnownHosts(): { text: string; entries: KnownHostEntry[] } {
    let text = '';
    try {
      text = readFileSync(opts.knownHostsPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`cannot read ${opts.knownHostsPath}: ${(e as Error).message}`);
      }
    }
    return { text, entries: parseKnownHosts(text) };
  }

  /** Trust on first use: append the key unless the file meanwhile pins this host (then keep the file as is). */
  function learnHostKey(name: string, blob: Buffer, type: string): void {
    learned.set(name, blob);
    try {
      const { text, entries } = readKnownHosts();
      const forHost = entries.filter((e) => !e.marker && hostMatches(e, name));
      if (forHost.length) return;
      mkdirSync(dirname(opts.knownHostsPath), { recursive: true, mode: 0o700 });
      const prefix = text && !text.endsWith('\n') ? '\n' : '';
      appendFileSync(opts.knownHostsPath, `${prefix}${name} ${type} ${blob.toString('base64')}\n`, { mode: 0o600 });
      log.info('learned SSH host key (trust on first use)', { host: name, fingerprint: sshFingerprint(blob) });
    } catch (e) {
      log.warn('could not save learned SSH host key; it is pinned in memory only', {
        host: name,
        file: opts.knownHostsPath,
        error: (e as Error).message,
      });
    }
  }

  function run(target: SshTarget, command: string, timeoutMs: number): Promise<CommandResult> {
    if (closed) return Promise.reject(new Error('ssh runner is closed'));
    const name = knownHostsName(target.address, target.port);
    const label = `${target.user}@${name}`;
    let privateKey: Buffer;
    let entries: KnownHostEntry[];
    try {
      privateKey = loadPrivateKey();
      entries = readKnownHosts().entries;
    } catch (e) {
      return Promise.reject(new Error(`ssh ${label}: ${(e as Error).message}`));
    }

    const strict = opts.strictTargets.some((t) => sameTarget(t, target));
    const pinned = entries.filter((e) => !e.marker && hostMatches(e, name)).map((e) => e.blob);
    const revoked = entries.filter((e) => e.marker === 'revoked').map((e) => e.blob);
    if (!pinned.length && learned.has(name)) pinned.push(learned.get(name)!);
    if (strict && !pinned.length) {
      const keyscan = `ssh-keyscan -t ed25519${target.port === 22 ? '' : ` -p ${target.port}`} ${target.address}`;
      return Promise.reject(
        new Error(
          `ssh ${label}: refusing to connect, the host key of ${name} is not pinned in ${opts.knownHostsPath}. ` +
            `Verify the key and add it, e.g. on pve1: ${keyscan} (or copy /etc/ssh/ssh_host_ed25519_key.pub as "${name} ssh-ed25519 AAAA...")`,
        ),
      );
    }
    const algorithms = pinned.length ? hostKeyAlgorithms(pinned.map((b) => blobKeyType(b) ?? '')) : [];

    return new Promise<CommandResult>((resolve, reject) => {
      const conn = new Client();
      active.add(conn);
      const stdout = new CappedBuffer(maxStdout);
      const stderr = new CappedBuffer(MAX_STDERR_BYTES);
      let settled = false;
      let execStarted = false;
      let verifyFailure: string | undefined;
      let toLearn: { blob: Buffer; type: string } | undefined;

      const finish = (err: Error | null, result?: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(conn);
        try {
          conn.end();
        } catch {
          /* already closed */
        }
        // end() is polite; make sure the socket goes away even if the peer never answers.
        setTimeout(() => conn.destroy(), 2000).unref();
        if (err) reject(err);
        else resolve(result!);
      };

      const timer = setTimeout(() => {
        if (execStarted) {
          // CommandResult contract: code null on timeout. Partial output is returned; the helpers frame their output
          // so a cut-off is detectable.
          finish(null, {
            stdout: stdout.text(),
            stderr: withLine(stderr.text(), `ssh: command timed out after ${secs(timeoutMs)}\n`),
            code: null,
          });
        } else {
          finish(new Error(`ssh ${label}: timed out after ${secs(timeoutMs)} before the command started`));
        }
      }, timeoutMs);

      const hostVerifier = (key: Buffer): boolean => {
        const fp = sshFingerprint(key);
        if (revoked.some((b) => b.length === key.length && timingSafeEqual(b, key))) {
          verifyFailure = `host key ${fp} of ${name} is marked @revoked in ${opts.knownHostsPath}`;
          return false;
        }
        if (pinned.length) {
          if (pinned.some((b) => b.length === key.length && timingSafeEqual(b, key))) return true;
          verifyFailure =
            `HOST KEY MISMATCH: ${name} presented ${fp}, which is not the key pinned in ${opts.knownHostsPath}. ` +
            'If the machine was reinstalled, verify the new key and remove the old line.';
          return false;
        }
        const type = blobKeyType(key);
        if (!type) {
          verifyFailure = 'server sent a malformed host key';
          return false;
        }
        toLearn = { blob: Buffer.from(key), type };
        return true;
      };

      conn.on('ready', () => {
        if (toLearn) learnHostKey(name, toLearn.blob, toLearn.type);
        conn.exec(command, (err, stream) => {
          if (err) {
            finish(new Error(`ssh ${label}: exec failed: ${err.message}`));
            return;
          }
          execStarted = true;
          let exitCode: number | null = null;
          let exitSignal: string | undefined;
          stream.on('exit', (code: number | null, signal?: string) => {
            exitCode = typeof code === 'number' ? code : null;
            exitSignal = signal ?? undefined;
          });
          stream.on('data', (d: Buffer) => {
            if (!stdout.push(d)) finish(new Error(`ssh ${label}: output exceeded ${maxStdout} bytes`));
          });
          stream.stderr.on('data', (d: Buffer) => {
            stderr.push(d);
          });
          stream.on('close', (code?: number | null, signal?: string) => {
            const c = typeof code === 'number' ? code : exitCode;
            const sig = signal ?? exitSignal;
            let errText = stderr.text();
            if (stderr.truncated) errText = withLine(errText, '[stderr truncated]\n');
            if (sig) errText = withLine(errText, `ssh: remote command killed by ${sig}\n`);
            finish(null, { stdout: stdout.text(), stderr: errText, code: sig ? null : c });
          });
        });
      });
      conn.on('error', (e) => finish(describeError(e, label, verifyFailure)));
      conn.on('close', () => finish(new Error(`ssh ${label}: connection closed before the command finished`)));

      const cfg: ConnectConfig = {
        host: target.address,
        port: target.port,
        username: target.user,
        privateKey,
        readyTimeout: Math.max(1000, Math.min(readyTimeout, timeoutMs)),
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier,
        ...(algorithms.length ? { algorithms: { serverHostKey: algorithms } } : {}),
      };
      try {
        conn.connect(cfg);
      } catch (e) {
        // e.g. "Cannot parse privateKey", "Encrypted private OpenSSH key detected, but no passphrase given"
        finish(new Error(`ssh ${label}: ${(e as Error).message}`));
      }
    });
  }

  return {
    run,
    close() {
      closed = true;
      for (const conn of active) {
        try {
          conn.end();
          conn.destroy();
        } catch {
          /* ignore */
        }
      }
      active.clear();
    },
  };
}

/** The production runner: key and known_hosts from config.inventory; the configured Proxmox host must be pinned. */
export function createSshRunner(ctx: AppContext): CommandRunner {
  const inv = ctx.config.inventory;
  return createSshRunnerFrom({
    privateKeyPath: inv.privateKey,
    knownHostsPath: inv.knownHosts,
    strictTargets: inv.host ? [inv.host] : [],
    log: ctx.log.child('ssh'),
  });
}
