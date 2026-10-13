/**
 * Pure parsers for the SSH helper protocol (docs/HELPER_PROTOCOL.md):
 *  - host framing  (`@@pve1-dash:` lines from /usr/local/sbin/pve1-dash-helper)
 *  - `qm guest exec` JSON unwrapping
 *  - inner guest script sections (`##pve1-dash:` lines): os-release, kernel, uptime, loadavg, init, services,
 *    docker, ip, listen, and since protocol v2 df, updates, reboot (v1 output parses without those fields)
 *  - `sensors -j` → TempReading[]
 *  - helper JSON output (pkgupdates, backups) behind a possibly noisy .bashrc
 *  - `hostinfo` key/value lines (protocol v2)
 *
 * No I/O here; everything is unit-tested against fixtures in tests/fixtures/inventory.
 */
import type {
  DockerContainer,
  DockerPort,
  GuestFilesystem,
  GuestInventory,
  GuestIp,
  ListeningPort,
  SystemService,
  TempReading,
} from '../../shared/types.js';
import type { CommandResult } from '../context.js';
import { isUnusableAddress, isVirtualInterface } from '../util/ipfilter.js';

export const HOST_PREFIX = '@@pve1-dash:';
export const INNER_PREFIX = '##pve1-dash:';
/** The inner script's first line, any protocol version (v1 and v2 both parse). */
const INNER_HEADER_RE = /^##pve1-dash:inventory v\d+\s*$/m;
export const hasInnerHeader = (text: string): boolean => INNER_HEADER_RE.test(text);

export type InventorySource = GuestInventory['source'];
export type HostTransport = 'pct-exec' | 'qm-guest-exec';

// ───────────────────────────────────────────────────────────── small helpers

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function splitLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

