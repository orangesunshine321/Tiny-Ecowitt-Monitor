/**
 * Pure freshness and Proxmox-error helpers behind the Live indicator, the node error banner and Settings → Data
 * Sources (no DOM, unit-tested in tests/web-freshness.test.ts).
 */
import type { CollectorStatus, NodeSummary } from '../../../shared/types';
import type { Tone } from '../components/status';
import type { ConnectionState } from '../store';

/** Friendly names for collectors (server/proxmox, inventory, health). Unknown names are shown capitalised. */
const COLLECTOR_LABEL: Record<string, string> = {
  status: 'Node status',
  rrd: 'History (RRD)',
  tasks: 'Tasks',
  storage: 'Storage',
  network: 'Network',
  updates: 'Package updates',
  backupJobs: 'Backup jobs',
  backups: 'Backups',
  zfs: 'ZFS pools',
  disks: 'Disks & SMART',
  hostInfo: 'Host info',
  guestDetails: 'Guest details',
  health: 'Health checks',
  inventory: 'Apps & services',
  sensors: 'Temperatures',
  config: 'Config file',
};

export function collectorLabel(name: string): string {
  return COLLECTOR_LABEL[name] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/**
 * "every 5s" for polled collectors; undefined for event-driven ones that report `intervalSec: 0` (e.g. `config`, which
 * only reports when config.yaml failed to load), whose interval would otherwise read "every 0s".
 */
export function collectorEvery(c: Pick<CollectorStatus, 'intervalSec'>, fmt: (sec: number) => string): string | undefined {
  return c.intervalSec > 0 ? `every ${fmt(c.intervalSec)}` : undefined;
}

/**
 * The client only learns new `meta.collectors` from the server's meta patch, which the SSE hub sends every ~15 s. So
 * the client's copy of `lastSuccess` is routinely up to ~15 s older than the server's: allow for that cadence plus a
 * few seconds of slack before calling a collector stale.
 */
export const META_REFRESH_GRACE_MS = 20_000;

/** Freshness of one collector: ok within 2× its interval (+ the meta cadence), warn when older, crit when its last attempt failed. */
export function collectorTone(c: CollectorStatus, now: number): Tone {
  const failedLast = c.lastErrorAt !== undefined && (c.lastSuccess === undefined || c.lastErrorAt > c.lastSuccess);
  if (failedLast) return 'crit';
  if (c.lastSuccess === undefined) return 'off';
  if (c.intervalSec <= 0) return 'ok'; // event-driven: a success never goes stale
  return now - c.lastSuccess > c.intervalSec * 2000 + META_REFRESH_GRACE_MS ? 'warn' : 'ok';
}

/**
 * Freshness of the node status poll. `node.lastUpdated` arrives with every node patch (each status tick, ~5 s), so it
 * is the most current signal; the collector entry (refreshed only every ~15 s) is the fallback for older servers.
 */
export function statusPollTone(node: Pick<NodeSummary, 'lastUpdated'>, status: CollectorStatus | undefined, now: number): Tone | undefined {
  if (status) {
    const tone = collectorTone(status, now);
    if (tone === 'crit') return tone;
    if (node.lastUpdated !== undefined && now - node.lastUpdated <= status.intervalSec * 2000 + 5_000) return 'ok';
    return tone;
  }
  return undefined;
}

/** Overall indicator state from the stream, the node and the status poll. */
export function liveState(
  conn: ConnectionState,
  nodeOnline: boolean,
  statusTone: Tone | undefined,
  node?: Pick<NodeSummary, 'errorKind'>,
): { tone: Tone; label: string } {
  if (conn === 'offline') return { tone: 'crit', label: 'Offline' };
  if (conn === 'connecting') return { tone: 'off', label: 'Connecting' };
  if (conn === 'stale') return { tone: 'warn', label: 'Stale' };
  if (!nodeOnline) return { tone: 'crit', label: nodeErrorCopy(node?.errorKind).short };
  if (statusTone === 'warn' || statusTone === 'crit') return { tone: 'warn', label: 'Stale' };
  return { tone: 'ok', label: 'Live' };
}

// ───────────────────────────────────────────────────────────── Proxmox API errors (decision 5)

export type PveErrorKind = NonNullable<NodeSummary['errorKind']>;

/** Title (sentence) and short label (indicator pill) per classified cause. Unknown/absent → "can't reach". */
export function nodeErrorCopy(kind: PveErrorKind | undefined): { title: string; short: string } {
  switch (kind) {
    case 'auth':
      return { title: 'Proxmox rejected the API token', short: 'Token rejected' };
    case 'permission':
      return { title: 'The API token is missing a permission', short: 'No permission' };
    case 'tls':
      return { title: 'Proxmox’s certificate isn’t trusted', short: 'TLS error' };
    case 'timeout':
      return { title: 'Proxmox isn’t answering', short: 'Node timeout' };
    case 'proxmox':
      return { title: 'Proxmox returned an error', short: 'Proxmox error' };
    case 'unreachable':
    case 'other':
    default:
      return { title: 'Can’t reach the Proxmox API', short: 'Node offline' };
  }
}

export interface NodeErrorInfo {
  kind: PveErrorKind | undefined;
  title: string;
  short: string;
  /** the server's error text (may be raw transport text from older servers) */
  detail?: string;
  /** one-line fix from the server (absent on older servers) */
  hint?: string;
  /** a shell command found in the hint, for a copy button */
  command?: string;
  /** the hint without the command ("On the Proxmox host run:"), shown before the command block */
  hintLead?: string;
}

/** Commands an errorHint may contain (after a colon, or the whole hint). */
const COMMAND_RE = /(?:^|:\s+)((?:sudo\s+)?(?:pveum|pvesh|systemctl|pve1-dash-doctor|PVE1_DASH_[A-Z_]+=\S+|bash|curl|openssl|ssh-keyscan|ssh|pct|qm|journalctl)\b.*)$/;

/** Everything the banner and the Live popover say about a failing node, or null when the node is fine. */
export function describeNodeError(node: Pick<NodeSummary, 'online' | 'error' | 'errorKind' | 'errorHint'>): NodeErrorInfo | null {
  if (node.online) return null;
  const copy = nodeErrorCopy(node.errorKind);
  const hint = node.errorHint?.trim() || undefined;
  const m = hint ? COMMAND_RE.exec(hint) : null;
  const command = m?.[1]?.replace(/[.;]\s*$/, '').trim() || undefined;
  const lead = m && hint ? hint.slice(0, m.index).replace(/[:\s]+$/, '') : '';
  return {
    kind: node.errorKind,
    ...copy,
    detail: node.error?.trim() || undefined,
    hint,
    command,
    hintLead: command ? (lead ? `${lead}:` : undefined) : undefined,
  };
}

/** Where the Settings diagnostics section lives (decision 5: "Open Diagnostics"). */
export const DIAGNOSTICS_PATH = '/settings#diagnostics';
