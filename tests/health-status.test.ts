import { describe, expect, it } from 'vitest';
import {
  applyCheck,
  applyPaused,
  applyResumed,
  BUCKET_MS,
  decodeBuckets,
  decodeHistory,
  encodeBuckets,
  encodeHistory,
  HISTORY_SAMPLES,
  initialState,
  persistState,
  recordUptime,
  restoreState,
  uptime24h,
  type ServiceState,
} from '../server/health/status.js';

const opts = { afterFailures: 2, slowMs: 1500 };
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const ok = (ms = 20) => ({ ok: true, ms });
const fail = (message = 'ECONNREFUSED') => ({ ok: false, message });

function run(steps: { ok: boolean; ms?: number; message?: string }[], start: ServiceState = initialState(), t = T0): ServiceState[] {
  const out: ServiceState[] = [];
  let s = start;
  steps.forEach((r, i) => {
    s = applyCheck(s, r, t + i * 30_000, opts);
    out.push(s);
  });
  return out;
}

describe('status transitions', () => {
  it('starts unknown and becomes up on the first good check', () => {
    expect(initialState().status).toBe('unknown');
    const [s] = run([ok(42)]);
    expect(s).toMatchObject({ status: 'up', latencyMs: 42, failures: 0, lastChecked: T0, lastChange: T0 });
    expect(s!.message).toBeUndefined();
  });

  it('goes down only after afterFailures consecutive failures', () => {
    const states = run([ok(), fail(), fail('HTTP 502'), fail()]);
    expect(states.map((s) => s.status)).toEqual(['up', 'up', 'down', 'down']);
    expect(states[1]).toMatchObject({ failures: 1, message: 'ECONNREFUSED', lastChange: T0 });
    expect(states[2]).toMatchObject({ failures: 2, message: 'HTTP 502', lastChange: T0 + 60_000 });
    expect(states[3]!.lastChange).toBe(T0 + 60_000); // unchanged while staying down
  });

  it('a single failure between successes never makes it down', () => {
    expect(run([ok(), fail(), ok(), fail(), ok()]).map((s) => s.status)).toEqual(['up', 'up', 'up', 'up', 'up']);
  });

  it('stays unknown while failing below the threshold from a fresh start', () => {
    expect(run([fail(), fail()]).map((s) => s.status)).toEqual(['unknown', 'down']);
  });

  it('marks slow when ok but over slowMs, and recovers', () => {
    const states = run([ok(100), ok(1600), ok(90)]);
    expect(states.map((s) => s.status)).toEqual(['up', 'slow', 'up']);
    expect(states[1]!.message).toContain('1500');
    expect(states[1]!.lastChange).toBe(T0 + 30_000);
  });

  it('down → up resets failures and sets lastChange', () => {
    const states = run([fail(), fail(), ok(10)]);
    expect(states[2]).toMatchObject({ status: 'up', failures: 0, lastChange: T0 + 60_000 });
  });

  it('paused while the guest is stopped; resumes as unknown', () => {
    const [up] = run([ok()]);
    const paused = applyPaused(up!, T0 + 1000, 'apps is stopped');
    expect(paused).toMatchObject({ status: 'paused', failures: 0, message: 'apps is stopped', lastChange: T0 + 1000 });
    expect(applyPaused(paused, T0 + 2000, 'apps is stopped')).toBe(paused); // idempotent
    const resumed = applyResumed(paused, T0 + 5000);
    expect(resumed).toMatchObject({ status: 'unknown', lastChange: T0 + 5000 });
    // failing right after resume: not down until the threshold
    const next = applyCheck(resumed, fail(), T0 + 6000, opts);
    expect(next.status).toBe('unknown');
  });

  it('grace (guest just booted): failures are not counted or recorded', () => {
    const [up] = run([ok()]);
    const g = applyCheck(up!, fail(), T0 + 30_000, { ...opts, grace: true });
    expect(g).toMatchObject({ status: 'unknown', failures: 0, message: 'guest starting (ECONNREFUSED)' });
    expect(g.history).toHaveLength(1);
    const back = applyCheck(g, ok(), T0 + 60_000, { ...opts, grace: true });
    expect(back.status).toBe('up');
  });

  it('keeps at most 90 history samples, oldest first', () => {
    let s = initialState();
    for (let i = 0; i < 100; i++) s = applyCheck(s, ok(i), T0 + i * 1000, opts);
    expect(s.history).toHaveLength(HISTORY_SAMPLES);
    expect(s.history[0]).toEqual({ t: T0 + 10_000, ok: true, ms: 10 });
    expect(s.history.at(-1)).toEqual({ t: T0 + 99_000, ok: true, ms: 99 });
  });
});

describe('uptime', () => {
  it('counts ok/total in 5-minute buckets over 24 h', () => {
    let b = recordUptime([], T0, true);
    b = recordUptime(b, T0 + 1000, false);
    b = recordUptime(b, T0 + BUCKET_MS, true);
    expect(b).toEqual([
      { t: T0, ok: 1, total: 2 },
      { t: T0 + BUCKET_MS, ok: 1, total: 1 },
    ]);
    expect(uptime24h(b, T0 + BUCKET_MS)).toBeCloseTo(2 / 3, 4);
    expect(uptime24h([], T0)).toBeUndefined();
  });

  it('drops samples older than 24 h', () => {
    let b = recordUptime([], T0, false); // will fall out of the window
    b = recordUptime(b, T0 + 12 * 3600_000, true);
    expect(uptime24h(b, T0 + 12 * 3600_000)).toBe(0.5);
    const later = T0 + 24 * 3600_000 + BUCKET_MS;
    expect(uptime24h(b, later)).toBe(1);
    b = recordUptime(b, later, true);
    expect(b.map((x) => x.t)).toEqual([T0 + 12 * 3600_000, later - (later % BUCKET_MS)]);
  });

  it('99 of 100 checks ok → 0.99', () => {
    let s = initialState();
    for (let i = 0; i < 100; i++) s = applyCheck(s, i === 50 ? fail() : ok(), T0 + i * 30_000, opts);
    expect(uptime24h(s.buckets, T0 + 100 * 30_000)).toBe(0.99);
  });
});

