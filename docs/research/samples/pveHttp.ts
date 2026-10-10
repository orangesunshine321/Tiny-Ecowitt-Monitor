// PVE HTTPS client transport: CA trust or SHA-256 leaf pinning, via undici@7.
import { Agent, buildConnector, fetch } from 'undici';
import type { TLSSocket } from 'node:tls';
import { readFileSync } from 'node:fs';

export type PveTls =
  | { mode: 'system' }                                         // public CA / ACME cert
  | { mode: 'ca'; caFile: string; skipHostnameCheck?: boolean } // e.g. /etc/pve/pve-root-ca.pem
  | { mode: 'fingerprint'; sha256: string }                   // "AB:CD:..." (64 hex, colons optional)
  | { mode: 'insecure' };                                      // last resort, logs a warning

const normFp = (s: string) => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

export function makeDispatcher(tls: PveTls): Agent {
  const common = { keepAliveTimeout: 10_000, connections: 4 } as const;
  switch (tls.mode) {
    case 'system':
      return new Agent(common);
    case 'ca':
      return new Agent({
        ...common,
        connect: {
          ca: readFileSync(tls.caFile),
          // Chain is still verified against `ca`; only the hostname/IP-vs-SAN check is skipped.
          ...(tls.skipHostnameCheck ? { checkServerIdentity: () => undefined } : {}),
        },
      });
    case 'fingerprint': {
      const want = normFp(tls.sha256);
      if (want.length !== 64) throw new Error('fingerprint must be a SHA-256 (32 bytes)');
      // NOTE: rejectUnauthorized:false + checkServerIdentity does NOT work for self-signed certs
      // (checkServerIdentity is never called when chain verification failed). Check in the connector.
      const base = buildConnector({ rejectUnauthorized: false, timeout: 10_000, maxCachedSessions: 0 }); // no TLS session resumption
      return new Agent({
        ...common,
        connect(opts, cb) {
          base(opts, (err, socket) => {
            if (err) return cb(err, null);
            const got = (socket as TLSSocket).getPeerCertificate()?.fingerprint256 ?? '';
            if (normFp(got) !== want) {
              socket!.destroy();
              return cb(new Error(`PVE TLS fingerprint mismatch: got ${got || 'none'}`), null);
            }
            cb(null, socket);
          });
        },
      });
    }
    case 'insecure':
      return new Agent({ ...common, connect: { rejectUnauthorized: false } });
  }
}

export async function pveGet<T>(baseUrl: string, path: string, token: string, dispatcher: Agent, signal?: AbortSignal): Promise<T> {
  // Use undici's own fetch with undici's Agent (same package => no dispatcher API mismatch).
  const res = await fetch(new URL(`/api2/json${path}`, baseUrl), {
    dispatcher,
    signal: signal ?? AbortSignal.timeout(10_000),
    headers: { Authorization: `PVEAPIToken=${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`PVE ${path}: HTTP ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data: T };
  return body.data;
}
