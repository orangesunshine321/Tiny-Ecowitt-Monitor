import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../server/config.js';
import { AlertEngine, RECENT_MAX } from '../server/alerts/engine.js';
import type { Condition, Rule, RuleData, RuleKind } from '../server/alerts/rules.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const cfgRules = ConfigSchema.parse({ proxmox: { url: 'https://h:8006', tokenId: 'a@pve!b', tokenSecret: 'x' } }).alerts.rules;
const emptyData = {} as RuleData; // the scripted rules below don't read data

/** A scripted rule: returns whatever `state.conds` / `state.carry` hold at evaluation time. */
function scripted(kind: RuleKind) {
  const state: { conds: Condition[]; carry?: boolean; throws?: boolean; sinceKey?: string; silent?: string[]; carryPrefixes?: string[] } = { conds: [] };
  const rule: Rule = (c) => {
    if (state.throws) throw new Error('boom');
    if (state.sinceKey) c.since(state.sinceKey);
    return { conditions: state.conds, carryAll: state.carry, silentResolve: state.silent, carryPrefixes: state.carryPrefixes };
  };
  return { state, rule };
}

const cond = (key: string, over: Partial<Condition> = {}): Condition => ({
  key: `service_down:${key}`,
  kind: 'service_down',
  severity: 'warning',
  title: `${key} is down`,
  body: 'HTTP 502',
  path: '/services',
  ...over,
});

function setup(cooldownMin = 30) {
  const s = scripted('service_down');
  let n = 0;
  const errors: string[] = [];
  const engine = new AlertEngine({
    cooldownMs: cooldownMin * MIN,
    rules: [['service_down', s.rule]],
    newId: () => `id${++n}`,
    onRuleError: (kind) => errors.push(kind),
  });
  const run = (now: number) => engine.evaluate({ now, rules: cfgRules, data: emptyData, ready: () => true });
  return { s, engine, run, errors };
}