/** One printable line, safe to show in the UI. */
export function cleanMessage(text: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const s = stripAnsi(text).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Last non-empty line of some (stderr) text, cleaned; '' if none. */
export function lastLine(text: string): string {
  const lines = splitLines(text).filter((l) => l.trim() !== '');
  return lines.length ? cleanMessage(lines[lines.length - 1]!) : '';
}

/** Numbers from Proxmox / qemu-ga JSON can be numbers, numeric strings or booleans. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

/**
 * Errors that mean "cannot be inspected by design", not a fixable failure: a Windows guest, or a guest agent whose
 * guest-exec command is disabled (Home Assistant OS ships qemu-ga that way; QEMU words it "Command guest-exec has been
 * disabled" or "guest-exec is disabled").
 */
const UNSUPPORTED_RE = /unsupported os|\bwindows\b|guest-exec (?:has been |is )?disabled|disabled.{0,40}guest-exec/i;

export function inspectableFromError(error: string | undefined): NonNullable<GuestInventory['inspectable']> {
  return error && UNSUPPORTED_RE.test(error) ? 'unsupported' : 'yes';
}

/** An inventory that only carries an error (no data). */
export function failedInventory(vmid: number, source: InventorySource, collectedAt: number, error: string): GuestInventory {
  return {
    vmid,
    source,
    collectedAt,
    ok: false,
    error,
    ips: [],
    services: [],
    containers: [],
    ports: [],
    inspectable: inspectableFromError(error),
  };
}

// ───────────────────────────────────────────────────────────── JSON behind a noisy .bashrc

/**
 * Parse JSON printed by a helper command. sshd runs forced commands through root's shell, so a chatty .bashrc can print
 * lines before the JSON; those are skipped by retrying from each line that starts with `{` or `[`.
 */
export function extractJson(text: string): unknown {
  const whole = text.trim();
  if (!whole) return undefined;
  try {
    return JSON.parse(whole);
  } catch {
    /* fall through */
  }
  let offset = 0;
  let attempts = 0;
  for (const line of text.split('\n')) {
    const s = line.trimStart();
    if ((s.startsWith('{') || s.startsWith('[')) && attempts++ < 50) {
      try {
        return JSON.parse(text.slice(offset));
      } catch {
        /* try the next candidate line */
      }
    }
    offset += line.length + 1;
  }
  return undefined;
}

/** JSON array output (pkgupdates, backups), or null when the output is not a JSON array. */
export function parseJsonArray(text: string): unknown[] | null {
  const v = extractJson(text);
  return Array.isArray(v) ? v : null;
}

// ───────────────────────────────────────────────────────────── host framing

export interface HostBlock {
  vmid: number;
  guestType: 'lxc' | 'qemu';
  transport: HostTransport;
  /** exit code from the `end` line (absent when the block was cut off) */
  exitCode?: number;
  /** false when the output ended before `@@pve1-dash:end <vmid>` */
  terminated: boolean;
  payload: string[];
}

export interface HostFraming {
  version: number;
  /** `@@pve1-dash:done` was seen: the helper finished normally */
  done: boolean;
  blocks: HostBlock[];
}

const RE_HOST_HEADER = /^@@pve1-dash:inventory v(\d+)\s*$/;
const RE_HOST_GUEST = /^guest (\d{1,9}) (lxc|qemu) (pct-exec|qm-guest-exec)\s*$/;
const RE_HOST_END = /^end (\d{1,9}) (-?\d+)\s*$/;

/** Split host helper output into per-guest blocks. Returns null when the inventory header is missing. */
export function parseHostFraming(stdout: string): HostFraming | null {
  const lines = splitLines(stdout);
  // Everything before the header (e.g. .bashrc noise) is ignored.
  const start = lines.findIndex((l) => RE_HOST_HEADER.test(l));
  if (start < 0) return null;
  const version = Number(RE_HOST_HEADER.exec(lines[start]!)![1]);
  const blocks: HostBlock[] = [];
  let done = false;
  let cur: HostBlock | null = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith(HOST_PREFIX)) {
      cur?.payload.push(line);
      continue;
    }
    const rest = line.slice(HOST_PREFIX.length);
    let m: RegExpExecArray | null;
    if ((m = RE_HOST_GUEST.exec(rest))) {
      if (cur) blocks.push(cur); // previous block never ended
      cur = {
        vmid: Number(m[1]),
        guestType: m[2] as 'lxc' | 'qemu',
        transport: m[3] as HostTransport,
        terminated: false,
        payload: [],
      };
    } else if (cur && (m = RE_HOST_END.exec(rest)) && Number(m[1]) === cur.vmid) {
      cur.exitCode = Number(m[2]);
      cur.terminated = true;
      blocks.push(cur);
      cur = null;
    } else if (/^done\s*$/.test(rest)) {
      done = true;
      break;
    } else {
      // error lines (and anything unknown) stay in the payload of the open block
      cur?.payload.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return { version, done, blocks };
}

/** Convert one framed block to a GuestInventory. */
export function blockToInventory(b: HostBlock, collectedAt: number): GuestInventory {
  const source: InventorySource = b.transport;
  const isError = (l: string) => l.startsWith(`${HOST_PREFIX}error`);
  const errorText = (l: string) => cleanMessage(l.slice(`${HOST_PREFIX}error`.length));
  const first = b.payload.find((l) => l.trim() !== '');
  if (first && isError(first)) {
    return failedInventory(b.vmid, source, collectedAt, errorText(first) || 'unknown error');
  }
  if (!b.terminated) {
    return failedInventory(b.vmid, source, collectedAt, 'helper output was cut off before this guest finished');
  }
  if (b.transport === 'pct-exec') {
    // v2 helpers pass on a partial inner output followed by the reason it stopped (e.g. a probe ran into the limit)
    const stopped = b.payload.filter(isError).map(errorText).find(Boolean);
    const inv = parseInnerOutput(b.payload.filter((l) => !isError(l)).join('\n'), { vmid: b.vmid, source, collectedAt });
    if (stopped && inv.ok) inv.error = `partial inventory: ${stopped}`;
    return inv;
  }
  const payload = b.payload.join('\n');

  const unwrapped = unwrapGuestExec(payload);
  if (!unwrapped.ok) return failedInventory(b.vmid, source, collectedAt, unwrapped.error);
  const inv = parseInnerOutput(unwrapped.stdout, { vmid: b.vmid, source, collectedAt });
  if (unwrapped.truncated && inv.ok && !inv.error) inv.error = 'output truncated by the guest agent';
  return inv;
}

/**
 * Parse the full output of `pve1-dash-helper inventory [vmid]`.
 * Returns null when the output has no inventory header (helper missing, denied, wrong key, ...).
 */
export function parseHostInventory(
  stdout: string,
  collectedAt: number,
): { complete: boolean; inventories: GuestInventory[] } | null {
  const framing = parseHostFraming(stdout);
  if (!framing) return null;
  const byVmid = new Map<number, GuestInventory>();
  for (const b of framing.blocks) byVmid.set(b.vmid, blockToInventory(b, collectedAt));
  return { complete: framing.done, inventories: [...byVmid.values()] };
}

// ───────────────────────────────────────────────────────────── qm guest exec

export type GuestExecUnwrapped =
  | { ok: true; stdout: string; truncated: boolean; exitcode?: number }
  | { ok: false; error: string };

/**
 * Unwrap `qm guest exec` JSON: {"exitcode":0,"exited":1,"out-data":"…","err-data":"…","out-truncated":0}.
 * qm exits 0 even when the guest command failed, so `exitcode` decides. On qm's own timeout it prints {"pid":N}
 * (no `exited`). qemu-ga only includes out-data / out-truncated when stdout was non-empty.
 */
export function unwrapGuestExec(text: string): GuestExecUnwrapped {
  const json = extractJson(text);
  if (!isRecord(json)) return { ok: false, error: 'unreadable qm guest exec output' };
  const out = typeof json['out-data'] === 'string' ? json['out-data'] : '';
  const errData = typeof json['err-data'] === 'string' ? json['err-data'] : '';
  const truncated = num(json['out-truncated']) === 1;
  const exitcode = num(json.exitcode);
  const signal = num(json.signal);
  if (num(json.exited) !== 1) {
    return {
      ok: false,
      error: 'pid' in json ? 'guest command timed out (qm guest exec)' : 'guest command did not finish',
    };
  }
  // A killed or failing script may still have printed a usable (partial) inventory.
  if (hasInnerHeader(out)) return { ok: true, stdout: out, truncated, ...(exitcode !== undefined ? { exitcode } : {}) };
  if (signal !== undefined) return { ok: false, error: `guest command killed by signal ${signal}` };
  if (exitcode !== undefined && exitcode !== 0) {
    const why = lastLine(errData);
    return { ok: false, error: `guest command failed with exit code ${exitcode}${why ? `: ${why}` : ''}` };
  }
  return { ok: true, stdout: out, truncated, ...(exitcode !== undefined ? { exitcode } : {}) };
}

// ───────────────────────────────────────────────────────────── inner script output

export interface InnerSections {
  version: number;
  /** `##pve1-dash:end` was seen */
  complete: boolean;
  sections: Map<string, string[]>;
}

/** Split inner script output into sections. Returns null when the inner header is missing. */
export function splitInnerSections(text: string): InnerSections | null {
  const lines = splitLines(text);
  const start = lines.findIndex((l) => /^##pve1-dash:inventory v\d+\s*$/.test(l));
  if (start < 0) return null;
  const version = Number(/v(\d+)/.exec(lines[start]!)![1]);
  const sections = new Map<string, string[]>();
  let cur: string[] | null = null;
  let complete = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(INNER_PREFIX)) {
      const rest = line.slice(INNER_PREFIX.length).trim();
      const m = /^section ([A-Za-z0-9_-]+)$/.exec(rest);
      if (m) {
        cur = sections.get(m[1]!) ?? [];
        sections.set(m[1]!, cur);
        continue;
      }
      if (rest === 'end') {
        complete = true;
        break;
      }
    }
    cur?.push(line);
  }
  return { version, complete, sections };
}

