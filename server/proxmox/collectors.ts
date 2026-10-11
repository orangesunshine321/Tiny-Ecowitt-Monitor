/**
 * One collector per Store section / polling interval (config.polling). Each `run` performs the API calls, maps the
 * result with the pure functions in mapping.ts / storageMapping.ts / hostMapping.ts and publishes it. Scheduling,
 * backoff and freshness reporting are handled by Poller (poller.ts).
 *
 * Read-only by construction: only GET requests, and never endpoints that need write privileges
 * (e.g. /apt/update needs Sys.Modify; backup content needs VM.Backup — both come from the SSH host helper instead).
 */
import type { Config } from '../config.js';
import type { AppContext, HostHelper, Logger } from '../context.js';
import type { BackupItem, GuestType, Pressure } from '../../shared/types.js';
import { PveApiError, pvePath, type PveClient } from './client.js';
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
  computeCoverage,
  lastBackups,
  mapBackupContent,
  mapBackupJobs,
  mapDisks,
  mapNotBackedUp,
  mapPruneBackups,
  mapStorage,
  mapTasks,
  mapZfsPools,
  sortBackups,
} from './storageMapping.js';
import { mapAptVersions, mapHostServices, mapNetwork, mapPkgUpdates, mapSubscription, mapVersion, pickCertificate } from './hostMapping.js';
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
  /** clock for the SMART cadence and the backups startup grace (tests); default Date.now */
  now?: () => number;
}

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

function summarize(problems: string[], max = 4): string {
  const shown = problems.slice(0, max).join('; ');
  return problems.length > max ? `${shown}; +${problems.length - max} more` : shown;
}

/** Identity of a disks/list row across listings (devpath can move after a reboot; serial may be "unknown"). */
function diskKey(r: Record<string, unknown>): string {
  return `${str(r.devpath) ?? ''}|${str(r.serial) ?? ''}`;
}

