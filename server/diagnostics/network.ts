/**
 * Outbound checks: the push services the devices use, and (doctor only) the reverse proxy in front of the dashboard:
 * does publicUrl reach this server with a trusted certificate, does the proxy cache the service worker, and does it
 * buffer the live stream.
 */
import { type Dispatcher, fetch } from 'undici';
import type { Config } from '../config.js';
import type { DiagnosticCheck } from '../../shared/types.js';
import { readPushFile } from './local.js';
import { check, DOC, errCode, errText, mapLimit, ms, skipped } from './util.js';

const CERT_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_CERT|ERR_SSL|HOSTNAME_MISMATCH)/;

const causeOf = (err: unknown): unknown => (err instanceof Error && err.cause !== undefined ? err.cause : err);

export async function pushOutboundCheck(config: Config, timeoutMs: number): Promise<DiagnosticCheck> {
  const title = 'Push services reachable';
  if (!config.alerts.enabled) return skipped('push.outbound', 'push', title, 'Alerts are off.');
  const { file } = readPushFile(config.dataDir);
  const fromDevices = (file?.devices ?? []).map((d) => d.endpointHost).filter((h): h is string => typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h));
  const hosts = [...new Set(fromDevices.length ? fromDevices : ['web.push.apple.com'])].slice(0, 4);
  const results = await mapLimit(hosts, 4, async (host) => {
    const t0 = performance.now();
    try {
      await fetch(`https://${host}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      return { host, ms: performance.now() - t0 };
    } catch (err) {
      const c = causeOf(err);
      return { host, error: `${errCode(c) ?? (err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : '')} ${errText(c)}`.trim() };
    }
  });
  const bad = results.filter((r) => 'error' in r);
  if (bad.length) {
    return check('push.outbound', 'push', title, 'fail', `The container cannot reach ${bad.map((b) => `${b.host} (${'error' in b ? b.error : ''})`).join(', ')}: notifications cannot be delivered.`, {
      fix: `# In the dashboard container:\ncurl -sSI https://${bad[0]!.host}/ | head -1\ncat /etc/resolv.conf\n# The container needs outbound HTTPS (port 443) to the push services.`,
    });
  }
  return check('push.outbound', 'push', title, 'ok', results.map((r) => `${r.host} (${'ms' in r ? ms(r.ms!) : ''})`).join(', ') + ' reachable.');
}

/** Read the start of the SSE response until its first field arrives or the time runs out (status -1: no response at all). */
async function streamStarts(url: string, timeoutMs: number, dispatcher?: Dispatcher): Promise<{ status: number; seen: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ac.signal, redirect: 'manual', ...(dispatcher ? { dispatcher } : {}) });
    } catch (err) {
      if (ac.signal.aborted) return { status: -1, seen: false }; // not even the response headers arrived in time
      throw err;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, seen: false };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    try {
      while (text.length < 65_536) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        if (/^retry: |^event: /m.test(text)) return { status: res.status, seen: true };
      }
    } catch {
      /* aborted by the timer */
    } finally {
      ac.abort();
      reader.cancel().catch(() => {});
    }
    return { status: res.status, seen: false };
  } finally {
    clearTimeout(timer);
  }
}