export interface InnerParseOptions {
  vmid: number;
  source: InventorySource;
  collectedAt: number;
}

/** Parse the inner guest script's output (pct exec stdout, qm out-data, or the direct SSH helper's stdout). */
export function parseInnerOutput(text: string, opts: InnerParseOptions): GuestInventory {
  const { vmid, source, collectedAt } = opts;
  const parsed = splitInnerSections(text);
  if (!parsed) {
    const first = splitLines(text).find((l) => l.trim() !== '');
    return failedInventory(
      vmid,
      source,
      collectedAt,
      first ? `unexpected output from guest: ${cleanMessage(first, 120)}` : 'no inventory output from guest',
    );
  }
  const get = (name: string) => parsed.sections.get(name) ?? [];
  const inv: GuestInventory = {
    vmid,
    source,
    collectedAt,
    ok: true,
    ips: [],
    services: [],
    containers: [],
    ports: [],
    inspectable: 'yes',
  };

  const os = parseOsRelease(get('os-release'));
  if (os) inv.os = os;
  const kernel = firstLine(get('kernel'));
  if (kernel) inv.kernel = kernel;
  const uptime = parseUptime(get('uptime'));
  if (uptime !== undefined) inv.uptime = uptime;
  const load = parseLoadavg(get('loadavg'));
  if (load) inv.load = load;
  const init = firstLine(get('init'));
  if (init) inv.initSystem = init === 'systemd' || init === 'openrc' ? init : 'unknown';
  inv.services = parseServices(get('services'), inv.initSystem);

  if (parsed.sections.has('docker')) {
    const lines = get('docker');
    const idx = lines.findIndex((l) => l.trim() !== '');
    const flag = idx >= 0 ? lines[idx]!.trim() : '';
    if (flag === 'present' || flag === 'absent') inv.dockerPresent = flag === 'present';
    inv.containers = flag === 'present' ? parseDockerPs(lines.slice(idx + 1)) : [];
  }
  inv.ips = parseIpOutput(get('ip'));
  inv.ports = parseListenOutput(get('listen'));
  // protocol v2 sections: absent (older helper, or cut off before them) leaves the field unset = "unknown"
  if (parsed.sections.has('df')) inv.filesystems = parseDf(get('df'));
  if (parsed.sections.has('updates')) {
    const updates = parseUpdates(get('updates'));
    if (updates) inv.updates = updates;
  }
  if (parsed.sections.has('reboot')) inv.rebootRequired = parseReboot(get('reboot'), inv.kernel);
  if (!parsed.complete) inv.error = 'inventory output was truncated';
  return inv;
}

/**
 * Turn the result of `ssh <guest> inventory` (direct SSH to pve1-dash-guest-inventory) into a GuestInventory.
 * The guest helper prints the inner output directly, without host framing.
 */
export function inventoryFromSshResult(result: CommandResult, vmid: number, collectedAt: number): GuestInventory {
  if (hasInnerHeader(result.stdout)) {
    const inv = parseInnerOutput(result.stdout, { vmid, source: 'ssh', collectedAt });
    if (result.code === null && inv.ok && !inv.error) inv.error = 'ssh timeout (partial inventory)';
    return inv;
  }
  const why = lastLine(result.stderr);
  let error: string;
  if (result.code === null) error = why && !/timed out/i.test(why) ? `ssh timeout: ${why}` : 'ssh timeout';
  else if (result.code === 1 && /^denied$/m.test(result.stderr)) {
    error = 'guest helper denied the request (outdated pve1-dash-guest-inventory?)';
  } else if (result.code === 127) error = `guest helper not installed (${why || 'command not found'})`;
  else if (result.code !== 0) error = `guest helper failed with exit code ${result.code}${why ? `: ${why}` : ''}`;
  else error = 'no inventory output from guest';
  return failedInventory(vmid, 'ssh', collectedAt, error);
}

function firstLine(lines: string[]): string | undefined {
  const l = lines.find((x) => x.trim() !== '');
  return l === undefined ? undefined : l.trim();
}

// ── os-release

/** Unquote an os-release value (shell-like: "double" with backslash escapes, 'single', or bare). */
function unquoteOsReleaseValue(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      const c = v[i]!;
      if (c === '\\' && i + 1 < v.length) {
        out += v[++i];
        continue;
      }
      if (c === '"') break;
      out += c;
    }
    return out;
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return v.slice(1, end < 0 ? undefined : end);
  }
  return v.replace(/\\(.)/g, '$1');
}

export function parseOsRelease(lines: string[]): GuestInventory['os'] | undefined {
  const kv: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) kv[m[1]!] = unquoteOsReleaseValue(m[2]!);
  }
  const os: NonNullable<GuestInventory['os']> = {};
  if (kv.ID) os.id = kv.ID;
  if (kv.NAME) os.name = kv.NAME;
  if (kv.PRETTY_NAME) os.prettyName = kv.PRETTY_NAME;
  const version = kv.VERSION || kv.VERSION_ID;
  if (version) os.version = version;
  return Object.keys(os).length ? os : undefined;
}

// ── uptime / loadavg

/** /proc/uptime "1234.56 4321.00" → whole seconds */
export function parseUptime(lines: string[]): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)/.exec(lines.find((l) => l.trim() !== '') ?? '');
  return m ? Math.floor(Number(m[1])) : undefined;
}

