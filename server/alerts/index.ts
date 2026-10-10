/**
 * Alert service: evaluates the rules on Store changes (coalesced, ~1 s) and every 60 s (time-based conditions such
 * as "unreachable for 60 s"), writes Store section `alerts`, broadcasts fire/resolve events with store.emitAlert()
 * and pushes them to subscribed devices. State survives restarts in <dataDir>/alerts.json, so a restart neither
 * re-fires active alerts nor forgets which backup tasks were already reported.
 */
import { join } from 'node:path';
import type { AlertService, AppContext } from '../context.js';
import type { Snapshot, SnapshotKey } from '../../shared/types.js';
import { readJson, writeJson } from '../util/jsonstore.js';
import { AlertEngine } from './engine.js';
import { createPushService } from './push.js';
import type { RuleData } from './rules.js';

export const EVAL_DEBOUNCE_MS = 1000;
export const EVAL_TICK_MS = 60_000;
const SAVE_DELAY_MS = 2000;

/** Store sections the rules read. */
const WATCHED: readonly SnapshotKey[] = ['node', 'guests', 'inventory', 'storage', 'zfs', 'disks', 'backups', 'tasks', 'services'];
const WATCHED_SET: ReadonlySet<string> = new Set(WATCHED);

/** Whether a section already holds collected data (the alert service may start after the first polls). */
function populated(key: SnapshotKey, s: Snapshot): boolean {
  switch (key) {
    case 'node':
      return s.node.lastUpdated !== undefined || s.node.error !== undefined;
    case 'inventory':
      return Object.keys(s.inventory).length > 0;
    case 'backups':
      return s.backups.source !== undefined || s.backups.coverage.length > 0 || s.backups.items.length > 0 || s.backups.jobs.length > 0;
    default: {
      const v = s[key];
      return Array.isArray(v) && v.length > 0;
    }
  }
}

export function createAlertService(ctx: AppContext): AlertService {
  const log = ctx.log.child('alerts');
  const { store } = ctx;
  const cfg = ctx.config.alerts;
  const file = join(ctx.dataDir, 'alerts.json');

  const engine = new AlertEngine({
    cooldownMs: cfg.cooldownMinutes * 60_000,
    onRuleError: (kind, err) => log.error(`alert rule ${kind} failed`, { err }),
  });
  const push = createPushService(ctx, { badge: () => engine.activeCount() });
  store.patchMeta({ pushEnabled: push.enabled, vapidPublicKey: push.publicKey() });

  const ready = new Set<SnapshotKey>();
  let started = false;
  let restored = false;
  let evalTimer: NodeJS.Timeout | undefined;
  let wakeTimer: NodeJS.Timeout | undefined;
  let saveTimer: NodeJS.Timeout | undefined;
  let tick: NodeJS.Timeout | undefined;
  let lastSaved = '';

  function save(): void {
    const data = engine.serialize();
    const json = JSON.stringify(data);
    if (json === lastSaved) return;
    try {
      writeJson(file, data);
      lastSaved = json;
    } catch (err) {
      log.error('could not write alerts.json', { err });
    }
  }

  function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      save();
    }, SAVE_DELAY_MS);
    saveTimer.unref?.();
  }

  function publish(): void {
    store.set('alerts', engine.view());
  }

  function evaluate(): void {
    if (!started) return;
    const data: RuleData = {
      node: store.get('node'),
      guests: store.get('guests'),
      inventory: store.get('inventory'),
      storage: store.get('storage'),
      zfs: store.get('zfs'),
      disks: store.get('disks'),
      backups: store.get('backups'),
      tasks: store.get('tasks'),
      services: store.get('services'),
    };
    let res;
    try {
      res = engine.evaluate({ now: Date.now(), rules: cfg.rules, data, ready: (k) => ready.has(k) });
    } catch (err) {
      log.error('alert evaluation failed', { err });
      return;
    }
    if (res.changed) publish();
    scheduleWake(res.wakeAt);
    // rule memory (seen tasks, running guests, timers) may change without visible alert changes
    scheduleSave();
    for (const ev of res.emitted) {
      if (!ev.resolved) log.info(`alert: ${ev.title}`, { key: ev.key, severity: ev.severity });
      else log.info(`resolved: ${ev.title}`, { key: ev.key });
      store.emitAlert(ev);
    }
    const badge = engine.activeCount();
    for (const n of res.notifications) {
      push.notify(n.event, { recovery: n.recovery, badge }).catch((err) => log.error('push delivery failed', { err }));
    }
  }

  /** One-off evaluation when a pending condition (e.g. "unreachable for 60 s") becomes due. */
  function scheduleWake(at: number | undefined): void {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    if (at === undefined || !started) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      evaluate();
    }, Math.max(0, at - Date.now()) + 50);
    wakeTimer.unref?.();
  }

  function scheduleEval(): void {
    if (evalTimer || !started) return;
    evalTimer = setTimeout(() => {
      evalTimer = undefined;
      evaluate();
    }, EVAL_DEBOUNCE_MS);
    evalTimer.unref?.();
  }

  const onPatch = (key: SnapshotKey): void => {
    if (!WATCHED_SET.has(key)) return;
    ready.add(key);
    scheduleEval();
  };

  return {
    push,

    start() {
      if (started) return;
      started = true;
      if (!restored) {
        restored = true;
        engine.restore(readJson<unknown>(file, null));
        lastSaved = JSON.stringify(engine.serialize());
      }
      const snap = store.snapshot();
      for (const key of WATCHED) if (populated(key, snap)) ready.add(key);
      store.on('patch', onPatch);
      publish();
      scheduleEval();
      tick = setInterval(evaluate, EVAL_TICK_MS);
      tick.unref?.();
    },

    stop() {
      if (!started) return;
      started = false;
      store.off('patch', onPatch);
      for (const t of [evalTimer, wakeTimer, saveTimer]) if (t) clearTimeout(t);
      if (tick) clearInterval(tick);
      evalTimer = wakeTimer = saveTimer = tick = undefined;
      save();
      push.flush();
    },
  };
}
