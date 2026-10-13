/**
 * Pure mapping for host-level endpoints: network config, package updates, /version, subscription,
 * certificates and host services (docs/research/pve-api-node.md §1, §7-§11).
 */
import type { HostService, NetworkInterface, NodeSummary, PackageUpdate } from '../../shared/types.js';
import { bool, isRecord, num, records, secToMs, splitSpace, str } from './parse.js';

/**
 * GET /nodes/{node}/network. `active` is ABSENT (not 0) when the link is down; `lo` is already removed by PVE.
 * `netmask` is a prefix-length string; `cidr` is used instead. Sorted by the file order (`priority`).
 */
export function mapNetwork(raw: unknown): NetworkInterface[] {
  const rows = records(raw).filter((r) => str(r.iface));
  return rows
    .map((r) => ({ r, prio: num(r.priority) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.prio - b.prio || str(a.r.iface)!.localeCompare(str(b.r.iface)!, undefined, { numeric: true }))
    .map(({ r }): NetworkInterface => {
      const n: NetworkInterface = {
        iface: str(r.iface)!,
        type: str(r.type) ?? 'unknown',
        active: bool(r.active) ?? false,
        autostart: bool(r.autostart) ?? false,
      };
      const set = <K extends keyof NetworkInterface>(k: K, v: NetworkInterface[K] | undefined) => {
        if (v !== undefined) n[k] = v;
      };
      set('method', str(r.method));
      set('cidr', str(r.cidr));
      set('address', str(r.address));
      set('gateway', str(r.gateway));
      set('cidr6', str(r.cidr6));
      set('gateway6', str(r.gateway6));
      if (r.bridge_ports !== undefined) set('bridgePorts', splitSpace(r.bridge_ports));
      set('bridgeVlanAware', bool(r.bridge_vlan_aware));
      if (r.slaves !== undefined) set('bondSlaves', splitSpace(r.slaves));
      set('bondMode', str(r.bond_mode));
      set('vlanId', num(r['vlan-id']));
      set('vlanRawDevice', str(r['vlan-raw-device']));
      const comments = typeof r.comments === 'string' ? r.comments.trim() : '';
      if (comments) n.comments = comments;
      set('mtu', num(r.mtu));
      return n;
    });
}

function pkg(r: Record<string, unknown>): PackageUpdate | undefined {
  const name = str(r.Package);
  const newVersion = str(r.Version);
  if (!name || !newVersion) return undefined;
  const u: PackageUpdate = { name, newVersion };
  const old = str(r.OldVersion);
  if (old) u.oldVersion = old;
  const origin = str(r.Origin);
  if (origin) u.origin = origin;
  const priority = str(r.Priority);
  if (priority) u.priority = priority;
  const section = str(r.Section);
  if (section) u.section = section;
  const title = str(r.Title);
  if (title) u.title = title;
  return u;
}

const byName = (a: PackageUpdate, b: PackageUpdate) => a.name.localeCompare(b.name);

/** /var/lib/pve-manager/pkgupdates via the host helper (same objects as GET /apt/update). All entries are pending. */
export function mapPkgUpdates(raw: unknown): PackageUpdate[] {
  return records(raw)
    .map(pkg)
    .filter((u): u is PackageUpdate => !!u)
    .sort(byName);
}

/**
 * GET /nodes/{node}/apt/versions (Sys.Audit; Proxmox packages only). For installed packages OldVersion = installed and
 * Version = candidate, so a differing pair means an upgrade is pending. Entries without OldVersion (not installed) are
 * skipped.
 */
export function mapAptVersions(raw: unknown): PackageUpdate[] {
  return records(raw)
    .filter((r) => {
      const old = str(r.OldVersion);
      const cand = str(r.Version);
      const state = str(r.CurrentState);
      return !!old && !!cand && old !== cand && (state === undefined || state === 'Installed');
    })
    .map(pkg)
    .filter((u): u is PackageUpdate => !!u)
    .sort(byName);
}

/**
 * An installed kernel image package as GET /apt/versions (and `pveversion -v`) lists it → its kernel release (`uname -r`):
 * proxmox-kernel-6.8.12-5-pve-signed → 6.8.12-5-pve, pve-kernel-5.15.158-2-pve → 5.15.158-2-pve,
 * proxmox-kernel-6.14.8-2-bpo12-pve-signed → 6.14.8-2-bpo12-pve. Meta packages (proxmox-kernel-6.8, -helper) don't match.
 */
const KERNEL_PKG_RE = /^(?:proxmox|pve)-kernel-(\d+\.\d+(?:\.\d+)?-\d+(?:-[a-z0-9]+)*?-pve)(?:-signed)?$/;

/** Kernel releases of the installed kernel image packages in GET /nodes/{node}/apt/versions. */
export function installedKernels(raw: unknown): string[] {
  const out = new Set<string>();
  for (const r of records(raw)) {
    const m = KERNEL_PKG_RE.exec(str(r.Package) ?? '');
    if (!m) continue;
    const state = str(r.CurrentState);
    // CurrentState: Installed | NotInstalled | ConfigFiles | …; without it, an OldVersion means "installed".
    if (state === undefined ? !str(r.OldVersion) : state !== 'Installed') continue;
    out.add(m[1]!);
  }
  return [...out];
}

/** Compare kernel releases numerically ("6.8.12-10-pve" > "6.8.12-9-pve" > "6.8.8-4-pve"); < 0, 0 or > 0. */
export function compareKernels(a: string, b: string): number {
  const pa = a.match(/\d+/g)?.map(Number) ?? [];
  const pb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest of several kernel releases (undefined for none). */
export function newestKernel(list: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const k of list) if (k && (best === undefined || compareKernels(k, best) > 0)) best = k;
  return best;
}

export interface VersionInfo {
  version?: string;
  release?: string;
  repoid?: string;
  /** datacenter.cfg default console viewer (applet|vv|html5|xtermjs), only when configured */
  console?: string;
}

/** GET /version */
export function mapVersion(raw: unknown): VersionInfo {
  const r = isRecord(raw) ? raw : {};
  const v: VersionInfo = {};
  const version = str(r.version);
  if (version) v.version = version;
  const release = str(r.release);
  if (release) v.release = release;
  const repoid = str(r.repoid);
  if (repoid) v.repoid = repoid;
  const console = str(r.console);
  if (console) v.console = console;
  return v;
}

/** GET /nodes/{node}/subscription. Never exposes the key, server id or signature. */
export function mapSubscription(raw: unknown): NodeSummary['subscription'] | undefined {
  const r = isRecord(raw) ? raw : undefined;
  const status = r ? str(r.status) : undefined;
  if (!r || !status) return undefined;
  const s: NonNullable<NodeSummary['subscription']> = { status };
  const level = str(r.level);
  if (level) s.level = level;
  const product = str(r.productname);
  if (product) s.productName = product;
  return s;
}

/** GET /nodes/{node}/certificates/info → the certificate pveproxy serves: pveproxy-ssl.pem if present, else pve-ssl.pem. */
export function pickCertificate(raw: unknown): NodeSummary['certificate'] | undefined {
  const certs = records(raw);
  const c = certs.find((x) => x.filename === 'pveproxy-ssl.pem') ?? certs.find((x) => x.filename === 'pve-ssl.pem');
  if (!c) return undefined;
  const out: NonNullable<NodeSummary['certificate']> = {};
  const subject = str(c.subject);
  if (subject) out.subject = subject;
  const issuer = str(c.issuer);
  if (issuer) out.issuer = issuer;
  const notAfter = secToMs(c.notafter);
  if (notAfter !== undefined) out.notAfter = notAfter;
  const fp = str(c.fingerprint);
  if (fp) out.fingerprint = fp;
  const filename = str(c.filename);
  if (filename) out.filename = filename;
  if (Array.isArray(c.san)) out.san = c.san.map((x) => str(x)).filter((x): x is string => !!x);
  return out;
}

/** GET /nodes/{node}/services. `state` is the systemd SubState (or Result for oneshot units). */
export function mapHostServices(raw: unknown): HostService[] {
  return records(raw)
    .filter((r) => str(r.service))
    .map((r): HostService => {
      const s: HostService = { service: str(r.service)!, state: str(r.state) ?? 'unknown' };
      const name = str(r.name);
      if (name) s.name = name;
      const desc = str(r.desc);
      if (desc) s.desc = desc;
      const active = str(r['active-state']);
      if (active) s.activeState = active;
      const unit = str(r['unit-state']);
      if (unit) s.unitState = unit;
      return s;
    })
    .sort((a, b) => a.service.localeCompare(b.service));
}