/** /proc/loadavg "0.08 0.12 0.10 1/234 5678" → [0.08, 0.12, 0.10] */
export function parseLoadavg(lines: string[]): [number, number, number] | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/.exec(lines.find((l) => l.trim() !== '') ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

// ── services

/** OS plumbing, hidden by default in the UI (docs/HELPER_PROTOCOL.md "Parser notes"). `*` = prefix match. */
const SYSTEM_SERVICE_PATTERNS = [
  'systemd-*', 'dbus*', 'getty@*', 'serial-getty@*', 'cron', 'crond', 'ssh', 'sshd', 'rsyslog', 'polkit', 'user@*',
  'unattended-upgrades', 'networkd-dispatcher', 'postfix*', 'chrony*', 'qemu-guest-agent', 'console-getty',
  'container-getty@*', 'ifupdown*', 'networking', 'rpcbind', 'apparmor', 'udisks2', 'ModemManager', 'multipathd',
  'snapd*', 'fwupd', 'irqbalance', 'atd', 'lvm2-*', 'packagekit', 'accounts-daemon', 'upower', 'thermald',
  'wpa_supplicant', 'NetworkManager*', 'avahi-daemon', 'cups*', 'exim4',
];
/**
 * OpenRC boot plumbing (Alpine & co.). The protocol list above is written for systemd, where these are oneshot units
 * that never show up as "running"; under OpenRC they are listed as "started".
 */
const OPENRC_PLUMBING_PATTERNS = [
  'bootmisc', 'hostname', 'hwclock', 'osclock', 'modules', 'modloop', 'sysctl', 'urandom', 'seedrng', 'devfs', 'dmesg',
  'mdev', 'hwdrivers', 'udev*', 'localmount', 'loopback', 'killprocs', 'savecache', 'mount-ro', 'local', 'machine-id',
  'swap', 'sysfs', 'procfs', 'cgroups', 'termencoding', 'keymaps', 'save-keymaps', 'save-termencoding', 'consolefont',
  'fsck', 'root', 'syslog', 'klogd', 'acpid', 'net.*', 'staticroute', 'binfmt', 'firstboot', 'mtab', 'agetty*',
];

function globToRegExp(patterns: string[]): RegExp {
  const parts = patterns.map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'));
  return new RegExp(`^(?:${parts.join('|')})$`);
}
const SYSTEM_SERVICE_RE = globToRegExp(SYSTEM_SERVICE_PATTERNS);
const OPENRC_PLUMBING_RE = globToRegExp(OPENRC_PLUMBING_PATTERNS);

export function isSystemService(unit: string, initSystem?: string): boolean {
  return SYSTEM_SERVICE_RE.test(unit) || (initSystem === 'openrc' && OPENRC_PLUMBING_RE.test(unit));
}

/** `systemctl list-units --type=service --state=running --no-legend --no-pager --plain` */
export function parseSystemdUnits(lines: string[]): SystemService[] {
  const out: SystemService[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    // UNIT LOAD ACTIVE SUB DESCRIPTION (failed units may carry a leading bullet on some versions)
    const m = /^\s*(?:[●*×]\s+)?(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*?))?\s*$/.exec(stripAnsi(raw));
    if (!m) continue;
    const unit = m[1]!.slice(0, -'.service'.length);
    if (!unit || seen.has(unit)) continue;
    seen.add(unit);
    const svc: SystemService = { unit, sub: m[4]!, system: isSystemService(unit, 'systemd') };
    if (m[5]) svc.description = m[5];
    out.push(svc);
  }
  return out;
}

/** `rc-status --servicelist` lines: " sshd   [  started  ]" (supervised: "[  started 2 day(s) 03:21:45 (0)  ]"). */
export function parseOpenrcServices(lines: string[]): SystemService[] {
  const out: SystemService[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const m = /^\s*([^\s[\]]+)\s+\[\s*([A-Za-z]+)[^\]]*\]\s*$/.exec(stripAnsi(raw));
    if (!m) continue;
    const unit = m[1]!;
    // Only running services, matching the systemd listing (--state=running).
    if (m[2]!.toLowerCase() !== 'started' || seen.has(unit)) continue;
    seen.add(unit);
    out.push({ unit, sub: 'running', system: isSystemService(unit, 'openrc') });
  }
  return out;
}

export function parseServices(lines: string[], initSystem?: string): SystemService[] {
  if (initSystem === 'systemd') return parseSystemdUnits(lines);
  if (initSystem === 'openrc') return parseOpenrcServices(lines);
  if (lines.some((l) => /\.service\s/.test(l))) return parseSystemdUnits(lines);
  if (lines.some((l) => /\[\s*[A-Za-z]+[^\]]*\]\s*$/.test(l))) return parseOpenrcServices(lines);
  return [];
}

// ── docker

/** Health from Status, e.g. "Up 3 days (healthy)", "Up 5 seconds (health: starting)". */
export function dockerHealth(status: string): DockerContainer['health'] {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status);
  if (!m) return undefined;
  return m[1] === 'health: starting' ? 'starting' : (m[1] as 'healthy' | 'unhealthy');
}

/** Older docker CLIs have no `State` field in `{{json .}}`; derive it from Status. */
function dockerStateFromStatus(status: string): string {
  const s = status.trim();
  if (/^Up\b/i.test(s)) return /\(Paused\)/i.test(s) ? 'paused' : 'running';
  if (/^Exited\b/i.test(s)) return 'exited';
  if (/^Restarting\b/i.test(s)) return 'restarting';
  if (/^Created\b/i.test(s)) return 'created';
  if (/^Dead\b/i.test(s)) return 'dead';
  if (/^Removal\b/i.test(s)) return 'removing';
  return 'unknown';
}