/** `dispatcher` lets tests trust their own CA; production uses the system trust store, like the devices do. */
export async function proxyChecks(config: Config, timeoutMs: number, dispatcher?: Dispatcher): Promise<DiagnosticCheck[]> {
  const d = dispatcher ? { dispatcher } : {};
  const base = config.publicUrl?.replace(/\/+$/, '');
  if (!base || !base.startsWith('https://')) return [];
  const host = new URL(base).hostname;
  const port = config.listen.port;
  const title = 'Reverse proxy';
  const npmFix = `In Nginx Proxy Manager → Proxy Hosts → ${host}: Scheme http, Forward Hostname/IP = this container's IP, Forward Port = ${port}, Websockets Support on.`;
  let res: Awaited<ReturnType<typeof fetch>>;
  const t0 = performance.now();
  try {
    res = await fetch(`${base}/healthz`, { ...d, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    await res.text();
  } catch (err) {
    const c = causeOf(err);
    const code = errCode(c) ?? '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return [skipped('proxy.reach', 'config', title, `This container cannot resolve ${host}, so the proxy was not tested from here (fine if your devices can resolve it).`)];
    }
    if (CERT_CODES.test(code)) {
      return [
        check('proxy.reach', 'config', title, 'fail', `${base} presents a certificate that is not trusted (${code}). iPhone and iPad refuse push and the Home Screen app with it.`, {
          fix: `In Nginx Proxy Manager → Proxy Hosts → ${host} → SSL: request a Let's Encrypt certificate (DNS challenge works for a LAN-only name) and turn on Force SSL and HTTP/2.`,
          docs: 'docs/SETUP.md',
        }),
      ];
    }
    return [
      check('proxy.reach', 'config', title, 'warn', `${base} did not answer from this container (${code || errText(c)}).`, {
        fix: `Check the DNS record of ${host} and that the proxy listens on 443: curl -sSI ${base}/healthz`,
      }),
    ];
  }
  const took = performance.now() - t0;
  const status = res.status;
  if (status === 403) {
    return [skipped('proxy.reach', 'config', title, `The proxy refused this container (HTTP 403): its access list does not include the container's address. Expected unless the container is in the allowed network.`)];
  }
  if (status === 421) {
    return [
      check('proxy.reach', 'config', title, 'fail', `The dashboard refused the host name it received from the proxy (HTTP 421): the proxy does not pass the original Host header.`, {
        fix: 'Nginx Proxy Manager passes it by default; in a custom nginx config add: proxy_set_header Host $host;',
        docs: DOC.host421,
      }),
    ];
  }
  if (status === 502 || status === 503 || status === 504) {
    return [check('proxy.reach', 'config', title, 'fail', `The proxy cannot reach the dashboard (HTTP ${status}).`, { fix: npmFix, docs: 'docs/SETUP.md' })];
  }
  if (status >= 300 && status < 400) {
    return [check('proxy.reach', 'config', title, 'warn', `${base}/healthz redirects (HTTP ${status} → ${res.headers.get('location') ?? '?'}); an auth portal in front of the dashboard breaks push links and the live stream.`)];
  }
  if (status !== 200) {
    return [check('proxy.reach', 'config', title, 'warn', `${base}/healthz answered HTTP ${status}.`, { fix: npmFix })];
  }
  // /healthz is exempt from listen.allowedSources (for monitors), so ask for a page that is not
  try {
    const page = await fetch(`${base}/`, { ...d, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    const text = await page.text();
    if (page.status === 403 && /listen\.allowedSources/.test(text)) {
      const from = /connections from (\S+) are not allowed/.exec(text)?.[1];
      return [
        check(
          'proxy.reach',
          'config',
          title,
          'fail',
          `The proxy reaches the dashboard, but the dashboard refuses it: the proxy connects from ${from ?? 'an address'} that is not in listen.allowedSources (${(config.listen.allowedSources ?? []).join(', ')}). Every page through ${host} answers 403.`,
          {
            fix: `# In the dashboard container: add ${from ? `"${from}" (the proxy)` : "the proxy's address"} to listen.allowedSources, then save (it restarts the dashboard):\npve1-dash-config`,
            docs: 'docs/SETUP.md',
          },
        ),
      ];
    }
  } catch {
    /* /healthz answered: judge by that */
  }
  const checks: DiagnosticCheck[] = [check('proxy.reach', 'config', title, 'ok', `${base} reaches the dashboard with a trusted certificate (${ms(took)}).`)];

  try {
    const sw = await fetch(`${base}/sw.js`, { ...d, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await sw.body?.cancel().catch(() => {});
    const cc = sw.headers.get('cache-control') ?? '';
    if (sw.status === 200) {
      const cached = !/no-cache|no-store/i.test(cc) || /max-age=[1-9]/i.test(cc) || sw.headers.has('expires') || sw.headers.has('x-cache-status');
      checks.push(
        cached
          ? check('proxy.cache', 'config', 'Proxy caching', 'fail', `The proxy caches the service worker (Cache-Control: "${cc || 'none'}"${sw.headers.has('expires') ? `, Expires: ${sw.headers.get('expires')}` : ''}): installed apps will not pick up updates.`, {
              fix: `Nginx Proxy Manager → Proxy Hosts → ${host} → Details: turn OFF "Cache Assets".`,
            })
          : check('proxy.cache', 'config', 'Proxy caching', 'ok', 'The service worker is not cached by the proxy.'),
      );
    }
  } catch {
    /* covered by proxy.reach */
  }

  try {
    const s = await streamStarts(`${base}/api/stream`, Math.min(timeoutMs, 5000), dispatcher);
    if (s.status === 200 || s.status === -1) {
      checks.push(
        s.seen
          ? check('proxy.stream', 'config', 'Live updates through the proxy', 'ok', 'The live stream passes through the proxy without buffering.')
          : check('proxy.stream', 'config', 'Live updates through the proxy', 'fail', `The live stream sent nothing through the proxy within ${Math.round(Math.min(timeoutMs, 5000) / 1000)} s: the proxy buffers it, so the dashboard looks frozen.`, {
              fix:
                `Nginx Proxy Manager → Proxy Hosts → ${host}: turn on Websockets Support. NPM honours the dashboard's X-Accel-Buffering: no, so ` +
                'buffering usually means a second proxy or CDN in front of it. Keep the Advanced tab empty; if NPM itself must be told, add a ' +
                'Custom Location for /api/stream (same forward host and port) with: proxy_buffering off; proxy_read_timeout 1h;',
              docs: DOC.sse,
            }),
      );
    }
  } catch {
    /* covered by proxy.reach */
  }
  return checks;
}
