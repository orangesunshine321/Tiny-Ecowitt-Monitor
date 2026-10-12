import { describe, expect, it } from 'vitest';
import { DemoSim } from '../server/demo/sim.js';
import { createMockChecker, demoEndpoints, slowEndpointAt } from '../server/demo/mockChecker.js';
import type { HealthCheckTarget } from '../server/context.js';

const ANCHOR = Date.UTC(2026, 9, 10, 19, 0, 0);

const http = (target: string, extra: Partial<HealthCheckTarget> = {}): HealthCheckTarget => ({ type: 'http', target, insecureTls: true, timeoutMs: 5_000, ...extra });
const tcp = (target: string, extra: Partial<HealthCheckTarget> = {}): HealthCheckTarget => ({ type: 'tcp', target, insecureTls: false, timeoutMs: 5_000, ...extra });

/** A moment with no slow episode, so latencies are the normal ones. */
function calmMoment(sim: DemoSim): number {
  const eps = demoEndpoints(sim);
  for (let t = ANCHOR; ; t += 60_000) if (!slowEndpointAt(eps, t)) return t;
}

function checker(now: () => number, random = () => 0.5) {
  const sim = new DemoSim({ anchor: ANCHOR, now });
  return { sim, check: createMockChecker({ sim, sleep: false, random }) };
}

describe('mock health checker', () => {
  it('answers healthy endpoints with 5-120 ms (PBS ~300 ms)', async () => {
    let now = ANCHOR;
    const { sim, check } = checker(() => now);
    now = calmMoment(sim);
    for (const url of ['https://10.10.20.10:8006/', 'http://10.10.20.20:8123/', 'http://10.10.20.2/admin', 'https://10.10.20.6:8443/', 'http://10.10.20.31:8096/', 'http://10.10.20.40:2283/', 'http://10.10.20.5/']) {
      const r = await check(http(url));
      expect(r.ok, url).toBe(true);
      expect(r.ms!, url).toBeGreaterThanOrEqual(3);
      expect(r.ms!, url).toBeLessThanOrEqual(150);
    }
    const pbs = await check(http('https://10.10.20.60:8007/'));
    expect(pbs.ok).toBe(true);
    expect(pbs.ms!).toBeGreaterThanOrEqual(250);
    expect(pbs.ms!).toBeLessThanOrEqual(350);
    const unbound = await check(tcp('10.10.20.2:5335'));
    expect(unbound.ok).toBe(true);
    expect(unbound.ms!).toBeLessThan(20);
  });

  it('jitters latencies between calls', async () => {
    let i = 0;
    const seq = [0, 1, 0.2, 0.9];
    const { check } = checker(() => ANCHOR + 1, () => seq[i++ % seq.length]!);
    const values = new Set<number>();
    for (let k = 0; k < 4; k++) values.add((await check(http('http://10.10.20.40:8222/'))).ms!);
    expect(values.size).toBeGreaterThan(1);
  });

  it('fails jellyseerr with HTTP 503 while its port stays open', async () => {
    const { check } = checker(() => ANCHOR);
    const r = await check(http('http://10.10.20.31:5055/'));
    expect(r).toMatchObject({ ok: false, message: 'HTTP 503' });
    expect(r.ms).toBeGreaterThan(0);
    expect((await check(tcp('10.10.20.31:5055'))).ok).toBe(true);
  });

  it('refuses connections to exited containers and unused ports', async () => {
    const { check } = checker(() => ANCHOR);
    expect(await check(http('http://10.10.20.31:6767/'))).toMatchObject({ ok: false, message: 'ECONNREFUSED' }); // bazarr
    expect(await check(tcp('10.10.20.31:6767'))).toMatchObject({ ok: false, message: 'ECONNREFUSED' });
    expect(await check(http('http://10.10.20.40:9999/'))).toMatchObject({ ok: false, message: 'ECONNREFUSED' });
  });

  it('cannot reach unknown hosts', async () => {
    const { check } = checker(() => ANCHOR);
    expect(await check(http('http://10.10.20.250/'))).toMatchObject({ ok: false, message: 'EHOSTUNREACH' });
    expect(await check(http('http://10.10.20.250/', { timeoutMs: 1_000 }))).toMatchObject({ ok: false, message: 'timeout after 1s' });
  });

  it('applies expectStatus and treats non-HTTP ports as protocol errors', async () => {
    let now = ANCHOR;
    const { sim, check } = checker(() => now);
    now = calmMoment(sim);
    expect(await check(http('https://10.10.20.6:8443/', { expectStatus: [200] }))).toMatchObject({ ok: false, message: 'HTTP 302' });
    expect((await check(http('https://10.10.20.6:8443/'))).ok).toBe(true); // redirects are fine by default
    expect(await check(http('http://10.10.20.2:5335/'))).toMatchObject({ ok: false, message: 'ECONNRESET' });
    expect(await check({ type: 'http', target: 'not a url', insecureTls: true, timeoutMs: 1000 })).toMatchObject({ ok: false });
  });

  it('has occasional slow episodes that last several checks', async () => {
    let now = ANCHOR;
    const { sim, check } = checker(() => now);
    const eps = demoEndpoints(sim);
    const day = 24 * 3_600_000;
    const slowByWindow = new Map<number, Set<number>>();
    for (let t = ANCHOR; t < ANCHOR + day; t += 30_000) {
      const key = slowEndpointAt(eps, t);
      if (!key) continue;
      const w = Math.floor(t / 600_000);
      if (!slowByWindow.has(w)) slowByWindow.set(w, new Set());
      slowByWindow.get(w)!.add(t);
      expect(slowEndpointAt(eps, t)).toBe(key); // stable while it lasts
    }
    const windows = 24 * 6;
    expect(slowByWindow.size).toBeGreaterThan(windows * 0.25);
    expect(slowByWindow.size).toBeLessThan(windows * 0.75);
    for (const checks of slowByWindow.values()) expect(checks.size).toBeGreaterThanOrEqual(2); // 90-150 s at a 30 s interval

    // and the checker really reports > 1.5 s for the slow endpoint
    const [w, times] = [...slowByWindow.entries()][0]!;
    now = [...times][0]!;
    const key = slowEndpointAt(eps, now)!;
    const [host, port] = key.split(':');
    const r = await check(http(`http://${host}:${port}/`));
    expect(r.ok, `window ${w}`).toBe(true);
    expect(r.ms!).toBeGreaterThan(1_500);
    const short = await check(http(`http://${host}:${port}/`, { timeoutMs: 1_000 }));
    expect(short).toMatchObject({ ok: false, message: 'timeout after 1s' });
  });

  it('actually waits for the simulated latency when sleeping', async () => {
    const sim = new DemoSim({ anchor: ANCHOR, now: () => ANCHOR });
    const check = createMockChecker({ sim, sleep: true, random: () => 0.5 });
    const t0 = Date.now();
    const r = await check(tcp('10.10.20.10:8006'));
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(r.ms! - 1);
  });
});