function labelValue(labels: unknown, key: string): string | undefined {
  if (isRecord(labels)) {
    const v = labels[key];
    return typeof v === 'string' && v ? v : undefined;
  }
  if (typeof labels !== 'string') return undefined;
  // `k=v,k=v`: other label values may contain commas, so look the key up instead of splitting.
  const m = new RegExp(`(?:^|,)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^,]*)`).exec(labels);
  return m?.[1] || undefined;
}

const MAX_RANGE_EXPANSION = 100;

/**
 * Docker `Ports`: "0.0.0.0:8096->8096/tcp, [::]:8096->8096/tcp, 6767/tcp", ":::53->53/udp",
 * "0.0.0.0:8000-8002->8000-8002/tcp". IPv4/IPv6 duplicates of the same host port are merged (first one wins).
 */
export function parseDockerPorts(ports: string): DockerPort[] {
  const out: DockerPort[] = [];
  const seen = new Set<string>();
  const push = (p: DockerPort) => {
    const key = `${p.hostPort ?? ''}/${p.containerPort}/${p.proto}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  for (const part of ports.split(',').map((s) => s.trim()).filter(Boolean)) {
    const pm = /^(?:(.*)->)?(\d+)(?:-(\d+))?\/(tcp|udp|sctp)$/.exec(part);
    if (!pm) continue;
    const proto = pm[4];
    if (proto !== 'tcp' && proto !== 'udp') continue;
    const cStart = Number(pm[2]);
    const cEnd = pm[3] ? Number(pm[3]) : cStart;
    if (!pm[1]) {
      // exposed but not published
      const n = cEnd - cStart;
      for (let i = 0; i <= (n <= MAX_RANGE_EXPANSION ? n : 0); i++) push({ containerPort: cStart + i, proto });
      continue;
    }
    // published: "<hostIp>:<hostPort>[-<end>]" where hostIp may be "0.0.0.0", "[::]" or "::" (":::53")
    const pub = pm[1];
    const colon = pub.lastIndexOf(':');
    const hostIpRaw = colon >= 0 ? pub.slice(0, colon) : '';
    const hm = /^(\d+)(?:-(\d+))?$/.exec(colon >= 0 ? pub.slice(colon + 1) : pub);
    if (!hm) continue;
    const hStart = Number(hm[1]);
    const hEnd = hm[2] ? Number(hm[2]) : hStart;
    const hostIp = hostIpRaw.replace(/^\[(.*)\]$/, '$1');
    const n = Math.min(hEnd - hStart, cEnd - cStart);
    for (let i = 0; i <= (n >= 0 && n <= MAX_RANGE_EXPANSION ? n : 0); i++) {
      push({ ...(hostIp ? { hostIp } : {}), hostPort: hStart + i, containerPort: cStart + i, proto });
    }
  }
  return out;
}

/** `docker ps -a --no-trunc --format '{{json .}}'`: one JSON object per line. */
export function parseDockerPs(lines: string[]): DockerContainer[] {
  const out: DockerContainer[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(j)) continue;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const id = str(j.ID) ?? '';
    const names = Array.isArray(j.Names) ? j.Names.map(String) : (str(j.Names) ?? '').split(',');
    const name = names.map((n) => n.trim().replace(/^\//, '')).find(Boolean) ?? id.slice(0, 12);
    if (!name) continue;
    const status = str(j.Status) ?? '';
    const c: DockerContainer = {
      id: id.slice(0, 12),
      name,
      image: str(j.Image) ?? '',
      state: (str(j.State) || dockerStateFromStatus(status)).toLowerCase(),
      status,
      ports: typeof j.Ports === 'string' ? parseDockerPorts(j.Ports) : [],
    };
    const health = dockerHealth(status);
    if (health) c.health = health;
    const project = labelValue(j.Labels, 'com.docker.compose.project');
    if (project) c.composeProject = project;
    const service = labelValue(j.Labels, 'com.docker.compose.service');
    if (service) c.composeService = service;
    if (str(j.RunningFor)) c.runningFor = str(j.RunningFor);
    if (str(j.CreatedAt)) c.createdAt = str(j.CreatedAt);
    out.push(c);
  }
  return out;
}

// ── ip addresses

/**
 * Loopback, container/VM bridges and overlay interfaces (docker, libvirt, k3s/flannel/calico, podman, LXD/Incus,
 * Home Assistant's hassio, ...) never carry the guest's LAN address; one shared list (server/util/ipfilter.ts) so the
 * guest agent path agrees. VPN interfaces (tailscale, wg, zt) are kept, as is the Tailscale CGNAT range.
 */
function keepAddress(iface: string | undefined, address: string): boolean {
  return !isVirtualInterface(iface) && !isUnusableAddress(address);
}

function maskToPrefix(mask: string): number | undefined {
  let bits: number;
  if (/^0x[0-9a-f]{8}$/i.test(mask)) bits = parseInt(mask, 16);
  else {
    const o = mask.split('.').map(Number);
    if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return undefined;
    bits = ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
  }
  let prefix = 0;
  while (prefix < 32 && bits & (0x80000000 >>> prefix)) prefix++;
  return prefix;
}

/** `ip -o addr show`: "2: eth0    inet 10.10.20.31/24 brd ... scope global eth0\       valid_lft ..." */
export function parseIpAddrOneline(lines: string[]): GuestIp[] {
  const out: GuestIp[] = [];
  for (const line of lines) {
    const m = /^\d+:\s+([^\s@]+)(?:@\S+)?\s+(inet6?)\s+([0-9A-Fa-f:.]+)(?:\/(\d{1,3}))?/.exec(line);
    if (!m) continue;
    const family = m[2] === 'inet6' ? 6 : 4;
    const ip: GuestIp = { iface: m[1]!, address: m[3]!, family, source: 'inventory' };
    if (m[4]) ip.prefix = Number(m[4]);
    out.push(ip);
  }
  return out;
}

/** net-tools / busybox `ifconfig` (both the "inet addr:" and the "inet … netmask" styles). */
export function parseIfconfig(lines: string[]): GuestIp[] {
  const out: GuestIp[] = [];
  let iface: string | undefined;
  for (const line of lines) {
    if (/^\S/.test(line)) iface = line.split(/\s+/)[0]!.replace(/:$/, '');
    let m: RegExpExecArray | null;
    if ((m = /\binet addr:\s*([\d.]+)(?:.*?\bMask:\s*([\d.]+))?/.exec(line))) {
      const ip: GuestIp = { address: m[1]!, family: 4, source: 'inventory', ...(iface ? { iface } : {}) };
      const p = m[2] ? maskToPrefix(m[2]) : undefined;
      if (p !== undefined) ip.prefix = p;
      out.push(ip);
    } else if ((m = /\binet\s+([\d.]+)(?:.*?\bnetmask\s+(\S+))?/.exec(line))) {
      const ip: GuestIp = { address: m[1]!, family: 4, source: 'inventory', ...(iface ? { iface } : {}) };
      const p = m[2] ? maskToPrefix(m[2]) : undefined;
      if (p !== undefined) ip.prefix = p;
      out.push(ip);
    } else if ((m = /\binet6(?: addr:)?\s+([0-9A-Fa-f:]+)(?:%\S+)?(?:\/(\d{1,3}))?(?:.*?\bprefixlen\s+(\d{1,3}))?/.exec(line))) {
      const ip: GuestIp = { address: m[1]!, family: 6, source: 'inventory', ...(iface ? { iface } : {}) };
      const p = m[2] ?? m[3];
      if (p) ip.prefix = Number(p);
      out.push(ip);
    }
  }
  return out;
}

/** The `ip` section: `ip -o addr show`, or the ifconfig fallback. Filtered and de-duplicated. */
export function parseIpOutput(lines: string[]): GuestIp[] {
  const oneline = lines.some((l) => /^\d+:\s+\S+\s+inet6?\s/.test(l));
  const all = oneline ? parseIpAddrOneline(lines) : parseIfconfig(lines);
  const seen = new Set<string>();
  return all.filter((ip) => {
    if (!keepAddress(ip.iface, ip.address) || seen.has(ip.address)) return false;
    seen.add(ip.address);
    return true;
  });
}

// ── listening ports

/** "0.0.0.0:22", "[::]:22", "*:53", "127.0.0.53%lo:53", ":::22" (netstat), "[fe80::1%eth0]:53" */
function splitHostPort(s: string): { address: string; port: number } | null {
  const i = s.lastIndexOf(':');
  if (i < 0) return null;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let address = s.slice(0, i).replace(/^\[(.*)\]$/, '$1');
  address = address.replace(/%.*$/, '');
  return { address: address || '*', port };
}

/** The `listen` section: `ss -Hltnp` (or with header) or `netstat -ltnp` / `netstat -ltn`. De-duplicated by port+process. */
export function parseListenOutput(lines: string[]): ListeningPort[] {
  const out: ListeningPort[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    if (!t[0] || /^(State|Netid|Active|Proto)$/i.test(t[0])) continue;
    let proto: 'tcp' | 'udp';
    let local: string | undefined;
    let procText = '';
    let process: string | undefined;
    let pid: number | undefined;
    if (t[0] === 'LISTEN' || ((t[0] === 'tcp' || t[0] === 'udp') && t[1] === 'LISTEN')) {
      // ss: [Netid] State Recv-Q Send-Q Local:Port Peer:Port [Process]
      const o = t[0] === 'LISTEN' ? 0 : 1;
      proto = t[0] === 'udp' ? 'udp' : 'tcp';
      local = t[o + 3];
      procText = t.slice(o + 5).join(' ');
      const pm = /\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(procText);
      if (pm) {
        process = pm[1];
        pid = Number(pm[2]);
      }
    } else if (/^(tcp|udp)6?$/.test(t[0])) {
      // netstat: Proto Recv-Q Send-Q Local Foreign State [PID/Program name]
      if (t[0].startsWith('tcp') && t[5] !== 'LISTEN') continue;
      proto = t[0].startsWith('udp') ? 'udp' : 'tcp';
      local = t[3];
      procText = t.slice(proto === 'tcp' ? 6 : 5).join(' ');
      const pm = /^(\d+)\/(.+)$/.exec(procText);
      if (pm) {
        pid = Number(pm[1]);
        process = pm[2]!.split(/[:\s]/)[0] || undefined;
      }
    } else continue;
    const hp = local ? splitHostPort(local) : null;
    if (!hp) continue;
    const key = `${proto}/${hp.port}/${process ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lp: ListeningPort = { proto, address: hp.address, port: hp.port };
    if (process) lp.process = process;
    if (pid !== undefined) lp.pid = pid;
    out.push(lp);
  }
  return out.sort((a, b) => a.port - b.port || a.address.localeCompare(b.address));
}

// ── df (protocol v2)

/** Filesystem types that never hold user data (or only mirror another mount). `fuse.*` is matched separately. */
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'overlay', 'overlayfs', 'squashfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'nsfs', 'devpts',
  'mqueue', 'hugetlbfs', 'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'efivarfs', 'autofs',
  'binfmt_misc', 'ramfs', 'rpc_pipefs', 'fusectl', 'iso9660', 'udf', 'devfs', 'shm', 'none', 'aufs', 'lxcfs', 'zram',
]);
/** Device names df prints for pseudo filesystems when it was run without -T (old busybox). */
const PSEUDO_DEVICE_RE = /^(?:tmpfs|devtmpfs|overlay|shm|udev|none|lxcfs|cgroup2?|proc|sysfs|\/dev\/loop\d+)$/;
/** Runtime trees: whatever is mounted there belongs to the system, not to the guest's data. */
const PSEUDO_MOUNT_RE = /^\/(?:proc|sys|dev|run|snap)(?:\/|$)/;
/**
 * Container-engine trees, skipped only when df printed no types (their overlay/tmpfs/shm mounts are dropped by type
 * otherwise, and a real disk mounted at /var/lib/docker is exactly what fills up).
 */