export function createCollectors(d: CollectorDeps): CollectorSpec[] {
  const { ctx, client, hostHelper, nodeState, guestState, log } = d;
  const clock = d.now ?? Date.now;
  const { store } = ctx;
  const node = ctx.config.proxmox.node;
  const polling = ctx.config.polling;
  const timeoutMs = ctx.config.proxmox.timeoutMs;
  const slow = (min: number) => Math.max(timeoutMs, min);

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
      nodeState.updateStatus(mapNodeStatus(node, st, findNodeResource(resources, node), now), now);
      guestState.updateResources(vmResources(resources, node), now);
    } catch (err) {
      if (!signal.aborted) nodeState.markOffline(errMessage(err));
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

  // ── storage / zfs / disks / tasks / network

  async function storage(signal: AbortSignal): Promise<void> {
    store.set('storage', mapStorage(await client.get(pvePath`/nodes/${node}/storage`, undefined, { signal })));
  }

  async function zfs(signal: AbortSignal): Promise<void> {
    try {
      store.set('zfs', mapZfsPools(await client.get(pvePath`/nodes/${node}/disks/zfs`, undefined, { signal })));
    } catch (err) {
      // A host without ZFS answers "zfsutils-linux not installed": that is an empty list, not an outage.
      if (err instanceof PveApiError && /not installed/i.test(err.pveMessage ?? '')) {
        if (!zfsMissingLogged) log.info('zfsutils-linux is not installed on the node; no ZFS pools to show');
        zfsMissingLogged = true;
        store.set('zfs', []);
        return;
      }
      throw err;
    }
  }

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

  async function tasks(signal: AbortSignal): Promise<void> {
    // source=all includes running tasks (status "RUNNING", no endtime).
    store.set('tasks', mapTasks(await client.get(pvePath`/nodes/${node}/tasks`, { source: 'all', limit: 200 }, { signal })));
  }

  async function network(signal: AbortSignal): Promise<void> {
    store.set('network', mapNetwork(await client.get(pvePath`/nodes/${node}/network`, undefined, { signal })));
  }

  // ── backups (300 s) + backupJobs (600 s)

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
    const storages = records(await client.get(pvePath`/nodes/${node}/storage`, { content: 'backup' }, { signal })).filter(
      (s) => str(s.storage) && bool(s.enabled) !== false,
    );
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
      const id = str(s.storage)!;
      if (bool(s.active) === false) {
        // PVE reports active=0 when activating the storage or its status() failed: PBS or the NFS server is not
        // reachable (pve-api-storage.md §1a). Listing it would only fail or hang; its backups have not gone away.
        problems.push(`${id}: storage is inactive (unreachable?)`);
        keepPrevious(id);
        continue;
      }
      try {
        byStorage.set(id, await listBackupsOf(id, signal));
      } catch (err) {
        if (signal.aborted) throw err;
        problems.push(`${id}: ${errMessage(err)}`);
        keepPrevious(id);
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

    const items = sortBackups([...byStorage.values()].flatMap((v) => v.items));
    const vias = [...byStorage.values()].map((v) => v.via);
    const source: 'ssh' | 'prunebackups' | undefined = vias.length === 0 ? undefined : vias.every((v) => v === 'ssh') ? 'ssh' : 'prunebackups';

    const guests = (await currentVms(signal)).map((vm) => ({
      vmid: num(vm.vmid)!,
      name: str(vm.name) ?? `${vm.type === 'lxc' ? 'CT' : 'VM'} ${num(vm.vmid)}`,
      type: (vm.type === 'lxc' ? 'lxc' : 'qemu') as GuestType,
      template: bool(vm.template) ?? false,
    }));
    const coverage = computeCoverage({
      guests,
      items,
      notBackedUp: lastNotBackedUp,
      staleDays: ctx.config.alerts.rules.backupStale.days,
      now: clock(),
    });
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
    const jobs = mapBackupJobs(await client.get('/cluster/backup', undefined, { signal }));
    store.update('backups', (b) => ({ ...b, jobs }));
  }

  // ── updates (3600 s)

  async function updates(signal: AbortSignal): Promise<void> {
    if (hostHelper.available()) {
      try {
        const raw = await hostHelper.pkgUpdates();
        if (raw) {
          nodeState.setExtras({ updates: mapPkgUpdates(raw), updatesSource: 'ssh' });
          return;
        }
      } catch (err) {
        log.debug('host helper pkgupdates failed; using /apt/versions', { err: errMessage(err) });
      }
    }
    // Never /apt/update (needs Sys.Modify). /apt/versions covers Proxmox packages only.
    const raw = await client.get(pvePath`/nodes/${node}/apt/versions`, undefined, { signal, timeoutMs: slow(30_000) });
    nodeState.setExtras({ updates: mapAptVersions(raw), updatesSource: 'apt-versions' });
  }

  // ── hostInfo (3600 s): version, subscription, certificate, host services

  async function hostInfo(signal: AbortSignal): Promise<PollOutcome | void> {
    const [version, subscription, certs, services] = await Promise.allSettled([
      client.get('/version', undefined, { signal }),
      client.get(pvePath`/nodes/${node}/subscription`, undefined, { signal }),
      client.get(pvePath`/nodes/${node}/certificates/info`, undefined, { signal }),
      client.get(pvePath`/nodes/${node}/services`, undefined, { signal, timeoutMs: slow(30_000) }),
    ]);
    const problems: string[] = [];
    if (version.status === 'fulfilled') {
      const v = mapVersion(version.value);
      nodeState.setExtras({ pveVersion: v.version, pveRelease: v.release, pveRepoId: v.repoid });
      guestState.setDatacenterConsole(v.console);
    } else problems.push(`version: ${errMessage(version.reason)}`);
    if (subscription.status === 'fulfilled') nodeState.setExtras({ subscription: mapSubscription(subscription.value) });
    else problems.push(`subscription: ${errMessage(subscription.reason)}`);
    if (certs.status === 'fulfilled') nodeState.setExtras({ certificate: pickCertificate(certs.value) });
    else problems.push(`certificates: ${errMessage(certs.reason)}`);
    if (services.status === 'fulfilled') nodeState.setExtras({ hostServices: mapHostServices(services.value) });
    else problems.push(`services: ${errMessage(services.reason)}`);

    if (problems.length === 4 && version.status === 'rejected') throw version.reason;
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
