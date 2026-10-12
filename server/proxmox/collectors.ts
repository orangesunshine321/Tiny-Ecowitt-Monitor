/**
 * One collector per Store section / polling interval (config.polling). Each `run` performs the API calls, maps the
 * result with the pure functions in mapping.ts / storageMapping.ts / hostMapping.ts / backupHealth.ts and publishes it.
 * Scheduling, backoff and freshness reporting are handled by Poller (poller.ts).
 *
 * Read-only by construction: only GET requests, and never endpoints that need write privileges
 * (e.g. /apt/update needs Sys.Modify; backup content needs VM.Backup — both come from the SSH host helper instead).
 *
 * Endpoints that can block: GET /nodes/{node}/storage activates every storage on the spot (an NFS/CIFS/PBS check can
 * take 10 s or more per storage when a NAS sleeps or is gone) and occupies a pvedaemon worker meanwhile. Storage sizes
 * and states therefore come from /cluster/resources (served from pvestatd's cache, refreshed every 10 s), and the
 * per-node listing is only an occasional enrichment with a long timeout that never fails the collector.
 */
import type { Config } from '../config.js';
import type { AppContext, HostHelper, Logger } from '../context.js';
import type { BackupItem, GuestType, NodeSummary, PackageUpdate, Pressure, TaskEntry } from '../../shared/types.js';
import { classifyPveError, normalizeFingerprint, PveApiError, pvePath, type PveClient } from './client.js';
import {
  findNodeResource,
  latestNodeRrd,
  mapAgentInterfaces,
  mapAgentOsName,
  mapGuestPressure,
  mapLxcConfig,
  mapLxcInterfaces,
  mapNodeStatus,
  mapQemuConfig,
  mapRrd,
  vmResources,
  type GuestDetails,
} from './mapping.js';
import {
  clusterStorageEntries,
  computeCoverage,
  lastBackups,
  mapBackupContent,
  mapBackupJobs,
  mapDisks,
  mapLvmThin,
  mapNotBackedUp,
  mapPruneBackups,
  mapTaskLog,
  mapTasks,
  mapZfsPools,
  mergeStorage,
  sortBackups,
} from './storageMapping.js';
import {
  installedKernels,
  mapAptVersions,
  mapHostServices,
  mapNetwork,
  mapPkgUpdates,
  mapSubscription,
  mapVersion,
  newestKernel,
  pickCertificate,
} from './hostMapping.js';
import { failuresFromTask, newestFailures, parseVzdumpLog, staleThresholds, type BackupFailure, type SelectableGuest } from './backupHealth.js';
import type { GuestState, NodeState } from './live.js';
import type { PollOutcome } from './poller.js';
import { bool, num, records, str } from './parse.js';

export type CollectorName = keyof Config['polling'];

export interface CollectorSpec {
  name: CollectorName;
  intervalSec: number;
  run(signal: AbortSignal): Promise<PollOutcome | void>;
}

export interface CollectorDeps {
  ctx: AppContext;
  client: PveClient;
  hostHelper: HostHelper;
  nodeState: NodeState;
  guestState: GuestState;
  log: Logger;
  /** clock for cadences, startup grace, staleness and certificate checks (tests); default Date.now */
  now?: () => number;
}

const DAY_MS = 86_400_000;
/** After a 403 from the guest-agent endpoints (PVE 8 requires VM.Monitor, which we deliberately do not request). */
const AGENT_FORBIDDEN_BACKOFF_MS = 30 * 60_000;
/** After "agent not configured/running" or a QGA failure for one VM. */
const AGENT_VM_BACKOFF_MS = 5 * 60_000;
/** After /lxc/{vmid}/interfaces is missing (PVE < 8.1). */
const LXC_IFACES_BACKOFF_MS = 60 * 60_000;
const DETAILS_CONCURRENCY = 4;
/**
 * disks/list runs `smartctl -H` on every disk unless `skipsmart=1`, which wakes spun-down HDDs (smartctl's default
 * ignores the power mode). The disk inventory is polled with skipsmart=1; health and wear are re-read from a full
 * listing only this often (or at polling.disks, if that is longer), and at once when an unknown disk shows up.
 */
export const SMART_REFRESH_MS = 6 * 3600_000;
/**
 * For this long after the first backups poll, a listing that misses an enabled backup storage we have never listed
 * (PBS still booting after a host restart, NFS share not mounted yet) is not published: publishing it would show every
 * guest backed up only there as "never backed up" and raise false stale alerts. After that, partial data is published
 * with a warning.
 */
