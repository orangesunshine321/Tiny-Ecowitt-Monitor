/**
 * SSH inventory checks: key files and host-key pin, the Proxmox host helper (`version`), and the direct guest targets.
 * Only the read-only `version` command is sent; the forced-command helpers ignore anything else.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, SshTarget } from '../config.js';
import type { CommandResult, CommandRunner } from '../context.js';
import type { DiagnosticCheck } from '../../shared/types.js';
import { hostMatches, knownHostsName, parseKnownHosts } from '../inventory/ssh.js';
import { check, DOC, errText, installerCommand, mapLimit, ms, shq, skipped } from './util.js';

const G = 'inventory' as const;

export interface SshCheckOptions {
  config: Config;
  runner?: CommandRunner;
  /** the helper script shipped with this release (protocol and sha256 are compared with what the host runs) */
  helperScript?: string;
  installEnv?: string;
  stepTimeoutMs: number;
  /** dashboard base URL for the guest setup command */
  dashboardUrl?: string;
  /**
   * Only contact guests whose host key is already pinned (the doctor never learns keys: run as root, a first append
   * would create known_hosts owned by root and lock the service out of it).
   */
  pinnedGuestsOnly?: boolean;
}

function pinnedIn(knownHosts: string, t: SshTarget): boolean {
  try {
    const name = knownHostsName(t.address, t.port);
    return parseKnownHosts(readFileSync(knownHosts, 'utf8')).some((e) => !e.marker && hostMatches(e, name));
  } catch {
    return false;
  }
}

/** deploy/helpers/pve1-dash-helper next to this release: ../../deploy from server/diagnostics/*.ts and dist/server/*.js */
export function defaultHelperScript(fromUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(fromUrl)), '../../deploy/helpers/pve1-dash-helper');
}

export function shippedHelper(path: string): { protocol?: number; sha256?: string } {
  try {
    const text = readFileSync(path);
    const protocol = Number(/^readonly PROTOCOL=(\d+)/m.exec(text.toString('utf8'))?.[1]);
    return { ...(Number.isFinite(protocol) ? { protocol } : {}), sha256: createHash('sha256').update(text).digest('hex') };
  } catch {
    return {};
  }
}

const label = (t: SshTarget) => `${t.user}@${t.address}${t.port !== 22 ? `:${t.port}` : ''}`;

