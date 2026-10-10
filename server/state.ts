import { EventEmitter } from 'node:events';
import type { AlertEvent, CollectorStatus, Snapshot, SnapshotKey, SnapshotMeta } from '../shared/types.js';

/**
 * Central in-memory state. Collectors write whole sections with `set()`; the HTTP layer streams a full snapshot on
 * connect and then `patch` events per changed section.
 *
 * Events:
 *  - 'patch'  (key: SnapshotKey, value)   a section changed
 *  - 'alert'  (event: AlertEvent)         an alert fired or resolved (for live in-app toasts)
 */
export class Store extends EventEmitter {
  private snap: Snapshot;
  private hashes = new Map<SnapshotKey, string>();
  private collectors = new Map<string, CollectorStatus>();

  constructor(meta: Omit<SnapshotMeta, 'serverTime' | 'collectors'>, nodeName: string) {
    super();
    this.setMaxListeners(500);
    this.snap = {
      meta: { ...meta, serverTime: Date.now(), collectors: [] },
      node: {
        node: nodeName,
        online: false,
        cpu: 0,
        loadAvg: [0, 0, 0],
        memTotal: 0,
        memUsed: 0,
        swapTotal: 0,
        swapUsed: 0,
        rootTotal: 0,
        rootUsed: 0,
        uptime: 0,
        history: { t: [], cpu: [], mem: [], netIn: [], netOut: [] },
      },
      guests: [],
      inventory: {},
      storage: [],
      zfs: [],
      disks: [],
      backups: { items: [], jobs: [], coverage: [] },
      tasks: [],
      network: [],
      services: [],
      alerts: { active: [], recent: [] },
    };
  }

  /** Full snapshot (meta.serverTime and collectors refreshed). Treat as read-only. */
  snapshot(): Snapshot {
    this.snap.meta = { ...this.snap.meta, serverTime: Date.now(), collectors: this.collectorStatus() };
    return this.snap;
  }

  get<K extends SnapshotKey>(key: K): Snapshot[K] {
    return this.snap[key];
  }

  /** Replace a section. Emits 'patch' only if the JSON content actually changed. */
  set<K extends SnapshotKey>(key: K, value: Snapshot[K]): void {
    const json = JSON.stringify(value);
    if (this.hashes.get(key) === json) return;
    this.hashes.set(key, json);
    this.snap[key] = value;
    this.emit('patch', key, value);
  }

  /** Read-modify-write helper for a section. */
  update<K extends SnapshotKey>(key: K, fn: (current: Snapshot[K]) => Snapshot[K]): void {
    this.set(key, fn(this.snap[key]));
  }

  /** Merge fields into meta (e.g. vapidPublicKey once push is initialised). */
  patchMeta(partial: Partial<SnapshotMeta>): void {
    this.set('meta', { ...this.snap.meta, ...partial });
  }

  emitAlert(event: AlertEvent): void {
    this.emit('alert', event);
  }

  /** Collectors report health so the UI can show data freshness per source. */
  collectorOk(name: string, intervalSec: number): void {
    const prev = this.collectors.get(name);
    this.collectors.set(name, { ...prev, name, intervalSec, lastSuccess: Date.now() });
  }

  collectorError(name: string, intervalSec: number, error: unknown): void {
    const prev = this.collectors.get(name);
    this.collectors.set(name, {
      ...prev,
      name,
      intervalSec,
      lastError: error instanceof Error ? error.message : String(error),
      lastErrorAt: Date.now(),
    });
  }

  collectorStatus(): CollectorStatus[] {
    return [...this.collectors.values()];
  }
}