describe('AlertEngine', () => {
  it('fires once, updates text in place without re-notifying, resolves with a recovery', () => {
    const { s, engine, run } = setup();
    s.state.conds = [cond('jf')];
    const fired = run(T0);
    expect(fired.emitted).toEqual([
      { id: 'id1', key: 'service_down:jf', kind: 'service_down', severity: 'warning', title: 'jf is down', body: 'HTTP 502', path: '/services', time: T0, resolved: false },
    ]);
    expect(fired.notifications).toEqual([{ event: fired.emitted[0], recovery: false }]);
    expect(run(T0 + MIN)).toEqual({ emitted: [], notifications: [], changed: false });

    s.state.conds = [cond('jf', { body: 'HTTP 503' })];
    const upd = run(T0 + 2 * MIN);
    expect(upd).toMatchObject({ changed: true, emitted: [], notifications: [] });
    expect(engine.view().active[0]).toMatchObject({ id: 'id1', body: 'HTTP 503', time: T0 });
    expect(engine.view().recent[0]).toMatchObject({ id: 'id1', body: 'HTTP 503' });

    s.state.conds = [];
    const res = run(T0 + 3 * MIN);
    expect(res.emitted).toEqual([expect.objectContaining({ id: 'id1', resolved: true, resolvedAt: T0 + 3 * MIN })]);
    expect(res.notifications).toEqual([{ event: res.emitted[0], recovery: true }]);
    expect(engine.view()).toEqual({ active: [], recent: [expect.objectContaining({ id: 'id1', resolved: true })] });
  });

  it('cooldown: a re-fire inside the window is recorded but not pushed, and neither is its recovery', () => {
    const { s, engine, run } = setup(30);
    s.state.conds = [cond('jf')];
    expect(run(T0).notifications).toHaveLength(1);
    s.state.conds = [];
    expect(run(T0 + MIN).notifications).toHaveLength(1); // recovery of a pushed alert
    s.state.conds = [cond('jf')];
    const again = run(T0 + 5 * MIN);
    expect(again.emitted).toHaveLength(1); // still shown in the app
    expect(again.notifications).toEqual([]);
    s.state.conds = [];
    const quietRecovery = run(T0 + 6 * MIN);
    expect(quietRecovery.emitted).toHaveLength(1);
    expect(quietRecovery.notifications).toEqual([]);
    // after the cooldown it is pushed again
    s.state.conds = [cond('jf')];
    expect(run(T0 + 31 * MIN).notifications).toHaveLength(1);
    expect(engine.view().recent.map((e) => e.id)).toEqual(['id3', 'id2', 'id1']);
  });

  it('pushes an escalation even inside the cooldown, but not a de-escalation or a re-escalation', () => {
    const { s, run } = setup();
    s.state.conds = [cond('disk', { severity: 'warning' })];
    run(T0);
    s.state.conds = [cond('disk', { severity: 'critical' })];
    const esc = run(T0 + MIN);
    expect(esc.notifications).toEqual([{ event: expect.objectContaining({ severity: 'critical', id: 'id1' }), recovery: false }]);
    expect(esc.emitted).toHaveLength(1);
    s.state.conds = [cond('disk', { severity: 'warning' })];
    expect(run(T0 + 2 * MIN).notifications).toEqual([]);
    s.state.conds = [cond('disk', { severity: 'critical' })];
    expect(run(T0 + 3 * MIN).notifications).toEqual([]);
  });

  it('an escalation of an alert whose fire was suppressed by the cooldown is pushed', () => {
    const { s, run } = setup();
    s.state.conds = [cond('x')];
    run(T0);
    s.state.conds = [];
    run(T0 + MIN);
    s.state.conds = [cond('x')];
    expect(run(T0 + 2 * MIN).notifications).toEqual([]);
    s.state.conds = [cond('x', { severity: 'critical' })];
    expect(run(T0 + 3 * MIN).notifications).toHaveLength(1);
  });

  it('carry keeps active alerts; a throwing rule carries too', () => {
    const { s, engine, run, errors } = setup();
    s.state.conds = [cond('a'), cond('b')];
    run(T0);
    s.state.conds = [];
    s.state.carry = true;
    expect(run(T0 + MIN).emitted).toEqual([]);
    s.state.carry = false;
    s.state.throws = true;
    expect(run(T0 + 2 * MIN).emitted).toEqual([]);
    expect(errors).toEqual(['service_down']);
    expect(engine.activeCount()).toBe(2);
  });

  it('restores active alerts without re-firing; resolution after restart still sends the recovery', () => {
    const a = setup();
    a.s.state.conds = [cond('jf')];
    a.run(T0);
    const saved = JSON.parse(JSON.stringify(a.engine.serialize()));

    const b = setup();
    b.engine.restore(saved);
    b.s.state.conds = [cond('jf')];
    expect(b.run(T0 + 10 * MIN)).toEqual({ emitted: [], notifications: [], changed: false });
    expect(b.engine.view().active).toEqual([expect.objectContaining({ id: 'id1', time: T0 })]);
    b.s.state.conds = [];
    const res = b.run(T0 + 11 * MIN);
    expect(res.notifications).toEqual([{ event: expect.objectContaining({ id: 'id1', resolved: true }), recovery: true }]);
    // the cooldown survives the restart too
    b.s.state.conds = [cond('jf')];
    expect(b.run(T0 + 12 * MIN).notifications).toEqual([]);
  });

  it('resolves active alerts of kinds no rule handles any more', () => {
    const a = setup();
    a.s.state.conds = [cond('jf')];
    a.run(T0);
    const saved = JSON.parse(JSON.stringify(a.engine.serialize()));
    const other = scripted('zfs_degraded');
    const engine = new AlertEngine({ cooldownMs: 0, rules: [['zfs_degraded', other.rule]] });
    engine.restore(saved);
    const res = engine.evaluate({ now: T0 + MIN, rules: cfgRules, data: emptyData, ready: () => true });
    expect(res.emitted).toEqual([expect.objectContaining({ key: 'service_down:jf', resolved: true })]);
  });

  it('first-seen timestamps are kept while touched and forgotten afterwards', () => {
    const { s, engine, run } = setup();
    s.state.sinceKey = 'service_down:pending';
    run(T0);
    run(T0 + MIN);
    expect(engine.serialize().since).toEqual({ 'service_down:pending': T0 });
    s.state.sinceKey = undefined;
    run(T0 + 2 * MIN);
    expect(engine.serialize().since).toEqual({});
  });

  it('reports the earliest wake-up time requested by rules', () => {
    const rule: Rule = (c) => {
      c.wakeAt(c.now + 5000);
      c.wakeAt(c.now + 2000);
      c.wakeAt(c.now - 1); // past: ignored
      return { conditions: [] };
    };
    const engine = new AlertEngine({ cooldownMs: 0, rules: [['node_unreachable', rule]] });
    expect(engine.evaluate({ now: T0, rules: cfgRules, data: emptyData, ready: () => true }).wakeAt).toBe(T0 + 2000);
  });

  it('keeps at most RECENT_MAX history entries, newest first', () => {
    const { s, engine, run } = setup(0);
    for (let i = 0; i < RECENT_MAX + 20; i++) {
      s.state.conds = [cond(`s${i}`)];
      run(T0 + i * 1000);
    }
    const { recent, active } = engine.view();
    expect(recent).toHaveLength(RECENT_MAX);
    expect(recent[0]!.key).toBe(`service_down:s${RECENT_MAX + 19}`);
    expect(active).toHaveLength(1);
  });

  it('sorts active alerts by severity, then newest first', () => {
    const { s, engine, run } = setup();
    s.state.conds = [cond('a', { severity: 'warning' })];
    run(T0);
    s.state.conds = [cond('a', { severity: 'warning' }), cond('b', { severity: 'info' }), cond('c', { severity: 'critical' })];
    run(T0 + MIN);
    s.state.conds.push(cond('d', { severity: 'warning' }));
    run(T0 + 2 * MIN);
    expect(engine.view().active.map((e) => e.key)).toEqual(['service_down:c', 'service_down:d', 'service_down:a', 'service_down:b']);
  });

  it('restore tolerates garbage', () => {
    const { engine } = setup();
    engine.restore({ active: [{ event: { id: 1 } }, null], recent: 'x', since: { a: 'b', c: 5 }, seenUpids: [1, 'u'], backupIssues: [{}] });
    expect(engine.view()).toEqual({ active: [], recent: [] });
    expect(engine.serialize()).toMatchObject({ since: { c: 5 }, seenUpids: ['u'], backupIssues: [] });
    engine.restore(null);
    engine.restore('nope');
  });
});