export const BACKUP_STARTUP_GRACE_MS = 15 * 60_000;
/** GET /nodes/{node}/storage (the slow, activating listing) at most this often. */
export const NODE_STORAGE_REFRESH_MS = 60_000;
/** Its active/avail values are trusted for this long. */
export const NODE_STORAGE_FRESH_MS = 150_000;
/** The storage collector waits this long for that listing before publishing without it (it is merged in later). */
export const NODE_STORAGE_WAIT_MS = 5_000;
/** Cluster storage entries older than this (status poll failing) are fetched again instead of reused. */
const CLUSTER_STORAGE_MAX_AGE_MS = 30_000;
/** Failed vzdump tasks are looked up (GET …/tasks?typefilter=vzdump&errors=1) this often, and when a new one appears. */
export const VZDUMP_SCAN_MS = 10 * 60_000;
/** At most this many vzdump task logs are fetched per tasks run (the rest follow on the next runs). */
const VZDUMP_LOGS_PER_RUN = 6;
/** After a failed log fetch, that task is retried after this long. */
const VZDUMP_LOG_RETRY_MS = 10 * 60_000;
/** pveupdate renews pve-ssl.pem when it expires within 14 days (ACME/custom pveproxy-ssl.pem: 30 days). */
const CERT_RENEW_DAYS: Record<string, number> = { 'pve-ssl.pem': 14, 'pveproxy-ssl.pem': 30 };
/** Warn this many days before that renewal. */
const CERT_WARN_LEAD_DAYS = 7;
/** Host services whose failure the dashboard reports, and what stops working then. */
const CRITICAL_HOST_SERVICES: Record<string, string> = {
  pvescheduler: 'scheduled backup jobs and replication do not run',
  pvestatd: 'guest and storage status stops updating',
  'pve-cluster': 'the cluster file system /etc/pve is unavailable',
  pvedaemon: 'most API calls fail',
};

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Resolves true when `p` settles within `ms`, false otherwise (p keeps running). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function summarize(problems: string[], max = 4): string {
  const shown = problems.slice(0, max).join('; ');
  return problems.length > max ? `${shown}; +${problems.length - max} more` : shown;
}

/** Identity of a disks/list row across listings (devpath can move after a reboot; serial may be "unknown"). */
function diskKey(r: Record<string, unknown>): string {
  return `${str(r.devpath) ?? ''}|${str(r.serial) ?? ''}`;
}

const isFailedVzdump = (t: TaskEntry) => t.type === 'vzdump' && t.endTime !== undefined && (t.severity === 'error' || t.severity === 'warning');

function sameFailures(a: ReadonlyMap<number, BackupFailure>, b: ReadonlyMap<number, BackupFailure>): boolean {
  if (a.size !== b.size) return false;
  for (const [vmid, f] of a) {
    const g = b.get(vmid);
    if (!g || g.upid !== f.upid || g.message !== f.message) return false;
  }
  return true;
}

/**
 * Warning when the pinned certificate is about to be replaced by Proxmox itself (D27): pveupdate renews pve-ssl.pem
 * 14 days before it expires (ACME certificates 30 days before), after which proxmox.tls.fingerprint no longer matches.
 */
export function pinnedCertificateWarning(cert: NodeSummary['certificate'], pin: string | undefined, now: number): string | undefined {
  if (!pin || !cert?.notAfter) return undefined;
  // Only for the certificate that is pinned (a mismatch is reported by the status poll as a TLS error).
  if (cert.fingerprint && normalizeFingerprint(cert.fingerprint) !== normalizeFingerprint(pin)) return undefined;
  const renewDays = CERT_RENEW_DAYS[cert.filename ?? ''] ?? 14;
  const daysLeft = (cert.notAfter - now) / DAY_MS;
  if (daysLeft > renewDays + CERT_WARN_LEAD_DAYS) return undefined;
  const when = daysLeft <= 0 ? 'has expired' : `expires in ${Math.ceil(daysLeft)} day${Math.ceil(daysLeft) === 1 ? '' : 's'}`;
  return (
    `the pinned Proxmox certificate (${cert.filename ?? 'node certificate'}) ${when}; Proxmox replaces it ${renewDays} days before expiry and ` +
    'the new one will not match proxmox.tls.fingerprint. Trust the CA instead (proxmox.tls.ca, see pve1-dash-doctor) or re-run the installer after the renewal'
  );
}