describe('persistence', () => {
  it('restores as unknown but keeps lastChange when the first check confirms the old status', () => {
    const [, , down] = run([ok(), fail(), fail()]);
    const saved = JSON.parse(JSON.stringify(persistState(down!)));
    expect(saved.status).toBe('down');
    const restored = restoreState(saved)!;
    expect(restored).toMatchObject({ status: 'unknown', restored: 'down', failures: 2 });
    expect(restored.history).toHaveLength(3);
    const again = applyCheck(restored, fail(), T0 + 3600_000, opts);
    expect(again).toMatchObject({ status: 'down', lastChange: down!.lastChange });
    expect(again.restored).toBeUndefined();
    const recovered = applyCheck(restored, ok(), T0 + 3600_000, opts);
    expect(recovered).toMatchObject({ status: 'up', lastChange: T0 + 3600_000 });
  });

  it('a restored "up" stays up through a single failure', () => {
    const restored = restoreState(persistState(run([ok()])[0]!))!;
    const s = applyCheck(restored, fail(), T0 + 1000, opts);
    expect(s).toMatchObject({ status: 'up', failures: 1, lastChange: T0 });
  });

  it('encodes history and buckets compactly and losslessly (history at 1 s resolution)', () => {
    const h = [
      { t: T0, ok: true, ms: 42 },
      { t: T0 + 30_000, ok: false },
    ];
    expect(encodeHistory(h)).toBe(`${T0 / 1000}:1:42,${T0 / 1000 + 30}:0:`);
    expect(decodeHistory(encodeHistory(h))).toEqual(h);
    const b = [
      { t: T0, ok: 9, total: 10 },
      { t: T0 + BUCKET_MS, ok: 10, total: 10 },
    ];
    expect(decodeBuckets(encodeBuckets(b))).toEqual(b);
    expect(decodeBuckets('1:5:3,x,2:1:1')).toEqual([{ t: 2 * BUCKET_MS, ok: 1, total: 1 }]);
    expect(decodeHistory('1:2:3,5:1:abc')).toEqual([{ t: 5000, ok: true }]);
  });

  it('rejects garbage', () => {
    expect(restoreState(null)).toBeUndefined();
    expect(restoreState({ status: 'bogus', history: [{ t: 'x' }], buckets: 3 })).toEqual({ status: 'unknown', failures: 0, history: [], buckets: [] });
  });
});

describe('facts that outlive a status', () => {
  it('remembers that a service has worked (everUp), its learned protocol and certificate, across restarts', () => {
    let s = applyCheck(initialState(), fail(), T0, opts);
    expect(s.everUp).toBeUndefined();
    s = applyCheck(s, ok(), T0 + 1000, opts);
    expect(s.everUp).toBe(true);
    s = applyCheck(s, fail(), T0 + 2000, opts);
    expect(s.everUp).toBe(true);
    s = { ...s, learned: { mode: 'tcp', guessed: 'http://10.0.0.5:7000/' }, tls: { notAfter: T0 + 1e9, issuer: 'R11', selfSigned: false }, tlsCheckedAt: T0 };
    s = applyResumed(applyPaused(s, T0 + 3000, 'x is stopped'), T0 + 4000);
    expect(s).toMatchObject({ everUp: true, learned: { mode: 'tcp' }, tls: { issuer: 'R11' }, tlsCheckedAt: T0 });
    const back = restoreState(JSON.parse(JSON.stringify(persistState(s))))!;
    expect(back).toMatchObject({
      everUp: true,
      learned: { mode: 'tcp', guessed: 'http://10.0.0.5:7000/' },
      tls: { notAfter: T0 + 1e9, issuer: 'R11', selfSigned: false },
      tlsCheckedAt: T0,
    });
  });

  it('files written before everUp existed: a successful sample or an up status proves it', () => {
    expect(restoreState({ status: 'down', failures: 3, h: '1:1:5,2:0:', b: '' })!.everUp).toBe(true);
    expect(restoreState({ status: 'up', failures: 0, h: '', b: '' })!.everUp).toBe(true);
    expect(restoreState({ status: 'down', failures: 3, h: '2:0:', b: '' })!.everUp).toBeUndefined();
    expect(restoreState({ status: 'down', failures: 3, h: '', b: '', learned: { mode: 'ftp', guessed: 1 }, tls: { notAfter: 'soon' } })).toMatchObject({
      status: 'unknown',
    });
    const junk = restoreState({ status: 'down', failures: 3, h: '', b: '', learned: { mode: 'ftp', guessed: 1 }, tls: { notAfter: 'soon' } })!;
    expect(junk.learned).toBeUndefined();
    expect(junk.tls).toBeUndefined();
  });
});
