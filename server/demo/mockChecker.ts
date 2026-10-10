/**
 * Mock HealthChecker for demo mode: answers checks against the fake 10.10.20.x homelab from the world.
 *
 * Endpoints are derived from the same data the mock SSH runner reports (each guest's listening sockets and published
 * container ports), so a service the inventory shows as listening also passes its check:
 *  - latencies 5-120 ms per endpoint (jittered), PBS (:8007) about 300 ms, TCP connects a fraction of that;
 *  - jellyseerr (container health "unhealthy") answers HTTP 503; exited containers (bazarr) refuse connections;
 *  - a known host with nothing on the port → ECONNREFUSED; unknown or stopped hosts → EHOSTUNREACH;
 *  - "slow" episodes: in about half of all 10-minute windows one healthy HTTP endpoint answers in 1.6-2.6 s for
 *    90-150 s (a few check rounds), so the departure board shows DELAYED now and then.
 */
import type { HealthChecker, HealthCheckResult, HealthCheckTarget } from '../context.js';
import { DEMO_GUESTS, DEMO_NODE, type DemoContainer, type DemoGuest } from './world.js';
import { DemoSim, between, hash01, hashInt } from './sim.js';
import { guestListeners } from './guestInventory.js';

interface Endpoint {
  host: string;
  port: number;
  /** what answers there, for debugging */
  name: string;
  /** whether it speaks HTTP(S) */
  http: boolean;
  /** HTTP status of the probed URL when healthy */
  status: number;
  /** typical HTTP response time in ms */
  baseMs: number;
  /** set when the endpoint is broken: HTTP status or a socket error code */
  failure?: { httpStatus?: number; error?: string };
  /** eligible for a "slow" episode */
  canBeSlow: boolean;
}

export interface MockCheckerOptions {
  sim?: DemoSim;
  /** actually wait for the simulated latency (default true); tests turn it off */
  sleep?: boolean;
  /** jitter source (default Math.random) */
  random?: () => number;
}

/** Ports that are not HTTP (a web request gets the connection reset). */
const NON_HTTP = new Set([22, 25, 53, 5335, 6881, 27117, 41641, 5432, 6379]);

/** Redirecting front pages (still healthy: 200-399 is accepted by default). */
const REDIRECTS: Record<number, number> = { 8096: 302, 8443: 302, 3001: 302, 80: 301 };

function containerEndpoints(g: DemoGuest, c: DemoContainer): Endpoint[] {
  return c.ports.map((spec) => {
    const port = Number(spec.split(':')[0]);
    const ep: Endpoint = {
      host: g.ip!,
      port,
      name: c.name,
      http: !NON_HTTP.has(port),
      status: REDIRECTS[port] ?? 200,
      baseMs: Math.round(between(5, 120, 'latency', g.ip!, port)),
      canBeSlow: true,
    };
    if (c.state !== 'running') {
      // docker removes the port forwarding when a container stops
      ep.failure = { error: 'ECONNREFUSED' };
      ep.canBeSlow = false;
    } else if (c.health === 'unhealthy') {
      ep.failure = { httpStatus: 503 };
      ep.canBeSlow = false;
    }
    return ep;
  });
}

/** Every reachable endpoint of the demo LAN, keyed "host:port". */
export function demoEndpoints(sim: DemoSim): Map<string, Endpoint> {
  const map = new Map<string, Endpoint>();
  const put = (ep: Endpoint) => {
    const key = `${ep.host}:${ep.port}`;
    if (!map.has(key)) map.set(key, ep);
  };
  // the node itself: pveproxy, spiceproxy, sshd
  put({ host: DEMO_NODE.ip, port: 8006, name: 'pveproxy', http: true, status: 200, baseMs: Math.round(between(14, 38, 'pve')), canBeSlow: true });
  put({ host: DEMO_NODE.ip, port: 3128, name: 'spiceproxy', http: true, status: 501, baseMs: 6, canBeSlow: false });
  put({ host: DEMO_NODE.ip, port: 22, name: 'sshd', http: false, status: 0, baseMs: 3, canBeSlow: false });

  for (const g of DEMO_GUESTS) {
    if (!g.ip || !sim.isRunning(g)) continue;
    for (const c of g.containers ?? []) for (const ep of containerEndpoints(g, c)) put(ep);
    for (const l of guestListeners(g)) {
      if (l.addr.startsWith('127.') || l.addr === '[::1]' || l.addr.includes('%lo')) continue;
      if (l.addr !== '0.0.0.0' && l.addr !== '*' && l.addr !== '[::]' && l.addr !== g.ip) continue;
      const pbs = l.process === 'proxmox-backup-proxy';
      put({
        host: g.ip,
        port: l.port,
        name: l.process,
        http: !NON_HTTP.has(l.port),
        status: REDIRECTS[l.port] ?? 200,
        // the PBS web UI is noticeably slower (TLS + a heavier first page)
        baseMs: pbs ? Math.round(between(270, 330, 'pbs')) : Math.round(between(5, 120, 'latency', g.ip, l.port)),
        canBeSlow: !NON_HTTP.has(l.port),
      });
    }
    // Home Assistant OS is not inspected by the inventory; its web UI and observer still answer.
    if (g.osPretty?.startsWith('Home Assistant')) {
      put({ host: g.ip, port: 8123, name: 'home-assistant', http: true, status: 200, baseMs: Math.round(between(30, 90, 'ha')), canBeSlow: true });
      put({ host: g.ip, port: 4357, name: 'observer', http: true, status: 200, baseMs: 12, canBeSlow: false });
    }
  }
  return map;
}

