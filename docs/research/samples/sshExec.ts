// ssh2 exec helper with pinned host key + overall timeout.
import ssh2 from 'ssh2'; // CJS: `import { utils } from 'ssh2'` FAILS under Node ESM; use default import.
import { timingSafeEqual, createHash } from 'node:crypto';

const { Client } = ssh2;

/** Accepts "ssh-ed25519 AAAA... comment" or a known_hosts line "[host]:22 ssh-ed25519 AAAA...". */
export function parsePinnedHostKey(line: string): { type: string; blob: Buffer } {
  const parts = line.trim().split(/\s+/);
  const i = parts.findIndex((p) => /^(ssh-|ecdsa-sha2-|sk-)/.test(p));
  if (i < 0 || !parts[i + 1]) throw new Error('no "<type> <base64>" found');
  const type = parts[i]!;
  const blob = Buffer.from(parts[i + 1]!, 'base64');
  const tlen = blob.readUInt32BE(0); // SSH wire format: string(type) || key data
  if (blob.subarray(4, 4 + tlen).toString('ascii') !== type) throw new Error('key type mismatch in blob');
  return { type, blob };
}

/** OpenSSH-style fingerprint, identical to `ssh-keygen -lf`: "SHA256:<base64 w/o padding>". */
export const sshFingerprint = (blob: Buffer) =>
  'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

export interface ExecResult { code: number | null; signal: string | null; stdout: string; stderr: string }

export function sshExec(
  opts: { host: string; port?: number; username: string; privateKey: Buffer | string; passphrase?: string; hostKey: string },
  command: string,
  timeoutMs = 15_000,
): Promise<ExecResult> {
  const pinned = parsePinnedHostKey(opts.hostKey).blob;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err: Error | null, r?: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      err ? reject(err) : resolve(r!);
    };
    const timer = setTimeout(() => done(new Error(`ssh exec timeout after ${timeoutMs}ms`)), timeoutMs);
    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) return done(err);
          const out: Buffer[] = [];
          const errOut: Buffer[] = [];
          stream.on('data', (d: Buffer) => out.push(d));
          stream.stderr.on('data', (d: Buffer) => errOut.push(d));
          stream.on('close', (code: number | null, signal?: string) =>
            done(null, {
              code: code ?? null,
              signal: signal ?? null,
              stdout: Buffer.concat(out).toString('utf8'),
              stderr: Buffer.concat(errOut).toString('utf8'),
            }),
          );
        });
      })
      .on('error', (e) => done(e))
      .on('close', () => done(new Error('ssh connection closed before command finished')))
      .connect({
        host: opts.host,
        port: opts.port ?? 22,
        username: opts.username,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        // Without hostHash, ssh2 passes the raw SSH-wire-format public key blob (Buffer).
        hostVerifier: (key: Buffer) => key.length === pinned.length && timingSafeEqual(key, pinned),
      });
  });
}