describe('AlertEngine: quiet alerts and silent resolutions', () => {
  it('a quiet condition is shown but never pushed, nor is its resolution', () => {
    const { s, engine, run } = setup();
    s.state.conds = [cond('dev', { severity: 'info', quiet: true })];
    const fired = run(T0);
    expect(fired.emitted).toHaveLength(1);
    expect(fired.notifications).toEqual([]);
    s.state.conds = [];
    const resolved = run(T0 + MIN);
    expect(resolved.emitted).toEqual([expect.objectContaining({ resolved: true })]);
    expect(resolved.notifications).toEqual([]);
    expect(engine.view().active).toEqual([]);
  });

  it('a quiet alert that turns into a real one (warning) is pushed then', () => {
    const { s, run } = setup();
    s.state.conds = [cond('dev', { severity: 'info', quiet: true })];
    run(T0);
    s.state.conds = [cond('dev', { severity: 'warning' })];
    expect(run(T0 + MIN).notifications).toEqual([{ event: expect.objectContaining({ severity: 'warning' }), recovery: false }]);
    s.state.conds = [];
    expect(run(T0 + 2 * MIN).notifications).toEqual([expect.objectContaining({ recovery: true })]);
  });

  it('silentResolve resolves without a recovery push, even inside a carried prefix', () => {
    const { s, run } = setup();
    s.state.conds = [cond('a'), cond('b')];
    run(T0);
    s.state.conds = [];
    s.state.carryPrefixes = ['service_down:'];
    s.state.silent = ['service_down:b'];
    const r = run(T0 + MIN);
    expect(r.emitted).toEqual([expect.objectContaining({ key: 'service_down:b', resolved: true })]);
    expect(r.notifications).toEqual([]);
  });

  it('quiet survives a restart', () => {
    const a = setup();
    a.s.state.conds = [cond('dev', { severity: 'info', quiet: true })];
    a.run(T0);
    const b = setup();
    b.engine.restore(JSON.parse(JSON.stringify(a.engine.serialize())));
    b.s.state.conds = [];
    expect(b.run(T0 + MIN).notifications).toEqual([]);
  });
});

