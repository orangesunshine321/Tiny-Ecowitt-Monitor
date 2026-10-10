/**
 * Proxmox VE service: polls the read-only API (PVEAuditor token) into the Store sections
 * node, guests, storage, zfs, disks, backups, tasks, network — and answers on-demand queries
 * (RRD history, task logs, SMART, ZFS pool detail) for the HTTP layer.
 *
 * Errors thrown by the on-demand methods are PveApiError: `.status` is the HTTP status from Proxmox (or 400 for
 * invalid input, 404 for an unknown guest, 0 for transport failures) and `.message` is human readable.
 */
import type { AppContext, HostHelper, ProxmoxService, RrdTarget } from '../context.js';
import type { GuestType, RrdPoint, SmartReport, TaskLog, Timeframe, ZfsPoolDetail } from '../../shared/types.js';
import { PveApiError, PveClient, pvePath } from './client.js';
import { createCollectors } from './collectors.js';
import { GuestState, NodeState } from './live.js';
import { mapRrd, uiBase, vmResources } from './mapping.js';
import { num } from './parse.js';
import { Poller } from './poller.js';
import { mapSmart, mapTaskLog, mapZfsDetail, parseUpid } from './storageMapping.js';

export { PveApiError } from './client.js';

const TIMEFRAMES: readonly Timeframe[] = ['hour', 'day', 'week', 'month', 'year'];
const DISK_RE = /^\/dev\/[a-zA-Z0-9/]+$/; // the same pattern PVE enforces for disks/smart
const ZPOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;
const MAX_TASK_LOG_LINES = 5000;

function badInput(message: string, path = ''): PveApiError {
  return new PveApiError(message, 400, path, message, 'EINVAL');
}

export function createProxmoxService(ctx: AppContext, deps: { hostHelper: HostHelper }): ProxmoxService {
  const log = ctx.log.child('proxmox');
  const cfg = ctx.config.proxmox;
  const node = cfg.node;

  const client = new PveClient({
    baseUrl: cfg.url,
    tokenId: cfg.tokenId,
    tokenSecret: cfg.tokenSecret ?? '',
    tls: cfg.tls,
    timeoutMs: cfg.timeoutMs,
    onWarning: (msg) => log.warn(msg),
  });
  if (client.configError) log.error(client.configError);

  const nodeState = new NodeState(ctx.store);
  const guestState = new GuestState({ store: ctx.store, node, uiBaseUrl: uiBase(cfg.uiUrl ?? cfg.url) });
  const pollers = createCollectors({ ctx, client, hostHelper: deps.hostHelper, nodeState, guestState, log }).map(
    (spec) => new Poller({ name: spec.name, intervalSec: spec.intervalSec, store: ctx.store, log, run: spec.run }),
  );

  // Inventory (written by the inventory module) contributes guest IPs and OS names: re-merge when it changes.
  const onPatch = (key: string) => {
    if (key === 'inventory') guestState.publish();
  };
  let started = false;

  async function guestType(vmid: number): Promise<GuestType> {
    const known = ctx.store.get('guests').find((g) => g.vmid === vmid);
    if (known) return known.type;
    const vm = vmResources(await client.get('/cluster/resources', { type: 'vm' }), node).find((r) => num(r.vmid) === vmid);
    if (!vm) throw new PveApiError(`guest ${vmid} not found on node ${node}`, 404, '/cluster/resources', undefined, 'ENOENT');
    return vm.type === 'lxc' ? 'lxc' : 'qemu';
  }

  return {
    start() {
      if (started) return;
      started = true;
      ctx.store.on('patch', onPatch);
      for (const p of pollers) p.start();
      log.info(`polling ${cfg.url} (node ${node}, TLS ${client.mode ?? 'misconfigured'})`);
    },

    stop() {
      if (!started) return;
      started = false;
      ctx.store.off('patch', onPatch);
      for (const p of pollers) p.stop();
      void client.close();
    },

    async getRrd(target: RrdTarget, timeframe: Timeframe): Promise<RrdPoint[]> {
      if (!TIMEFRAMES.includes(timeframe)) throw badInput(`invalid timeframe "${String(timeframe)}" (hour|day|week|month|year)`);
      const query = { timeframe, cf: 'AVERAGE' };
      if (target.kind === 'node') {
        return mapRrd(await client.get(pvePath`/nodes/${node}/rrddata`, query), 'node');
      }
      if (!Number.isInteger(target.vmid) || target.vmid <= 0) throw badInput(`invalid vmid "${String(target.vmid)}"`);
      const type = await guestType(target.vmid);
      return mapRrd(await client.get(pvePath`/nodes/${node}/${type}/${target.vmid}/rrddata`, query), type);
    },

    async getTaskLog(upid: string, limit = 500): Promise<TaskLog> {
      const task = typeof upid === 'string' ? parseUpid(upid) : undefined;
      if (!task) throw badInput('invalid UPID');
      const n = Math.min(MAX_TASK_LOG_LINES, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 500)));
      const path = pvePath`/nodes/${task.node}/tasks/${upid}/log`;
      const first = await client.getEnvelope(path, { start: 0, limit: n });
      const total = first.total ?? 0;
      if (total > n) {
        // Long log: return the tail, where the outcome ("TASK ERROR: …") is.
        const tail = await client.getEnvelope(path, { start: total - n, limit: n });
        return mapTaskLog(upid, tail.data, tail.total ?? total);
      }
      return mapTaskLog(upid, first.data, first.total);
    },

    async getSmart(disk: string): Promise<SmartReport> {
      if (typeof disk !== 'string' || !DISK_RE.test(disk) || disk.includes('//')) throw badInput('invalid disk path (expected /dev/…)');
      try {
        const raw = await client.get(pvePath`/nodes/${node}/disks/smart`, { disk }, { timeoutMs: Math.max(cfg.timeoutMs, 30_000) });
        return mapSmart(disk, raw);
      } catch (err) {
        // PVE 8 answers HTTP 500 "Error getting S.M.A.R.T. data: Exit code: N" where PVE 9 returns {health:"UNKNOWN"}.
        if (err instanceof PveApiError && err.status === 500 && /S\.M\.A\.R\.T|smartctl/i.test(err.pveMessage ?? '')) {
          return mapSmart(disk, { health: 'UNKNOWN' });
        }
        throw err;
      }
    },

    async getZfsDetail(name: string): Promise<ZfsPoolDetail> {
      if (typeof name !== 'string' || !ZPOOL_RE.test(name)) throw badInput('invalid ZFS pool name');
      return mapZfsDetail(await client.get(pvePath`/nodes/${node}/disks/zfs/${name}`), name);
    },
  };
}
