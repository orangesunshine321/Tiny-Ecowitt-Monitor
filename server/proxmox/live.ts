/**
 * Stateful assembly of the `node` and `guests` Store sections. Several collectors contribute to each section
 * (status every 5 s; rrd, hostInfo, updates, guestDetails, backups less often), so every write goes through these
 * classes, which merge the latest contribution of each source and publish the whole section.
 */
import type { Guest, NodeSummary, Pressure } from '../../shared/types.js';
import type { Store } from '../state.js';
import {
  advanceRates,
  buildGuest,
  counterSample,
  hasLiveProcess,
  HISTORY_SAMPLES,
  normalizeGuestStatus,
  type GuestDetails,
  type NodeBase,
  type RateState,
} from './mapping.js';
import { num, numOr, pushRing, round } from './parse.js';

type NodeExtras = Partial<
  Pick<
    NodeSummary,
    | 'pveVersion'
    | 'pveRelease'
    | 'pveRepoId'
    | 'netIn'
    | 'netOut'
    | 'ioWait'
    | 'pressure'
    | 'arcSize'
    | 'subscription'
    | 'updates'
    | 'updatesSource'
    | 'hostServices'
    | 'certificate'
  >
>;

export class NodeState {
  private base: NodeBase | undefined;
  private extras: NodeExtras = {};
  private history: NodeSummary['history'] = { t: [], cpu: [], mem: [], netIn: [], netOut: [] };

  constructor(private readonly store: Store) {}

  /** A successful status poll: new base values + one history sample. */
  updateStatus(base: NodeBase, now: number): void {
    this.base = base;
    const h = this.history;
    this.history = {
      t: pushRing(h.t, now, HISTORY_SAMPLES),
      cpu: pushRing(h.cpu, round(base.cpu, 4), HISTORY_SAMPLES),
      mem: pushRing(h.mem, base.memUsed, HISTORY_SAMPLES),
      // Host NIC rates only exist in the node RRD (1-minute averages); the ring repeats the latest one.
      netIn: pushRing(h.netIn, round(this.extras.netIn ?? 0, 1), HISTORY_SAMPLES),
      netOut: pushRing(h.netOut, round(this.extras.netOut ?? 0, 1), HISTORY_SAMPLES),
    };
    this.publish();
  }

  /** The status poll failed: keep the last values, flag the node offline. */
  markOffline(error: string): void {
    const { history: _h, ...current } = this.store.get('node');
    this.base = { ...(this.base ?? current), online: false, error };
    this.publish();
  }

  /** Merge contributions of the slower collectors. Undefined values never erase earlier data. */
  setExtras(partial: NodeExtras): void {
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined) (this.extras as Record<string, unknown>)[k] = v;
    }
    this.publish();
  }

  /** PVE major version if known (from /version or the status pveversion string). */
  pveMajor(): number | undefined {
    const v = this.extras.pveVersion ?? this.base?.pveVersion;
    const m = v ? /^(\d+)\./.exec(v) : null;
    return m ? Number(m[1]) : undefined;
  }

  private publish(): void {
    const { history: _h, ...current } = this.store.get('node');
    this.store.set('node', { ...(this.base ?? current), ...this.extras, history: this.history });
  }
}

export class GuestState {
  private raw: Record<string, unknown>[] | undefined;
  private rates = new Map<number, RateState>();
  private history = new Map<number, Guest['history']>();
  private details = new Map<number, GuestDetails>();
  private pressure = new Map<number, Pressure>();
  private backups = new Map<number, NonNullable<Guest['lastBackup']>>();
  private datacenterConsole: string | undefined;

  constructor(private readonly deps: { store: Store; node: string; uiBaseUrl: string }) {}

  /** Last /cluster/resources vm entries on this node (undefined until the first successful status poll). */
  resources(): readonly Record<string, unknown>[] | undefined {
    return this.raw;
  }

  detailsSnapshot(): ReadonlyMap<number, GuestDetails> {
    return this.details;
  }

  /** A successful status poll: advance rate counters and history rings, then publish. */
  updateResources(vms: Record<string, unknown>[], now: number): void {
    const seen = new Set<number>();
    for (const vm of vms) {
      const vmid = num(vm.vmid)!;
      seen.add(vmid);
      this.rates.set(vmid, advanceRates(this.rates.get(vmid), counterSample(vm, now)));
      const status = normalizeGuestStatus(vm.status);
      const running = status === 'running';
      const h = this.history.get(vmid) ?? { t: [], cpu: [], mem: [] };
      this.history.set(vmid, {
        t: pushRing(h.t, now, HISTORY_SAMPLES),
        cpu: pushRing(h.cpu, running ? round(numOr(vm.cpu, 0), 4) : 0, HISTORY_SAMPLES),
        // a paused/suspended VM still holds its memory (see hasLiveProcess)
        mem: pushRing(h.mem, hasLiveProcess(status) ? numOr(vm.mem, 0) : 0, HISTORY_SAMPLES),
      });
    }
    for (const map of [this.rates, this.history] as Map<number, unknown>[]) {
      for (const vmid of map.keys()) if (!seen.has(vmid)) map.delete(vmid);
    }
    this.raw = vms;
    this.publish();
  }

  setDetails(details: Map<number, GuestDetails>): void {
    this.details = details;
    this.publish();
  }

  setPressure(pressure: Map<number, Pressure>): void {
    this.pressure = pressure;
    this.publish();
  }

  setLastBackups(backups: Map<number, NonNullable<Guest['lastBackup']>>): void {
    this.backups = backups;
    this.publish();
  }

  setDatacenterConsole(console: string | undefined): void {
    if (this.datacenterConsole === console) return;
    this.datacenterConsole = console;
    this.publish();
  }

  /** Rebuild and publish `guests` (also called when the inventory section changes). No-op before the first poll. */
  publish(): void {
    if (!this.raw) return;
    const { store, node, uiBaseUrl } = this.deps;
    const prevById = new Map(store.get('guests').map((g) => [g.vmid, g]));
    const inventory = store.get('inventory');
    const guests = this.raw.map((raw) => {
      const vmid = num(raw.vmid)!;
      return buildGuest({
        raw,
        node,
        uiBaseUrl,
        datacenterConsole: this.datacenterConsole,
        prev: prevById.get(vmid),
        rates: this.rates.get(vmid)?.rates,
        history: this.history.get(vmid),
        details: this.details.get(vmid),
        inventory: inventory[String(vmid)],
        pressure: this.pressure.get(vmid),
        lastBackup: this.backups.get(vmid),
      });
    });
    store.set('guests', guests);
  }
}