/** host:port of a check target ("http(s)://…" URL or "host:port"). */
export function endpointOf(t: HealthCheckTarget): { host: string; port: number } | undefined {
  if (t.type === 'http') {
    try {
      const u = new URL(t.target);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
    } catch {
      return undefined;
    }
  }
  const i = t.target.lastIndexOf(':');
  if (i <= 0) return undefined;
  const port = Number(t.target.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return { host: t.target.slice(0, i).replace(/^\[|\]$/g, ''), port };
}

const SLOW_WINDOW_MS = 10 * 60_000;

/** The endpoint key that is slow at `nowMs`, if any (deterministic per 10-minute window). */
export function slowEndpointAt(endpoints: Map<string, Endpoint>, nowMs: number): string | undefined {
  const w = Math.floor(nowMs / SLOW_WINDOW_MS);
  if (hash01('slow-window', w) >= 0.5) return undefined;
  const candidates = [...endpoints.entries()].filter(([, ep]) => ep.canBeSlow && ep.http).map(([k]) => k).sort();
  if (!candidates.length) return undefined;
  const durMs = between(90, 150, 'slow-dur', w) * 1000;
  const startMs = w * SLOW_WINDOW_MS + between(0, SLOW_WINDOW_MS - durMs, 'slow-start', w);
  if (nowMs < startMs || nowMs >= startMs + durMs) return undefined;
  return candidates[hashInt(candidates.length, 'slow-pick', w)];
}

const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`;

export function createMockChecker(opts: MockCheckerOptions = {}): HealthChecker {
  const sim = opts.sim ?? new DemoSim();
  const sleep = opts.sleep ?? true;
  const random = opts.random ?? Math.random;
  const endpoints = demoEndpoints(sim);
  const knownHosts = new Set([DEMO_NODE.ip, ...DEMO_GUESTS.filter((g) => g.ip && sim.isRunning(g)).map((g) => g.ip!)]);

  const evaluate = (t: HealthCheckTarget, now: number): { result: HealthCheckResult; waitMs: number } => {
    const at = endpointOf(t);
    if (!at) return { result: { ok: false, message: 'invalid target' }, waitMs: 0 };
    const key = `${at.host}:${at.port}`;
    const ep = endpoints.get(key);
    if (!ep) {
      if (knownHosts.has(at.host)) return { result: { ok: false, ms: 1, message: 'ECONNREFUSED' }, waitMs: 1 };
      // nothing answers ARP: the kernel reports the host unreachable after ~3 s
      const waitMs = Math.min(t.timeoutMs, 3_000);
      return { result: waitMs < 3_000 ? { ok: false, message: `timeout after ${secs(t.timeoutMs)}` } : { ok: false, message: 'EHOSTUNREACH' }, waitMs };
    }
    if (ep.failure?.error) return { result: { ok: false, ms: 1, message: ep.failure.error }, waitMs: 1 };

    const jitter = 0.75 + 0.5 * random();
    let ms: number;
    if (t.type === 'tcp') ms = Math.max(1, Math.round((1 + ep.baseMs * 0.08) * jitter));
    else {
      ms = Math.max(2, Math.round(ep.baseMs * jitter));
      if (slowEndpointAt(endpoints, now) === key) ms = Math.round(between(1_600, 2_600, 'slow-ms', key, Math.floor(now / 1000)));
    }
    if (ms >= t.timeoutMs) return { result: { ok: false, message: `timeout after ${secs(t.timeoutMs)}` }, waitMs: t.timeoutMs };
    if (t.type === 'tcp') return { result: { ok: true, ms }, waitMs: ms };

    if (!ep.http) return { result: { ok: false, ms, message: 'ECONNRESET' }, waitMs: ms };
    const status = ep.failure?.httpStatus ?? ep.status;
    const accepted = t.expectStatus?.length ? t.expectStatus.includes(status) : status >= 200 && status <= 399;
    return { result: accepted ? { ok: true, ms } : { ok: false, ms, message: `HTTP ${status}` }, waitMs: ms };
  };

  return async (t: HealthCheckTarget): Promise<HealthCheckResult> => {
    const { result, waitMs } = evaluate(t, sim.now());
    if (sleep && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return result;
  };
}
