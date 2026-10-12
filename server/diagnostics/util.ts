/**
 * Small helpers shared by the diagnostics checks: check builders, timeouts, shell quoting and the installer command
 * line that fixes refer to.
 */
import { readFileSync } from 'node:fs';
import type { DiagnosticCheck } from '../../shared/types.js';

export type Group = DiagnosticCheck['group'];

export const DOCS = 'docs/TROUBLESHOOTING.md';
/** GitHub anchors of the TROUBLESHOOTING.md sections the fixes point to (keep in sync with its headings). */
export const DOC = {
  first: `${DOCS}#-first-checks`,
  token: `${DOCS}#-token-401403`,
  tls: `${DOCS}#-tls-fingerprint-mismatch-after-a-certificate-renewal`,
  hostKey: `${DOCS}#-ssh-host-key-changed`,
  helper: `${DOCS}#-helper-denied-or-apps--services-stay-empty`,
  push: `${DOCS}#-push-notifications-dont-arrive-on-iphone`,
  sse: `${DOCS}#-live-updates-stop-or-never-start-sse-through-the-proxy`,
  host421: `${DOCS}#-unknown-host-http-421`,
  clock: `${DOCS}#-times-in-alerts-are-off-by-some-hours`,
} as const;
export const DEFAULT_INSTALL_ENV = '/etc/pve1-dash/install.env';
const DEFAULT_REPO = 'https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor';
const DEFAULT_REF = 'main';

export function check(
  id: string,
  group: Group,
  title: string,
  status: DiagnosticCheck['status'],
  detail: string,
  extra: { fix?: string; docs?: string } = {},
): DiagnosticCheck {
  const out: DiagnosticCheck = { id, group, title, status, detail };
  if (extra.fix && status !== 'ok') out.fix = extra.fix;
  if (extra.docs && status !== 'ok') out.docs = extra.docs;
  return out;
}

export const skipped = (id: string, group: Group, title: string, why: string): DiagnosticCheck => check(id, group, title, 'skip', why);

/** Resolve with the promise's value, or reject with `timeout after N s` (the work itself is not cancelled). */
export function withTimeout<T>(p: Promise<T>, ms: number, what = 'check'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what}: timeout after ${Math.round(ms / 100) / 10} s`), { code: 'ETIMEDOUT' })), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Single-quote for POSIX sh (values copied into fix commands). */
export function shq(s: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const errCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const c = e?.code ?? e?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};

export function ms(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10} s` : `${Math.round(n)} ms`;
}

export function bytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Days from now until `t` (negative when past), rounded down. */
export const daysUntil = (t: number, now: number): number => Math.floor((t - now) / 86_400_000);

/**
 * The installer one-liner for the source this container was installed from (read from install.env when present), e.g.
 * `bash -c "$(curl -fsSL https://raw.githubusercontent.com/o/r/main/deploy/install.sh)" -- --update-helper`.
 * Runs on the Proxmox HOST as root.
 */
export function installerCommand(args = '', opts: { installEnv?: string; env?: Record<string, string> } = {}): string {
  let repo = DEFAULT_REPO;
  let ref = DEFAULT_REF;
  try {
    const text = readFileSync(opts.installEnv ?? DEFAULT_INSTALL_ENV, 'utf8');
    repo = /^PVE1_DASH_REPO=(\S+)$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') || repo;
    ref = /^PVE1_DASH_REF=(\S+)$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') || ref;
  } catch {
    /* not installed by the installer (dev checkout): defaults */
  }
  const gh = /^(?:https:\/\/|git@)github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo)?.[1];
  const base = gh ? `https://raw.githubusercontent.com/${gh}/${ref}` : '<raw URL of your pve1-dash repository>';
  const envs = { ...(ref !== DEFAULT_REF ? { PVE1_DASH_REF: ref } : {}), ...(gh && repo !== DEFAULT_REPO ? { PVE1_DASH_REPO: repo } : {}), ...opts.env };
  const prefix = Object.entries(envs)
    .map(([k, v]) => `${k}=${shq(v)} `)
    .join('');
  return `${prefix}bash -c "$(curl -fsSL ${base}/deploy/install.sh)"${args ? ` -- ${args}` : ''}`;
}

/** Run async tasks with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