function keyFilesCheck(config: Config): DiagnosticCheck {
  const inv = config.inventory;
  const title = 'SSH key and host pin';
  const problems: string[] = [];
  const fixes: string[] = [];
  try {
    accessSync(inv.privateKey, constants.R_OK);
    const st = statSync(inv.privateKey);
    if (st.mode & 0o077) {
      problems.push(`${inv.privateKey} is readable by other users (mode ${(st.mode & 0o777).toString(8)})`);
      fixes.push(`chmod 0600 ${shq(inv.privateKey)}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    problems.push(code === 'ENOENT' ? `the private key ${inv.privateKey} does not exist` : `the private key ${inv.privateKey} is not readable by this user (${code ?? errText(err)})`);
    fixes.push(code === 'ENOENT' ? 'Re-run the installer on the Proxmox host (it creates the key and authorizes it).' : `chown pve1dash:pve1dash ${shq(inv.privateKey)} && chmod 0600 ${shq(inv.privateKey)}`);
  }
  if (inv.host) {
    let text: string | undefined;
    try {
      text = readFileSync(inv.knownHosts, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      problems.push(code === 'ENOENT' ? `${inv.knownHosts} does not exist, so the Proxmox host key is not pinned` : `${inv.knownHosts} is not readable (${code ?? errText(err)})`);
    }
    if (text !== undefined) {
      const name = knownHostsName(inv.host.address, inv.host.port);
      const pinned = parseKnownHosts(text).filter((e) => !e.marker && hostMatches(e, name));
      if (!pinned.length) problems.push(`${inv.knownHosts} has no key for ${name}: the dashboard refuses to connect to an unpinned Proxmox host`);
    }
    if (problems.length && !fixes.some((f) => f.includes('installer'))) {
      fixes.push(`# On the Proxmox host (re-pins the host key and re-authorizes the dashboard key):\n${installerCommand('', {})}`);
    }
  }
  if (problems.length) return check('ssh.keys', G, title, 'fail', problems.map((p) => `• ${p}`).join('\n'), { fix: fixes.join('\n'), docs: DOC.helper });
  return check('ssh.keys', G, title, 'ok', `Key ${inv.privateKey}${inv.host ? `; host key of ${inv.host.address} pinned in ${inv.knownHosts}` : ''}.`);
}

interface Interpreted {
  status: DiagnosticCheck['status'];
  detail: string;
  fix?: string;
}

/** Map a runner rejection (ssh.ts describeError texts) to an explanation and a fix. */
function sshFailure(err: unknown, t: SshTarget, o: SshCheckOptions, isHost: boolean): Interpreted {
  const msg = errText(err);
  const knownHosts = o.config.inventory.knownHosts;
  if (/HOST KEY MISMATCH/i.test(msg)) {
    const fp = /presented (\S+?),/.exec(msg)?.[1] ?? '<presented key>';
    return {
      status: 'fail',
      detail: `${msg}`,
      fix: isHost
        ? `# 1. On the Proxmox host, show its real key (it should be ${fp}):\nfor f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done\n# 2. If it matches (host reinstalled or keys regenerated), re-run the installer on the host; it re-pins the key:\n${installerCommand('', { installEnv: o.installEnv })}`
        : `# 1. On the guest, show its real key (it should be ${fp}):\nfor f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done\n# 2. If it matches, forget the old key in the dashboard container (it is learned again on the next connection):\nssh-keygen -R ${shq(t.port === 22 ? t.address : `[${t.address}]:${t.port}`)} -f ${shq(knownHosts)}`,
    };
  }
  if (/authentication failed/i.test(msg)) {
    return {
      status: 'fail',
      detail: `${label(t)} refused the dashboard's SSH key: it is not authorized there (or root login is off).`,
      fix: isHost
        ? `# On the Proxmox host: re-authorize the key for the helper, and check that sshd accepts key logins for root\n${installerCommand('--update-helper', { installEnv: o.installEnv })}\nsshd -T | grep -i permitrootlogin   # must be "prohibit-password", "forced-commands-only" or "yes"`
        : `# On the guest, as root:\ncurl -fsSL ${o.dashboardUrl ?? 'https://<dashboard>'}/setup/guest.sh | sh`,
    };
  }
  if (/not found at|Cannot parse privateKey|private key/i.test(msg)) {
    return { status: 'fail', detail: msg, fix: 'Re-run the installer on the Proxmox host; it recreates the key files in /etc/pve1-dash/ssh.' };
  }
  if (/refused|unreachable|timed out|resolve|reset/i.test(msg)) {
    return {
      status: 'fail',
      detail: `${msg}.`,
      fix: `# From the dashboard container:\nping -c 2 ${shq(t.address)}\n# On ${isHost ? 'the Proxmox host' : 'the guest'}:\nsystemctl status ssh --no-pager`,
    };
  }
  return { status: 'fail', detail: msg };
}

const SHELL_LIKE = /command not found|not found|No such file|syntax error|Permission denied|\$ $|# $/i;

function interpretHelper(r: CommandResult, t: SshTarget, o: SshCheckOptions, elapsed: number): Interpreted {
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  const shipped = shippedHelper(o.helperScript ?? defaultHelperScript());
  const update = installerCommand('--update-helper', { installEnv: o.installEnv });
  const m = /^pve1-dash-helper (\d+)\s*$/m.exec(out);
  if (r.code === 0 && m) {
    const protocol = Number(m[1]);
    const remoteSha = /^sha256 ([0-9a-f]{64})\s*$/m.exec(out)?.[1];
    if (shipped.protocol !== undefined && protocol < shipped.protocol) {
      return {
        status: 'warn',
        detail: `The host runs helper protocol ${protocol}; this release ships protocol ${shipped.protocol}. Newer data (kernel, package and guest-disk details) stays empty until it is updated.`,
        fix: `# On the Proxmox host:\n${update}`,
      };
    }
    if (remoteSha && shipped.sha256 && remoteSha !== shipped.sha256) {
      return { status: 'warn', detail: `The host helper (sha256 ${remoteSha.slice(0, 12)}…) differs from the one in this release (${shipped.sha256.slice(0, 12)}…).`, fix: `# On the Proxmox host:\n${update}` };
    }
    return { status: 'ok', detail: `pve1-dash-helper protocol ${protocol} answers on ${label(t)} (${ms(elapsed)}).` };
  }
  if (r.code === 1 && /^denied$/m.test(err)) {
    return {
      status: 'fail',
      detail: `The host helper on ${label(t)} answered "denied" to "version": it is an old or different script.`,
      fix: `# On the Proxmox host:\n${update}`,
    };
  }
  if (r.code === null) {
    return { status: 'fail', detail: `${label(t)}: the helper did not answer in time${err ? ` (${err.split('\n').pop()})` : ''}.`, fix: '# On the Proxmox host, run it by hand:\n/usr/local/sbin/pve1-dash-helper version' };
  }
  if (SHELL_LIKE.test(`${out}\n${err}`)) {
    return {
      status: 'fail',
      detail: `SECURITY: ${label(t)} ran "version" in a shell (${(err || out).split('\n')[0]}). The dashboard key is authorized WITHOUT the forced command, so it has a root shell on the host.`,
      fix: `# On the Proxmox host: the dashboard's line in /root/.ssh/authorized_keys must start with\n#   restrict,command="/usr/local/sbin/pve1-dash-helper"\ngrep -n pve1-dash /root/.ssh/authorized_keys\n# Re-run to rewrite it:\n${update}`,
    };
  }
  return {
    status: 'fail',
    detail: `Unexpected answer from ${label(t)} (exit ${r.code}): ${(out || err).slice(0, 200) || 'no output'}.`,
    fix: `# On the Proxmox host:\n/usr/local/sbin/pve1-dash-helper version\n${update}`,
  };
}

async function runVersion(runner: CommandRunner, t: SshTarget, timeoutMs: number): Promise<{ r?: CommandResult; err?: unknown; elapsed: number }> {
  const t0 = performance.now();
  try {
    const r = await runner.run(t, 'version', timeoutMs);
    return { r, elapsed: performance.now() - t0 };
  } catch (err) {
    return { err, elapsed: performance.now() - t0 };
  }
}

export async function sshChecks(o: SshCheckOptions): Promise<DiagnosticCheck[]> {
  const inv = o.config.inventory;
  if (!inv.enabled) {
    return [skipped('ssh.host', G, 'Host helper', 'The SSH inventory is off (inventory.enabled: false): no apps, VM addresses, temperatures or host updates.')];
  }
  const checks: DiagnosticCheck[] = [];
  if (!o.config.demo) checks.push(keyFilesCheck(o.config));
  const runner = o.runner;
  const timeoutMs = Math.min(o.stepTimeoutMs * 2, inv.timeoutMs);

  if (!inv.host) {
    checks.push(
      check('ssh.host', G, 'Host helper', 'warn', 'inventory.host is not set: no LXC apps, VM addresses, temperatures or host package updates.', {
        fix: 'Re-run the installer on the Proxmox host; it installs the helper and fills in inventory.host.',
      }),
    );
  } else if (!runner) {
    checks.push(skipped('ssh.host', G, 'Host helper', 'Not checked (no SSH runner).'));
  } else {
    const { r, err, elapsed } = await runVersion(runner, inv.host, timeoutMs);
    const res = r ? interpretHelper(r, inv.host, o, elapsed) : sshFailure(err, inv.host, o, true);
    checks.push(check('ssh.host', G, 'Host helper', res.status, res.detail, { ...(res.fix ? { fix: res.fix } : {}), docs: /HOST KEY MISMATCH/i.test(res.detail) ? DOC.hostKey : DOC.helper }));
  }

  if (inv.guests.length && runner) {
    const targets = o.pinnedGuestsOnly ? inv.guests.filter((g) => pinnedIn(inv.knownHosts, g)) : inv.guests;
    const unpinned = inv.guests.length - targets.length;
    const results = await mapLimit(targets, 4, async (g) => ({ g, ...(await runVersion(runner, g, timeoutMs)) }));
    const bad: string[] = [];
    const note = unpinned ? ` ${unpinned} not contacted yet (the service learns a guest's host key on first contact).` : '';
    let fix: string | undefined;
    for (const { g, r, err } of results) {
      if (r && r.code === 0 && /pve1-dash-guest-inventory|pve1-dash-helper|^\d+\s*$/m.test(r.stdout)) continue;
      const res = r
        ? { status: 'fail' as const, detail: r.code === 1 && /denied/.test(r.stderr) ? 'denied "version" (old guest helper)' : `exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`, fix: undefined }
        : sshFailure(err, g, o, false);
      bad.push(`VM ${g.vmid} (${label(g)}): ${res.detail}`);
      fix ??= res.fix ?? `# On VM ${g.vmid}, as root:\ncurl -fsSL ${o.dashboardUrl ?? 'https://<dashboard>'}/setup/guest.sh | sh`;
    }
    checks.push(
      bad.length
        ? check('ssh.guests', G, 'Direct SSH guests', 'warn', `${bad.length} of ${targets.length} guests did not answer (a stopped VM is expected to fail):\n${bad.map((b) => `• ${b}`).join('\n')}${note}`, {
            ...(fix ? { fix } : {}),
            docs: DOC.helper,
          })
        : check('ssh.guests', G, 'Direct SSH guests', 'ok', `${targets.length} of ${inv.guests.length} direct SSH guests answer.${note}`),
    );
  }
  return checks;
}