describe('AlertEngine: acknowledge (snooze)', () => {
  it('snoozes by id or key; a snoozed alert is not re-pushed and resolves without a recovery push', () => {
    const { s, engine, run } = setup(0); // no cooldown: only the snooze holds pushes back
    s.state.conds = [cond('jf')];
    run(T0);
    const ev = engine.acknowledge('id1', undefined, T0 + MIN);
    expect(ev).toMatchObject({ id: 'id1', acknowledged: { at: T0 + MIN } });
    expect(ev!.acknowledged!.until).toBeUndefined();
    expect(engine.view().active[0]!.acknowledged).toEqual({ at: T0 + MIN });
    expect(engine.view().recent[0]!.acknowledged).toEqual({ at: T0 + MIN });
    expect(engine.acknowledge('service_down:jf', 2, T0 + MIN)!.acknowledged).toEqual({ at: T0 + MIN, until: T0 + MIN + 2 * 3600_000 });
    expect(engine.acknowledge('nope', 1, T0)).toBeUndefined();
    engine.acknowledge('id1', undefined, T0 + MIN);
    s.state.conds = [cond('jf', { body: 'HTTP 504' })];
    expect(run(T0 + 2 * MIN).notifications).toEqual([]);
    s.state.conds = [];
    const res = run(T0 + 3 * MIN);
    expect(res.emitted).toEqual([expect.objectContaining({ resolved: true })]);
    expect(res.emitted[0]!.acknowledged).toBeUndefined(); // it clears with the resolution
    expect(res.notifications).toEqual([]);
    // the next occurrence is a new alert, not snoozed, pushed as usual
    s.state.conds = [cond('jf')];
    expect(run(T0 + 4 * MIN).notifications).toHaveLength(1);
    expect(engine.view().active[0]!.acknowledged).toBeUndefined();
  });

  it('a severity increase is pushed and ends the snooze', () => {
    const { s, engine, run } = setup();
    s.state.conds = [cond('disk', { severity: 'warning' })];
    run(T0);
    engine.acknowledge('id1', 24, T0 + MIN);
    s.state.conds = [cond('disk', { severity: 'critical' })];
    const esc = run(T0 + 2 * MIN);
    expect(esc.notifications).toEqual([{ event: expect.objectContaining({ severity: 'critical' }), recovery: false }]);
    expect(engine.view().active[0]!.acknowledged).toBeUndefined();
  });

  it('a timed snooze runs out with a reminder push and asks for a wake-up at its end', () => {
    const { s, engine, run } = setup();
    s.state.conds = [cond('jf')];
    run(T0);
    engine.acknowledge('id1', 1, T0 + MIN);
    const during = run(T0 + 30 * MIN);
    expect(during.notifications).toEqual([]);
    expect(during.wakeAt).toBe(T0 + MIN + 3600_000);
    const after = run(T0 + MIN + 3600_000);
    expect(after.changed).toBe(true);
    expect(after.notifications).toEqual([{ event: expect.objectContaining({ id: 'id1' }), recovery: false }]);
    expect(engine.view().active[0]!.acknowledged).toBeUndefined();
  });

  it('unacknowledge lifts it; invalid durations are refused with 400', () => {
    const { s, engine, run } = setup();
    s.state.conds = [cond('jf')];
    run(T0);
    engine.acknowledge('id1', undefined, T0);
    expect(engine.unacknowledge('id1')!.acknowledged).toBeUndefined();
    expect(engine.unacknowledge('nope')).toBeUndefined();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 24 * 400]) {
      expect(() => engine.acknowledge('id1', bad, T0)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('a snooze survives a restart; garbage in the file is dropped', () => {
    const a = setup();
    a.s.state.conds = [cond('jf')];
    a.run(T0);
    a.engine.acknowledge('id1', 8, T0 + MIN);
    const saved = JSON.parse(JSON.stringify(a.engine.serialize()));
    const b = setup();
    b.engine.restore(saved);
    expect(b.engine.view().active[0]!.acknowledged).toEqual({ at: T0 + MIN, until: T0 + MIN + 8 * 3600_000 });
    saved.active[0].event.acknowledged = { at: 'yesterday' };
    const c = setup();
    c.engine.restore(saved);
    expect(c.engine.view().active[0]!.acknowledged).toBeUndefined();
  });
});
