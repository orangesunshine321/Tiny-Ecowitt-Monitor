/**
 * Reads the leaf certificate of an HTTPS service (expiry, issuer, subject), whether or not it would verify: health
 * checks skip verification for homelab self-signed certificates, so an expiring Let's Encrypt certificate behind a
 * reverse proxy would otherwise stay "up" until browsers refuse it.
 */
import { isIP } from 'node:net';
import { connect, type PeerCertificate } from 'node:tls';
import type { ServiceEntry } from '../../shared/types.js';
import { parseHttpUrl } from './spec.js';

export type TlsInfo = NonNullable<ServiceEntry['tls']>;

/** Reads the certificate of an https URL; undefined when there is none to read (not https, unreachable, no cert). */
export type TlsProbe = (url: string, timeoutMs: number) => Promise<TlsInfo | undefined>;

/** A distinguished-name field (Node gives arrays for repeated fields). */
const field = (dn: PeerCertificate['subject'] | undefined, key: 'CN' | 'O'): string | undefined => {
  const v = (dn as Record<string, string | string[] | undefined> | undefined)?.[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
};

const sameDn = (a: PeerCertificate['subject'] | undefined, b: PeerCertificate['subject'] | undefined) =>
  !!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Certificate facts from a peer certificate (exported for tests). */
export function tlsInfoOf(cert: Partial<PeerCertificate> | undefined): TlsInfo | undefined {
  if (!cert || !cert.valid_to) return undefined;
  const notAfter = Date.parse(cert.valid_to);
  if (!Number.isFinite(notAfter)) return undefined;
  const info: TlsInfo = { notAfter };
  // "Let's Encrypt" reads better than its intermediate's name ("R11"); the subject is the host name
  const issuer = field(cert.issuer, 'O') ?? field(cert.issuer, 'CN');
  const subject = field(cert.subject, 'CN') ?? field(cert.subject, 'O');
  if (issuer) info.issuer = issuer;
  if (subject) info.subject = subject;
  info.selfSigned = sameDn(cert.issuer, cert.subject);
  return info;
}

export const probeTls: TlsProbe = (url, timeoutMs) => {
  const u = parseHttpUrl(url);
  if (!u || u.protocol !== 'https:') return Promise.resolve(undefined);
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = u.port ? Number(u.port) : 443;
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({
      host,
      port,
      // SNI only for names (an IP literal as servername is not allowed)
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: false,
    });
    const finish = (v: TlsInfo | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.once('secureConnect', () => finish(tlsInfoOf(socket.getPeerCertificate(false))));
    socket.once('error', () => finish(undefined));
  });
};
