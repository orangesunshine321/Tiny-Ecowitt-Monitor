/**
 * Stateful assembly of the `node` and `guests` Store sections. Several collectors contribute to each section
 * (status every 5 s; rrd, hostInfo, updates, guestDetails, backups less often), so every write goes through these
 * classes, which merge the latest contribution of each source and publish the whole section.
 *
 * History rings: each successful status poll appends one sample to the node ring and to every guest ring. The rings
 * stay in the published sections (for the initial snapshot), and the NEW samples of a tick are returned to the caller,
 * which hands them to store.emitHistory() so the live stream does not resend whole rings (decision 1 of the brief).
 */
import type { Guest, NodeSummary, Pressure } from '../../shared/types.js';
import type { HistoryTick } from '../state.js';
import type { Store } from '../state.js';
import type { ClassifiedPveError } from './client.js';
import { compareKernels } from './hostMapping.js';
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
    | 'updatesCheckedAt'
    | 'hostServices'
    | 'certificate'
  >
>;

export type NodeHistorySample = NonNullable<HistoryTick['node']>;
export type GuestHistorySamples = NonNullable<HistoryTick['guests']>;

/**
 * A failed status poll flips the node to offline only after this many failures in a row, so one dropped connection
 * (a keep-alive race, pveproxy reloading after an update) does not paint the dashboard red. The error is shown at once.
 */
export const OFFLINE_AFTER_FAILURES = 2;
/** …or at once when the last successful poll is older than this (e.g. the failing request itself timed out). */
export const OFFLINE_AFTER_MS = 12_000;

export class NodeState {
  private base: NodeBase | undefined;
  private extras: NodeExtras = {};
  private history: NodeSummary['history'] = { t: [], cpu: [], mem: [], netIn: [], netOut: [] };
  private failures = 0;
  /** newest installed kernel release (apt/versions or the host helper) */
  private installedKernel: string | undefined;

  constructor(private readonly store: Store) {}

  /** A successful status poll: new base values + one history sample, which is returned for the live stream. */
  updateStatus(base: NodeBase, now: number): NodeHistorySample {
    this.base = base;
    this.failures = 0;
    const sample: NodeHistorySample = {
      t: [now],
      cpu: [round(base.cpu, 4)],
      mem: [base.memUsed],
      // Host NIC rates only exist in the node RRD (1-minute averages); the ring repeats the latest one.
      netIn: [round(this.extras.netIn ?? 0, 1)],
      netOut: [round(this.extras.netOut ?? 0, 1)],
    };
    const h = this.history;
    this.history = {
      t: pushRing(h.t, sample.t[0]!, HISTORY_SAMPLES),
      cpu: pushRing(h.cpu, sample.cpu[0]!, HISTORY_SAMPLES),
      mem: pushRing(h.mem, sample.mem[0]!, HISTORY_SAMPLES),
      netIn: pushRing(h.netIn, sample.netIn[0]!, HISTORY_SAMPLES),
      netOut: pushRing(h.netOut, sample.netOut[0]!, HISTORY_SAMPLES),
    };
    this.publish();
    return sample;
  }

  /**
   * The status poll failed: keep the last values and show the classified error. The node turns offline at once for
   * failures that will not go away by themselves (token, permission, TLS), before the first success, or when the last
   * success is older than OFFLINE_AFTER_MS; otherwise only after OFFLINE_AFTER_FAILURES failures in a row.
   */
  markFailure(error: ClassifiedPveError, now: number): void {
    this.failures++;
    const { history: _h, ...current } = this.store.get('node');
    const prev = this.base ?? current;
    const lastOk = prev.lastUpdated;
    const persistent = error.kind === 'auth' || error.kind === 'permission' || error.kind === 'tls';
    const offline =
      persistent || !prev.online || lastOk === undefined || now - lastOk > OFFLINE_AFTER_MS || this.failures >= OFFLINE_AFTER_FAILURES;
    this.base = { ...prev, online: !offline, error: error.message, errorKind: error.kind, errorHint: error.hint };
    this.publish();
  }