const ENGINE_MOUNT_RE = /^\/var\/lib\/(?:docker|containers|kubelet|lxcfs)\//;
const MAX_FILESYSTEMS = 40;

/**
 * The `df` section: `df -P -T -k [-l]` ("Filesystem Type 1024-blocks Used Available Capacity Mounted on") or
 * `df -P -k` (no Type column). Pseudo filesystems, runtime mounts and empty ones are dropped, bind mounts of the same
 * filesystem are listed once. Sizes in bytes.
 */
export function parseDf(lines: string[]): GuestFilesystem[] {
  const header = lines.findIndex((l) => /^Filesystem\s/.test(l));
  if (header < 0) return [];
  const hasType = /^Filesystem\s+Type\s/.test(lines[header]!);
  const out: GuestFilesystem[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(header + 1)) {
    const t = line.trim().split(/\s+/);
    // blocks, used, available, capacity: the first run of three integers and a percentage (devices with spaces)
    let i = hasType ? 2 : 1;
    for (; i + 4 < t.length; i++) {
      if (isUint(t[i]) && isUint(t[i + 1]) && isUint(t[i + 2]) && /^(?:\d+%|-)$/.test(t[i + 3]!)) break;
    }
    if (i + 4 >= t.length) continue;
    const mount = t.slice(i + 4).join(' ');
    if (!mount.startsWith('/')) continue;
    const device = t.slice(0, hasType ? i - 1 : i).join(' ');
    const fstype = hasType ? t[i - 1] : undefined;
    const size = Number(t[i]) * 1024;
    const used = Number(t[i + 1]) * 1024;
    const avail = Number(t[i + 2]) * 1024;
    if (!(size > 0)) continue;
    if (fstype && (PSEUDO_FS.has(fstype.toLowerCase()) || /^fuse\./i.test(fstype))) continue;
    if (!fstype && (PSEUDO_DEVICE_RE.test(device) || ENGINE_MOUNT_RE.test(mount))) continue;
    if (PSEUDO_MOUNT_RE.test(mount)) continue;
    const key = `${device}\0${size}\0${used}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fs: GuestFilesystem = { mount, size, used, avail };
    if (fstype) fs.fstype = fstype;
    if (device) fs.device = device;
    out.push(fs);
    if (out.length >= MAX_FILESYSTEMS) break;
  }
  return out;
}

function isUint(s: string | undefined): boolean {
  return s !== undefined && /^\d{1,18}$/.test(s);
}

// ── updates (protocol v2)

/** Epoch seconds that can be a real file time (2000-01-01 … 2100-01-01). */
const plausibleEpoch = (v: number) => Number.isInteger(v) && v > 946_684_800 && v < 4_102_444_800;

/** The `updates` section: "manager apt", "count 12", "security 3", "stamp <epoch>"…; undefined without a manager. */
export function parseUpdates(lines: string[]): GuestInventory['updates'] | undefined {
  let manager: string | undefined;
  let count: number | undefined;
  let security: number | undefined;
  let stamp: number | undefined;
  for (const raw of lines) {
    const m = /^(manager|count|security|stamp)\s+(\S+)\s*$/.exec(raw.trim());
    if (!m) continue;
    const v = m[2]!;
    if (m[1] === 'manager') {
      if (/^[a-z][a-z0-9-]{0,15}$/.test(v)) manager = v;
    } else if (/^\d{1,12}$/.test(v)) {
      const n = Number(v);
      if (m[1] === 'count') count = n;
      else if (m[1] === 'security') security = n;
      else if (plausibleEpoch(n)) stamp = Math.max(stamp ?? 0, n);
    }
  }
  if (!manager || count === undefined) return undefined;
  const out: NonNullable<GuestInventory['updates']> = { count, manager };
  if (security !== undefined) out.security = Math.min(security, count);
  if (stamp !== undefined) out.checkedAt = stamp * 1000;
  return out;
}

// ── kernels and reboot (protocol v2)

/** Natural version order: "6.8.12-10-pve" > "6.8.12-9-pve" > "6.8.4-2-pve". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x === y) continue;
    if (i % 2 === 1 && x !== '' && y !== '') return Number(x) - Number(y) || x.length - y.length;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** "6.1.0-27-amd64" → "amd64", "6.8.12-4-pve" → "pve", "6.10.6-200.fc40.x86_64" → "fc40.x86_64". */
export function kernelFlavor(version: string): string {
  return version.replace(/^[\d.\-_+~]+/, '');
}

/** A kernel version (as in /boot/vmlinuz-<version>) the same kind as `running`, e.g. not "0-rescue-…" or "lts". */
function sameKindKernel(v: string, running: string): boolean {
  return /^\d/.test(v) && !/rescue/i.test(v) && kernelFlavor(v) === kernelFlavor(running);
}

/** Newest of `installed` that is the same kind as `running` (or the newest of all without a running version). */
export function newestKernel(installed: Iterable<string>, running?: string): string | undefined {
  let best: string | undefined;
  for (const v of installed) {
    if (running ? !sameKindKernel(v, running) : !/^\d/.test(v)) continue;
    if (best === undefined || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/**
 * The `reboot` section: "flag <source>" (reboot-required file, NixOS, needs-restarting), "modules-missing" (the
 * running kernel's modules were removed by an upgrade), "container", and "vmlinuz <version>" lines. A newer installed
 * kernel of the same flavour than the running one also means a reboot is due; that check needs the running kernel to
 * be among the installed ones, which proves /boot belongs to this system (never true in a container).
 */
export function parseReboot(lines: string[], runningKernel: string | undefined): boolean {
  const installed: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (/^flag(?:\s|$)/.test(l) || l === 'modules-missing') return true;
    const m = /^vmlinuz\s+(\S+)$/.exec(l);
    if (m) installed.push(m[1]!);
  }
  if (!runningKernel || !installed.includes(runningKernel)) return false;
  const newest = newestKernel(installed, runningKernel);
  return newest !== undefined && compareVersions(newest, runningKernel) > 0;
}

// ── hostinfo (host helper, protocol v2)

export interface HostInfo {
  runningKernel?: string;
  /** the kernel the next boot uses: a proxmox-boot-tool pin if set, else the newest installed Proxmox kernel */
  newestKernel?: string;
  /** epoch ms: when the apt package lists were last refreshed (pkgupdates file time when the lists are unknown) */
  updatesCheckedAt?: number;
}

const KERNEL_PACKAGE_RE = /^(?:proxmox|pve)-kernel-(\d+\.\d+\.\d+-\d+-pve)(?:-signed)?$/;

/** Output of `pve1-dash-helper hostinfo`: "running …", "vmlinuz …", "package …", "pin …", "stamp-lists …"… */
export function parseHostInfo(text: string): HostInfo | null {
  let running: string | undefined;
  let pin: string | undefined;
  let nextPin: string | undefined;
  let lists: number | undefined;
  let pkgupdates: number | undefined;
  const installed = new Set<string>();
  let recognized = false;
  for (const raw of splitLines(text)) {
    const m = /^(running|vmlinuz|package|pin|next-boot-pin|stamp-lists|stamp-pkgupdates)\s+([A-Za-z0-9._+~-]{1,100})\s*$/.exec(raw.trim());
    if (!m) continue;
    recognized = true;
    const v = m[2]!;
    switch (m[1]) {
      case 'running':
        running = v;
        break;
      case 'vmlinuz':
        installed.add(v);
        break;
      case 'package': {
        const k = KERNEL_PACKAGE_RE.exec(v);
        if (k) installed.add(k[1]!);
        break;
      }
      case 'pin':
        pin = v;
        break;
      case 'next-boot-pin':
        nextPin = v;
        break;
      case 'stamp-lists':
        if (plausibleEpoch(Number(v))) lists = Math.max(lists ?? 0, Number(v));
        break;
      case 'stamp-pkgupdates':
        if (plausibleEpoch(Number(v))) pkgupdates = Number(v);
        break;
    }
  }
  if (!recognized) return null;
  const out: HostInfo = {};
  if (running) out.runningKernel = running;
  if (running) installed.add(running);
  const next = nextPin ?? pin ?? newestKernel(installed, running);
  if (next) out.newestKernel = next;
  const stamp = lists ?? pkgupdates;
  if (stamp !== undefined) out.updatesCheckedAt = stamp * 1000;
  return out;
}

// ───────────────────────────────────────────────────────────── sensors -j

const CPU_CHIPS = new Set(['k10temp', 'k8temp', 'coretemp', 'zenpower', 'via_cputemp', 'cpu_thermal', 'soc_thermal']);
const DISK_CHIPS = new Set(['nvme', 'drivetemp']);
const CPU_LABEL_RE = /^(?:Tctl|Tdie|Tccd\d+|Package id \d+|Core \d+)$/;

/** cpu / disk / other by chip family ("k10temp-pci-00c3" → "k10temp") and well-known CPU labels. */
export function classifyTemp(chip: string, label: string): TempReading['kind'] {
  const family = chip.split('-')[0]!.toLowerCase();
  if (CPU_CHIPS.has(family)) return 'cpu';
  if (DISK_CHIPS.has(family)) return 'disk';
  if (CPU_LABEL_RE.test(label)) return 'cpu';
  return 'other';
}

// Drivers report sentinels for absent inputs/limits (-273.15, 65261.85, 0, ±127/128); keep only plausible values.
const plausibleTemp = (v: number | undefined): v is number => v !== undefined && v > 0 && v < 127;
const plausibleLimit = (v: number | undefined): v is number => v !== undefined && v > 0 && v < 200;

/**
 * `sensors -j`: { "<chip>": { "Adapter": "...", "<label>": { "temp1_input": 45.0, "temp1_max": 80.0, ... }, ... } }.
 * Only temperature inputs are kept (fans `fanN_*`, voltages `inN_*`, power etc. are ignored).
 */
export function parseSensors(json: unknown): TempReading[] {
  const out: TempReading[] = [];
  if (!isRecord(json)) return out;
  for (const [chip, features] of Object.entries(json)) {
    if (!isRecord(features)) continue;
    for (const [label, sub] of Object.entries(features)) {
      if (label === 'Adapter' || !isRecord(sub)) continue;
      const inputKey = Object.keys(sub).find((k) => /^temp\d+_input$/.test(k));
      if (!inputKey) continue;
      const celsius = num(sub[inputKey]);
      if (!plausibleTemp(celsius)) continue;
      const base = inputKey.slice(0, -'_input'.length);
      const r: TempReading = { label, source: chip, celsius, kind: classifyTemp(chip, label) };
      const high = num(sub[`${base}_max`]);
      if (plausibleLimit(high)) r.highC = high;
      const crit = num(sub[`${base}_crit`]);
      if (plausibleLimit(crit)) r.critC = crit;
      out.push(r);
    }
  }
  return out;
}
