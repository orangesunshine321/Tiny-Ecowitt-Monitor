/**
 * Default health checker: HTTP GET via undici (redirects are NOT followed, so a 3xx counts as reachable), or a plain
 * TCP connect via node:net. Each check gets a fresh connection (keep-alive disabled) so the latency includes the
 * TCP/TLS handshake and a dead backend can't hide behind a pooled socket.
 */
import { connect as netConnect } from 'node:net';
import { performance } from 'node:perf_hooks';
import { Agent, request } from 'undici';
import type { HealthChecker, HealthCheckResult, HealthCheckTarget } from '../context.js';
import { splitHostPort } from './spec.js';

/** Response bodies are discarded; never read more than this. */
const MAX_BODY_BYTES = 64 * 1024;

export interface DefaultChecker {
  check: HealthChecker;
  /** close pooled dispatchers */
  close(): Promise<void>;
}

export function isExpectedStatus(status: number, expect: number[] | undefined): boolean {
  return expect?.length ? expect.includes(status) : status >= 200 && status <= 399;
}

/** Short, human error reason: an errno/undici/TLS code where available, otherwise the message. */
export function describeError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | undefined;
  const code = typeof e?.code === 'string' ? e.code : typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
  switch (code) {
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return 'connect timeout';
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return 'response timeout';
    case 'UND_ERR_SOCKET':
    case 'ECONNRESET':
      return 'connection reset';
    case undefined:
      break;
    default:
      return code;
  }
  const msg = typeof e?.message === 'string' ? e.message : String(err);
  return msg.length > 120 ? `${msg.slice(0, 117)}...` : msg;
}

const timeoutMessage = (ms: number) => `timeout after ${Number.isInteger(ms / 1000) ? ms / 1000 : (ms / 1000).toFixed(1)}s`;

export function createDefaultChecker(opts: { userAgent?: string } = {}): DefaultChecker {
  const userAgent = opts.userAgent ?? 'pve1-dash-health';
  // pipelining: 0 disables keep-alive (one connection per request)
  const agents = {
    strict: new Agent({ pipelining: 0 }),
    insecure: new Agent({ pipelining: 0, connect: { rejectUnauthorized: false } }),
  };

  async function checkHttp(t: HealthCheckTarget): Promise<HealthCheckResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), t.timeoutMs);
    const started = performance.now();
    try {
      const res = await request(t.target, {
        method: 'GET',
        dispatcher: t.insecureTls ? agents.insecure : agents.strict,
        signal: ac.signal,
        headers: { 'user-agent': userAgent, accept: '*/*' },
      });
      const ms = Math.round(performance.now() - started);
      // drain (bounded) so the socket is released; errors here don't change the verdict
      await res.body.dump({ limit: MAX_BODY_BYTES }).catch(() => undefined);
      if (isExpectedStatus(res.statusCode, t.expectStatus)) return { ok: true, ms };
      return { ok: false, ms, message: `HTTP ${res.statusCode}` };
    } catch (err) {
      if (ac.signal.aborted) return { ok: false, message: timeoutMessage(t.timeoutMs) };
      return { ok: false, message: describeError(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  function checkTcp(t: HealthCheckTarget): Promise<HealthCheckResult> {
    const hp = splitHostPort(t.target);
    if (!hp) return Promise.resolve({ ok: false, message: `invalid target "${t.target}"` });
    return new Promise((resolve) => {
      const started = performance.now();
      let settled = false;
      const socket = netConnect({ host: hp.host, port: hp.port });
      const finish = (r: HealthCheckResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, message: timeoutMessage(t.timeoutMs) }), t.timeoutMs);
      socket.once('connect', () => finish({ ok: true, ms: Math.round(performance.now() - started) }));
      socket.once('error', (err) => finish({ ok: false, message: describeError(err) }));
    });
  }

  return {
    async check(t) {
      try {
        return t.type === 'tcp' ? await checkTcp(t) : await checkHttp(t);
      } catch (err) {
        // never let a checker bug take the scheduler down
        return { ok: false, message: describeError(err) };
      }
    },
    async close() {
      await Promise.allSettled([agents.strict.close(), agents.insecure.close()]);
    },
  };
}