  /** Merge contributions of the slower collectors. Undefined values never erase earlier data (see unsetExtras). */
  setExtras(partial: NodeExtras): void {
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined) (this.extras as Record<string, unknown>)[k] = v;
    }
    this.publish();
  }

  /** Remove contributions that no longer apply. */
  unsetExtras(...keys: (keyof NodeExtras)[]): void {
    let changed = false;
    for (const k of keys) {
      if (k in this.extras) {
        delete this.extras[k];
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** The newest installed kernel; with the running kernel from the status poll this yields `rebootRequired`. */
  setInstalledKernel(release: string | undefined): void {
    if (release === this.installedKernel) return;
    this.installedKernel = release;
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
    const node: NodeSummary = { ...(this.base ?? current), ...this.extras, history: this.history };
    delete node.rebootRequired;
    const running = node.kernel;
    if (this.installedKernel && running && /-pve$/.test(running) && compareKernels(this.installedKernel, running) > 0) {
      node.rebootRequired = {
        reason: `Kernel ${this.installedKernel} is installed, but ${running} is still running: reboot the host to use it`,
        installedKernel: this.installedKernel,
      };
    }
    this.store.set('node', node);
  }
}

export interface GuestStateDeps {
  store: Store;
  node: string;
  uiBaseUrl: string;
  /**
   * Longest delay for a publish caused by a slow collector (details, pressure, backups, inventory). Such updates ride
   * along with the next status poll, which publishes anyway, so they cost no extra frame on the live stream; this is
   * the fallback when no status poll comes (node offline). Default 1 s; the service passes the status interval + 1 s.
   */
  deferMs?: number;
}

export class GuestState {
  private raw: Record<string, unknown>[] | undefined;
  private rates = new Map<number, RateState>();
  private history = new Map<number, Guest['history']>();
  private details = new Map<number, GuestDetails>();
  private pressure = new Map<number, Pressure>();
  private backups = new Map<number, NonNullable<Guest['lastBackup']>>();
  private datacenterConsole: string | undefined;
  private deferred: NodeJS.Timeout | undefined;

  constructor(private readonly deps: GuestStateDeps) {}

  /** Last /cluster/resources vm entries on this node (undefined until the first successful status poll). */
  resources(): readonly Record<string, unknown>[] | undefined {
    return this.raw;
  }

  detailsSnapshot(): ReadonlyMap<number, GuestDetails> {
    return this.details;
  }

  /**
   * A successful status poll: advance rate counters and history rings, then publish (at once; this also carries any
   * deferred contribution). Returns the new history samples per vmid for the live stream.
   */
  updateResources(vms: Record<string, unknown>[], now: number): GuestHistorySamples {
    const seen = new Set<number>();
    const samples: GuestHistorySamples = {};
    for (const vm of vms) {
      const vmid = num(vm.vmid)!;
      seen.add(vmid);
      this.rates.set(vmid, advanceRates(this.rates.get(vmid), counterSample(vm, now)));
      const status = normalizeGuestStatus(vm.status);
      const running = status === 'running';
      const cpu = running ? round(numOr(vm.cpu, 0), 4) : 0;
      // a paused/suspended VM still holds its memory (see hasLiveProcess)
      const mem = hasLiveProcess(status) ? numOr(vm.mem, 0) : 0;
      const h = this.history.get(vmid) ?? { t: [], cpu: [], mem: [] };
      this.history.set(vmid, {
        t: pushRing(h.t, now, HISTORY_SAMPLES),
        cpu: pushRing(h.cpu, cpu, HISTORY_SAMPLES),
        mem: pushRing(h.mem, mem, HISTORY_SAMPLES),
      });
      samples[String(vmid)] = { t: [now], cpu: [cpu], mem: [mem] };
    }
    for (const map of [this.rates, this.history] as Map<number, unknown>[]) {
      for (const vmid of map.keys()) if (!seen.has(vmid)) map.delete(vmid);
    }
    this.raw = vms;
    this.publish();
    return samples;
  }

  setDetails(details: Map<number, GuestDetails>): void {
    const first = this.details.size === 0;
    this.details = details;
    this.publishSoon(first && details.size > 0);
  }

  setPressure(pressure: Map<number, Pressure>): void {
    const first = this.pressure.size === 0;
    this.pressure = pressure;
    this.publishSoon(first && pressure.size > 0);
  }

  setLastBackups(backups: Map<number, NonNullable<Guest['lastBackup']>>): void {
    const first = this.backups.size === 0;
    this.backups = backups;
    this.publishSoon(first && backups.size > 0);
  }

  /** The first contribution of a source is shown at once (startup); later ones ride along with the next status poll. */
  private publishSoon(now: boolean): void {
    if (now) this.publish();
    else this.schedulePublish();
  }

  setDatacenterConsole(console: string | undefined): void {
    if (this.datacenterConsole === console) return;
    const first = this.datacenterConsole === undefined;
    this.datacenterConsole = console;
    this.publishSoon(first);
  }

  /** Publish soon (with the next status poll, or after deferMs at the latest). */
  schedulePublish(): void {
    if (this.deferred || !this.raw) return;
    this.deferred = setTimeout(() => {
      this.deferred = undefined;
      this.publish();
    }, this.deps.deferMs ?? 1_000);
    this.deferred.unref?.();
  }

  /** Publish a pending deferred update now (tests, shutdown). */
  flush(): void {
    if (this.deferred) this.publish();
  }

  /** Drop a pending deferred publish (service stop). */
  dispose(): void {
    if (this.deferred) clearTimeout(this.deferred);
    this.deferred = undefined;
  }

  /** Rebuild and publish `guests` now. No-op before the first poll. */
  publish(): void {
    if (this.deferred) clearTimeout(this.deferred);
    this.deferred = undefined;
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