export function createCollectors(d: CollectorDeps): CollectorSpec[] {
  const { ctx, client, hostHelper, nodeState, guestState, log } = d;
  const clock = d.now ?? Date.now;
  const { store } = ctx;
  const cfg = ctx.config.proxmox;
  const node = cfg.node;
  const polling = ctx.config.polling;
  const timeoutMs = cfg.timeoutMs;
  const slow = (min: number) => Math.max(timeoutMs, min);
  const errorContext = { baseUrl: cfg.url, tokenId: cfg.tokenId };
  const staleRule = ctx.config.alerts.rules.backupStale;
  const graceDays = staleRule.graceDays;

  // Guest-agent / LXC-interfaces capability memory (shared across guestDetails runs).
  let agentForbiddenUntil = 0;
  const agentSkipUntil = new Map<number, number>();
  let lxcIfacesUnsupportedUntil = 0;
  let zfsMissingLogged = false;
  // Last good per-storage backup listings, kept when one storage fails transiently or is inactive (e.g. PBS
  // unreachable). Entries live as long as the storage is still configured for backups on this node.
  let lastItemsByStorage = new Map<string, { items: BackupItem[]; via: 'ssh' | 'prunebackups' }>();
  let lastNotBackedUp: Set<number> | undefined;
  let backupsFirstRunAt: number | undefined;
  // Health/wear of the last full (SMART) disks/list, keyed by diskKey().
  let smart: { at: number; byKey: Map<string, { health: unknown; wearout: unknown }> } | undefined;

  // Storage: /cluster/resources entries (from the status poll) + the occasional per-node listing.
  let clusterStorage: { at: number; rows: Record<string, unknown>[] } | undefined;
  let nodeStorage: { at: number; rows: Record<string, unknown>[] } | undefined;
  let nodeStorageAttemptAt: number | undefined;
  let nodeStorageTask: Promise<void> | undefined;
  let nodeStorageError: string | undefined;

  // Backup coverage inputs (the backups, backupJobs and tasks collectors each contribute).
  let coverageInput: { guests: (SelectableGuest & { name: string; type: GuestType; template: boolean })[]; items: BackupItem[] } | undefined;
  let rawJobs: Record<string, unknown>[] | undefined;
  let backupFailures = new Map<number, BackupFailure>();
  const vzdumpFailures = new Map<string, Map<number, BackupFailure>>();
  const vzdumpRetryAt = new Map<string, number>();
  let vzdumpScanAt: number | undefined;

  // Package list freshness: from the host helper, else the newest daily "aptupdate" task.
  let helperUpdatesCheckedAt: number | undefined;
  let aptTaskCheckedAt: number | undefined;

  /** vm entries on this node: from the latest status poll, or fetched when the status poll has not succeeded yet. */
  async function currentVms(signal: AbortSignal): Promise<Record<string, unknown>[]> {
    const known = guestState.resources();
    if (known) return [...known];
    return vmResources(await client.get('/cluster/resources', { type: 'vm' }, { signal }), node);
  }

  // ── status (5 s): /cluster/resources + /nodes/{node}/status

  async function status(signal: AbortSignal): Promise<void> {
    try {
      const [resources, st] = await Promise.all([
        client.get('/cluster/resources', undefined, { signal }),
        client.get(pvePath`/nodes/${node}/status`, undefined, { signal }),
      ]);
      const now = Date.now();
      const nodeSample = nodeState.updateStatus(mapNodeStatus(node, st, findNodeResource(resources, node), now), now);
      const guestSamples = guestState.updateResources(vmResources(resources, node), now);
      clusterStorage = { at: clock(), rows: clusterStorageEntries(resources, node) };
      // the sections were published above, so the stream sends their patches before these samples
      store.emitHistory({ node: nodeSample, guests: guestSamples });
    } catch (err) {
      if (!signal.aborted) nodeState.markFailure(classifyPveError(err, errorContext), Date.now());
      throw err;
    }
  }

  // ── rrd (60 s): latest node RRD sample (+ guest PSI from the guest lists on PVE 9)

  async function rrd(signal: AbortSignal): Promise<PollOutcome | void> {
    const raw = await client.get(pvePath`/nodes/${node}/rrddata`, { timeframe: 'hour', cf: 'AVERAGE' }, { signal });
    nodeState.setExtras(latestNodeRrd(mapRrd(raw, 'node')));

    // Guest PSI only exists on PVE 9 (pressure* fields of /nodes/{node}/qemu and /lxc); skip the calls on PVE 8.
    const major = nodeState.pveMajor();
    if (major !== undefined && major < 9) return;
    const pressure = new Map<number, Pressure>();
    const problems: string[] = [];
    for (const kind of ['qemu', 'lxc'] as const) {
      try {
        for (const g of records(await client.get(pvePath`/nodes/${node}/${kind}`, undefined, { signal }))) {
          const vmid = num(g.vmid);
          const p = mapGuestPressure(g);
          if (vmid !== undefined && p) pressure.set(vmid, p);
        }
      } catch (err) {
        if (signal.aborted) throw err;
        problems.push(`${kind} list: ${errMessage(err)}`);
      }
    }
    guestState.setPressure(pressure);
    if (problems.length) return { warning: `guest pressure: ${summarize(problems)}` };
  }

  // ── guestDetails (120 s): configs, LXC interfaces, guest agent

  async function guestDetails(signal: AbortSignal): Promise<PollOutcome | void> {
    const vms = vmResources(await client.get('/cluster/resources', { type: 'vm' }, { signal }), node);
    const prev = guestState.detailsSnapshot();
    const next = new Map<number, GuestDetails>();
    const problems: string[] = [];
    let configFailures = 0;
    let firstConfigError: unknown;

    await mapLimit(vms, DETAILS_CONCURRENCY, async (vm) => {
      if (signal.aborted) return;
      const vmid = num(vm.vmid)!;
      const type: GuestType = vm.type === 'lxc' ? 'lxc' : 'qemu';
      const running = str(vm.status) === 'running';
      // Start from what we knew, so a transient failure keeps the previous config/IPs.
      const det: GuestDetails = { ...prev.get(vmid) };

      try {
        // current=1: the applied config. By default PVE merges pending (not yet applied) changes, which would e.g.
        // report a guest agent or serial port that only exists after the next restart (pve-api-guests.md §3).
        const raw = await client.get(pvePath`/nodes/${node}/${type}/${vmid}/config`, { current: 1 }, { signal });
        const parsed = type === 'qemu' ? mapQemuConfig(raw) : mapLxcConfig(raw);
        det.config = parsed.config;
        det.configName = parsed.name;
        det.description = parsed.description;
      } catch (err) {
        if (signal.aborted) return;
        configFailures++;
        firstConfigError ??= err;
        problems.push(`${type}/${vmid} config: ${errMessage(err)}`);
      }

      if (!running) {
        delete det.liveIps; // addresses of a stopped guest are not live data
      } else if (type === 'lxc') {
        await collectLxcIps(vmid, det, signal, problems);
      } else if (det.config?.agentEnabled) {
        await collectAgent(vmid, det, signal, problems);
      } else {
        delete det.liveIps;
      }
      next.set(vmid, det);
    });

    if (signal.aborted) return;
    guestState.setDetails(next);
    if (vms.length > 0 && configFailures === vms.length) throw firstConfigError;
    if (problems.length) return { warning: summarize(problems) };
  }

  async function collectLxcIps(vmid: number, det: GuestDetails, signal: AbortSignal, problems: string[]) {
    if (Date.now() < lxcIfacesUnsupportedUntil) return;
    try {
      // PVE ≥ 8.1. A container that stopped meanwhile may answer `null`.
      det.liveIps = mapLxcInterfaces(await client.get(pvePath`/nodes/${node}/lxc/${vmid}/interfaces`, undefined, { signal }));
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof PveApiError && (err.status === 501 || err.status === 404)) {
        lxcIfacesUnsupportedUntil = Date.now() + LXC_IFACES_BACKOFF_MS;
        log.info('GET /lxc/{vmid}/interfaces is not available (PVE < 8.1); container IPs come from config/inventory only');
        return;
      }
      problems.push(`lxc/${vmid} interfaces: ${errMessage(err)}`);
    }
  }

  async function collectAgent(vmid: number, det: GuestDetails, signal: AbortSignal, problems: string[]) {
    const now = Date.now();
    if (now < agentForbiddenUntil || now < (agentSkipUntil.get(vmid) ?? 0)) {
      delete det.liveIps;
      return;
    }
    const agentPath = (cmd: string) => pvePath`/nodes/${node}/qemu/${vmid}/agent/${cmd}`;
    try {
      det.liveIps = mapAgentInterfaces(await client.get(agentPath('network-get-interfaces'), undefined, { signal }));
      agentSkipUntil.delete(vmid);
    } catch (err) {
      if (!signal.aborted) handleAgentError(vmid, det, err, problems);
      return;
    }
    try {
      const os = mapAgentOsName(await client.get(agentPath('get-osinfo'), undefined, { signal }));
      if (os) det.osName = os;
    } catch (err) {
      // Older agents lack guest-get-osinfo; that is not worth a warning. Only transport errors are reported.
      if (!signal.aborted && err instanceof PveApiError && err.status === 0) problems.push(`qemu/${vmid} agent osinfo: ${err.message}`);
    }
  }

  function handleAgentError(vmid: number, det: GuestDetails, err: unknown, problems: string[]) {
    if (err instanceof PveApiError && err.status === 403) {
      if (Date.now() >= agentForbiddenUntil) {
        log.info(
          'guest agent endpoints return 403 (PVE 8 requires VM.Monitor, which pve1-dash deliberately does not request); ' +
            'VM addresses come from the SSH inventory instead. Retrying in 30 min.',
        );
      }
      agentForbiddenUntil = Date.now() + AGENT_FORBIDDEN_BACKOFF_MS;
      delete det.liveIps;
      return;
    }
    if (err instanceof PveApiError && err.status >= 500) {
      // "No QEMU guest agent configured", "VM 100 is not running", "QEMU guest agent is not running",
      // "qga command … failed": an agent-side condition, not an API problem. Each failing call can block for the 3 s
      // guest-ping timeout, so leave this VM alone for a while.
      agentSkipUntil.set(vmid, Date.now() + AGENT_VM_BACKOFF_MS);
      delete det.liveIps;
      log.debug(`qemu/${vmid}: guest agent unavailable`, { reason: err.pveMessage ?? err.message });
      return;
    }
    problems.push(`qemu/${vmid} agent: ${errMessage(err)}`); // transport error: keep the previous addresses
  }

  // ── storage (30 s): /cluster/resources storage entries + GET /nodes/{node}/storage at most every 60 s

  /** This node's storage entries of /cluster/resources: from the status poll, or fetched when that data is old. */
  async function clusterStorageRows(signal: AbortSignal): Promise<Record<string, unknown>[]> {
    if (clusterStorage && clock() - clusterStorage.at <= CLUSTER_STORAGE_MAX_AGE_MS) return clusterStorage.rows;
    const rows = clusterStorageEntries(await client.get('/cluster/resources', { type: 'storage' }, { signal }), node);
    clusterStorage = { at: clock(), rows };
    return rows;
  }

  /** Refresh the per-node listing (one at a time); failures only leave a warning. */
  function refreshNodeStorage(signal: AbortSignal): Promise<void> {
    nodeStorageTask ??= (async () => {
      nodeStorageAttemptAt = clock();
      try {
        const raw = await client.get(pvePath`/nodes/${node}/storage`, undefined, { signal, timeoutMs: slow(60_000) });
        nodeStorage = { at: clock(), rows: records(raw) };
        nodeStorageError = undefined;
      } catch (err) {
        if (!signal.aborted) nodeStorageError = errMessage(err);
      } finally {
        nodeStorageTask = undefined;
      }
    })();
    return nodeStorageTask;
  }

  function storageView(clusterRows: Record<string, unknown>[]) {
    const fresh = nodeStorage !== undefined && clock() - nodeStorage.at <= NODE_STORAGE_FRESH_MS;
    return mergeStorage({ cluster: clusterRows, node: nodeStorage?.rows, nodeFresh: fresh });
  }

  async function storage(signal: AbortSignal): Promise<PollOutcome | void> {
    const rows = await clusterStorageRows(signal);
    if (nodeStorageAttemptAt === undefined || clock() - nodeStorageAttemptAt >= NODE_STORAGE_REFRESH_MS) {
      const task = refreshNodeStorage(signal);
      if (!(await settlesWithin(task, NODE_STORAGE_WAIT_MS))) {
        // slow storage activation (sleeping NAS): publish from the cluster data now, merge the listing when it arrives
        void task.then(() => {
          if (!signal.aborted) store.set('storage', storageView(clusterStorage?.rows ?? rows));
        });
      }
    }
    store.set('storage', storageView(rows));
    if (nodeStorageError) {
      return { warning: `storage details (free space, disabled storages) unavailable: ${nodeStorageError}; sizes come from the cluster status` };
    }
  }

  // ── zfs (60 s): ZFS pools + LVM-thin pools (data and metadata usage)

  async function zfs(signal: AbortSignal): Promise<PollOutcome | void> {
    const [pools, thin] = await Promise.allSettled([
      client.get(pvePath`/nodes/${node}/disks/zfs`, undefined, { signal }),
      client.get(pvePath`/nodes/${node}/disks/lvmthin`, undefined, { signal }),
    ]);
    if (thin.status === 'fulfilled') store.set('lvmThin', mapLvmThin(thin.value));
    if (pools.status === 'fulfilled') {
      store.set('zfs', mapZfsPools(pools.value));
    } else {
      const err = pools.reason;
      // A host without ZFS answers "zfsutils-linux not installed": that is an empty list, not an outage.
      if (!(err instanceof PveApiError && /not installed/i.test(err.pveMessage ?? ''))) throw err;
      if (!zfsMissingLogged) log.info('zfsutils-linux is not installed on the node; no ZFS pools to show');
      zfsMissingLogged = true;
      store.set('zfs', []);
    }
    if (thin.status === 'rejected') return { warning: `LVM-thin pools: ${errMessage(thin.reason)}` };
  }

  // ── disks (600 s)

  async function disks(signal: AbortSignal): Promise<PollOutcome | void> {
    const path = pvePath`/nodes/${node}/disks/list`;
    const now = clock();
    /** skipsmart rows with health/wear from the last SMART listing (UNKNOWN / N/A for disks it did not have) */
    const withKnownSmart = (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, ...smart?.byKey.get(diskKey(r)) }));
    const smartDue = !smart || now - smart.at >= Math.max(SMART_REFRESH_MS, polling.disks * 1000);
    if (!smartDue) {
      // Inventory only: no smartctl, so spun-down disks stay asleep. Health and wear come from the last SMART listing.
      const rows = records(await client.get(path, { skipsmart: 1 }, { signal }));
      if (rows.every((r) => smart!.byKey.has(diskKey(r)))) {
        store.set('disks', mapDisks(withKnownSmart(rows)));
        return;
      }
      // a new or replaced disk: read its health now rather than showing it as unknown for hours
    }
    let raw: unknown;
    try {
      // Runs smartctl per disk on the node (PVE 9: up to 10 s each; PVE 8 has no limit), so allow a longer timeout.
      raw = await client.get(path, undefined, { signal, timeoutMs: slow(60_000) });
    } catch (err) {
      if (signal.aborted) throw err;
      // smartctl hanging on one dying disk must not blank the whole disk list: fall back to the inventory without
      // SMART (and the last known health); the full listing is retried on the next poll.
      const rows = records(await client.get(path, { skipsmart: 1 }, { signal }));
      store.set('disks', mapDisks(withKnownSmart(rows)));
      return { warning: `SMART health not refreshed (${errMessage(err)}); showing the last known values` };
    }
    smart = { at: now, byKey: new Map(records(raw).map((r) => [diskKey(r), { health: r.health, wearout: r.wearout }])) };
    store.set('disks', mapDisks(raw));
  }

  // ── tasks (30 s) + failed backup analysis + package list freshness

  async function tasks(signal: AbortSignal): Promise<PollOutcome | void> {
    const list = mapTasks(await client.get(pvePath`/nodes/${node}/tasks`, { source: 'all', limit: 200 }, { signal }));
    store.set('tasks', list);
    noteAptUpdate(list);
    const warning = await scanBackupFailures(list, signal);
    if (warning) return { warning };
  }

  /**
   * The daily "Package database update" (pveupdate → aptupdate task) refreshes the apt lists. A run that failed (e.g. an
   * enterprise repository without subscription answering 401) did not refresh them, so only ok/warning runs count.
   */
  function noteAptUpdate(list: TaskEntry[]): void {
    let newest: number | undefined;
    for (const t of list) {
      if (t.type !== 'aptupdate' || t.endTime === undefined || (t.severity !== 'ok' && t.severity !== 'warning')) continue;
      if (newest === undefined || t.endTime > newest) newest = t.endTime;
    }
    if (newest !== undefined && newest !== aptTaskCheckedAt && (aptTaskCheckedAt === undefined || newest > aptTaskCheckedAt)) {
      aptTaskCheckedAt = newest;
      publishUpdatesCheckedAt();
    }
  }

  function publishUpdatesCheckedAt(): void {
    const at = helperUpdatesCheckedAt ?? aptTaskCheckedAt;
    if (at !== undefined) nodeState.setExtras({ updatesCheckedAt: at });
  }

  /**
   * Per-guest backup failures from the logs of failed vzdump tasks (decision 12 / D26): a multi-guest job's task id is
   * "", so only the log tells which guests failed. Failed tasks are listed separately (typefilter=vzdump, errors=1), so
   * busy task lists and restarts do not lose them; each log is fetched once and cached by UPID.
   */
  async function scanBackupFailures(list: TaskEntry[], signal: AbortSignal): Promise<string | undefined> {
    const now = clock();
    const fromList = list.filter(isFailedVzdump);
    const unseen = fromList.some((t) => !vzdumpFailures.has(t.upid));
    if (vzdumpScanAt !== undefined && now - vzdumpScanAt < VZDUMP_SCAN_MS && !unseen) return undefined;
    vzdumpScanAt = now;
    const problems: string[] = [];
    const candidates = new Map(fromList.map((t) => [t.upid, t]));
    try {
      const failed = mapTasks(await client.get(pvePath`/nodes/${node}/tasks`, { typefilter: 'vzdump', errors: 1, limit: 30 }, { signal }));
      for (const t of failed.filter(isFailedVzdump)) candidates.set(t.upid, t);
    } catch (err) {
      if (signal.aborted) throw err;
      problems.push(`failed backup tasks: ${errMessage(err)}`);
    }
    for (const upid of [...vzdumpFailures.keys()]) if (!candidates.has(upid)) vzdumpFailures.delete(upid);
    for (const upid of [...vzdumpRetryAt.keys()]) if (!candidates.has(upid)) vzdumpRetryAt.delete(upid);

    const pending = [...candidates.values()]
      .filter((t) => !vzdumpFailures.has(t.upid) && (vzdumpRetryAt.get(t.upid) ?? 0) <= now)
      .sort((a, b) => b.startTime - a.startTime);
    if (pending.length) {
      const guests = (await currentVms(signal)).map((vm): SelectableGuest => {
        const g: SelectableGuest = { vmid: num(vm.vmid)! };
        const pool = str(vm.pool);
        if (pool) g.pool = pool;
        return g;
      });
      for (const t of pending.slice(0, VZDUMP_LOGS_PER_RUN)) {
        try {
          const log = await client.getEnvelope(pvePath`/nodes/${node}/tasks/${t.upid}/log`, { start: 0, limit: 0 }, { signal, timeoutMs: slow(30_000) });
          vzdumpFailures.set(t.upid, failuresFromTask(t, parseVzdumpLog(mapTaskLog(t.upid, log.data, log.total).lines), guests));
          vzdumpRetryAt.delete(t.upid);
        } catch (err) {
          if (signal.aborted) throw err;
          vzdumpRetryAt.set(t.upid, now + VZDUMP_LOG_RETRY_MS);
          problems.push(`log of a failed backup task: ${errMessage(err)}`);
        }
      }
      if (pending.length > VZDUMP_LOGS_PER_RUN) vzdumpScanAt = undefined; // continue with the rest on the next run
    }

    const next = newestFailures(vzdumpFailures.values());
    if (!sameFailures(next, backupFailures)) {
      backupFailures = next;
      if (coverageInput) store.update('backups', (b) => ({ ...b, coverage: currentCoverage() }));
    }
    return problems.length ? `backup failure analysis: ${summarize(problems)}` : undefined;
  }

  // ── network (600 s)

  async function network(signal: AbortSignal): Promise<void> {
    store.set('network', mapNetwork(await client.get(pvePath`/nodes/${node}/network`, undefined, { signal })));
  }

  // ── backups (300 s) + backupJobs (600 s)

  function currentCoverage() {
    const input = coverageInput!;
    const now = clock();
    const thresholds = rawJobs
      ? staleThresholds({ guests: input.guests, jobs: rawJobs, node, staleDays: staleRule.days, graceDays, now })
      : undefined;
    return computeCoverage({
      guests: input.guests,
      items: input.items,
      notBackedUp: lastNotBackedUp,
      staleDays: staleRule.days,
      now,
      thresholds,
      failures: backupFailures,
    });
  }

  async function listBackupsOf(storageId: string, signal: AbortSignal): Promise<{ items: BackupItem[]; via: 'ssh' | 'prunebackups' }> {
    if (hostHelper.available()) {
      // Full listing (size, notes, verification) via `pvesh` as root; the API hides backups from auditor tokens.
      try {
        const raw = await hostHelper.backups(storageId);
        if (raw) return { items: mapBackupContent(raw, storageId), via: 'ssh' };
      } catch (err) {
        log.debug(`host helper backups ${storageId} failed; using the read-only API fallback`, { err: errMessage(err) });
      }
    }
    // Read-only fallback: prune dry-run with keep-all lists every backup (no size/notes). On PBS this spawns one
    // proxmox-backup-client per backup group, hence the long timeout.
    const raw = await client.get(
      pvePath`/nodes/${node}/storage/${storageId}/prunebackups`,
      { 'prune-backups': 'keep-all=1' },
      { signal, timeoutMs: slow(120_000) },
    );
    return { items: mapPruneBackups(raw, storageId), via: 'prunebackups' };
  }

  async function backups(signal: AbortSignal): Promise<PollOutcome | void> {
    backupsFirstRunAt ??= clock();
    const clusterRows = await clusterStorageRows(signal);
    // no storage in the cluster status (pvestatd just started?): ask the node once
    if (clusterRows.length === 0 && nodeStorage === undefined) await refreshNodeStorage(signal);
    const storages = storageView(clusterRows).filter((s) => s.enabled && s.content.includes('backup'));
    const problems: string[] = [];
    const byStorage = new Map<string, { items: BackupItem[]; via: 'ssh' | 'prunebackups' }>();
    /** storages with neither a fresh nor a previous listing */
    const unknown: string[] = [];
    const keepPrevious = (id: string) => {
      const previous = lastItemsByStorage.get(id);
      if (previous) byStorage.set(id, previous); // keep showing the last good listing
      else unknown.push(id);
    };
    for (const s of storages) {
      if (!s.active) {
        // pvestatd could not read the storage (status "unknown") or activating it failed: PBS or the NFS server is not
        // reachable (pve-api-storage.md §1a). Listing it would only fail or hang; its backups have not gone away.
        problems.push(`${s.id}: storage is inactive (unreachable?)`);
        keepPrevious(s.id);
        continue;
      }
      try {
        byStorage.set(s.id, await listBackupsOf(s.id, signal));
      } catch (err) {
        if (signal.aborted) throw err;
        problems.push(`${s.id}: ${errMessage(err)}`);
        keepPrevious(s.id);
      }
    }
    if (storages.length > 0 && byStorage.size === 0) {
      throw new Error(`backup listing failed: ${summarize(problems)}`);
    }
    if (unknown.length && clock() - backupsFirstRunAt < BACKUP_STARTUP_GRACE_MS) {
      throw new Error(`backup listing incomplete, not published yet: ${summarize(problems)}`);
    }
    lastItemsByStorage = byStorage;

    try {
      lastNotBackedUp = mapNotBackedUp(await client.get('/cluster/backup-info/not-backed-up', undefined, { signal }));
    } catch (err) {
      if (signal.aborted) throw err;
      problems.push(`not-backed-up: ${errMessage(err)}`);
    }
    if (!rawJobs) {
      // stale thresholds depend on the job schedules: read them now rather than after a first round of false "stale"
      try {
        rawJobs = records(await client.get('/cluster/backup', undefined, { signal }));
      } catch (err) {
        if (signal.aborted) throw err;
        problems.push(`backup jobs: ${errMessage(err)}`);
      }
    }

    const items = sortBackups([...byStorage.values()].flatMap((v) => v.items));
    const vias = [...byStorage.values()].map((v) => v.via);
    const source: 'ssh' | 'prunebackups' | undefined = vias.length === 0 ? undefined : vias.every((v) => v === 'ssh') ? 'ssh' : 'prunebackups';

    const guests = (await currentVms(signal)).map((vm) => {
      const g: SelectableGuest & { name: string; type: GuestType; template: boolean } = {
        vmid: num(vm.vmid)!,
        name: str(vm.name) ?? `${vm.type === 'lxc' ? 'CT' : 'VM'} ${num(vm.vmid)}`,
        type: vm.type === 'lxc' ? 'lxc' : 'qemu',
        template: bool(vm.template) ?? false,
      };
      const pool = str(vm.pool);
      if (pool) g.pool = pool;
      return g;
    });
    coverageInput = { guests, items };
    const coverage = currentCoverage();
    store.update('backups', (b) => {
      const next = { ...b, items, coverage };
      if (source) next.source = source;
      else delete next.source;
      return next;
    });
    guestState.setLastBackups(lastBackups(items, guests));
    if (problems.length) return { warning: summarize(problems) };
  }

  async function backupJobs(signal: AbortSignal): Promise<void> {
    const raw = await client.get('/cluster/backup', undefined, { signal });
    rawJobs = records(raw);
    const jobs = mapBackupJobs(raw);
    // schedules feed the per-guest stale thresholds
    store.update('backups', (b) => ({ ...b, jobs, ...(coverageInput ? { coverage: currentCoverage() } : {}) }));
  }

  // ── updates (3600 s): pending packages, newest installed kernel, package list freshness

  async function updates(signal: AbortSignal): Promise<PollOutcome | void> {
    // /apt/versions (Sys.Audit) always: it lists the installed kernels even when the helper provides the update list.
    let apt: unknown;
    let aptError: unknown;
    try {
      apt = await client.get(pvePath`/nodes/${node}/apt/versions`, undefined, { signal, timeoutMs: slow(30_000) });
    } catch (err) {
      if (signal.aborted) throw err;
      aptError = err;
    }
    let helperList: PackageUpdate[] | undefined;
    let info: { runningKernel?: string; newestKernel?: string; updatesCheckedAt?: number } | null = null;
    if (hostHelper.available()) {
      try {
        const raw = await hostHelper.pkgUpdates();
        if (raw) helperList = mapPkgUpdates(raw);
      } catch (err) {
        log.debug('host helper pkgupdates failed; using /apt/versions', { err: errMessage(err) });
      }
      if (hostHelper.hostInfo) {
        try {
          info = await hostHelper.hostInfo();
        } catch (err) {
          log.debug('host helper hostinfo failed', { err: errMessage(err) });
        }
      }
    }
    if (signal.aborted) return;

    // Never /apt/update (needs Sys.Modify). /apt/versions covers Proxmox packages only.
    if (helperList) nodeState.setExtras({ updates: helperList, updatesSource: 'ssh' });
    else if (apt !== undefined) nodeState.setExtras({ updates: mapAptVersions(apt), updatesSource: 'apt-versions' });
    else throw aptError;

    helperUpdatesCheckedAt = info?.updatesCheckedAt;
    publishUpdatesCheckedAt();
    const kernels = [...(apt !== undefined ? installedKernels(apt) : []), info?.newestKernel];
    if (apt !== undefined || info?.newestKernel) nodeState.setInstalledKernel(newestKernel(kernels));
    if (aptError) return { warning: `apt/versions: ${errMessage(aptError)}` };
  }

  // ── hostInfo (3600 s): version, subscription, certificate, host services

  async function hostInfo(signal: AbortSignal): Promise<PollOutcome | void> {
    const [version, subscription, certs, services] = await Promise.allSettled([
      client.get('/version', undefined, { signal }),
      client.get(pvePath`/nodes/${node}/subscription`, undefined, { signal }),
      client.get(pvePath`/nodes/${node}/certificates/info`, undefined, { signal }),
      client.get(pvePath`/nodes/${node}/services`, undefined, { signal, timeoutMs: slow(30_000) }),
    ]);
    const failures: string[] = [];
    const notes: string[] = [];
    if (version.status === 'fulfilled') {
      const v = mapVersion(version.value);
      nodeState.setExtras({ pveVersion: v.version, pveRelease: v.release, pveRepoId: v.repoid });
      guestState.setDatacenterConsole(v.console);
    } else failures.push(`version: ${errMessage(version.reason)}`);
    if (subscription.status === 'fulfilled') nodeState.setExtras({ subscription: mapSubscription(subscription.value) });
    else failures.push(`subscription: ${errMessage(subscription.reason)}`);
    if (certs.status === 'fulfilled') {
      const cert = pickCertificate(certs.value);
      nodeState.setExtras({ certificate: cert });
      const warning = pinnedCertificateWarning(cert, cfg.tls.fingerprint, clock());
      if (warning) notes.push(warning);
    } else failures.push(`certificates: ${errMessage(certs.reason)}`);
    if (services.status === 'fulfilled') {
      const list = mapHostServices(services.value);
      nodeState.setExtras({ hostServices: list });
      for (const s of list) {
        const effect = CRITICAL_HOST_SERVICES[s.service];
        if (effect && s.state !== 'running') notes.push(`${s.service} is ${s.state} on the host: ${effect}`);
      }
    } else failures.push(`services: ${errMessage(services.reason)}`);

    if (failures.length === 4 && version.status === 'rejected') throw version.reason;
    const problems = [...notes, ...failures];
    if (problems.length) return { warning: summarize(problems) };
  }

  const specs: [CollectorName, (signal: AbortSignal) => Promise<PollOutcome | void>][] = [
    ['status', status],
    ['rrd', rrd],
    ['guestDetails', guestDetails],
    ['storage', storage],
    ['zfs', zfs],
    ['disks', disks],
    ['tasks', tasks],
    ['backups', backups],
    ['backupJobs', backupJobs],
    ['network', network],
    ['updates', updates],
    ['hostInfo', hostInfo],
  ];
  return specs.map(([name, run]) => ({ name, intervalSec: polling[name], run }));
}
