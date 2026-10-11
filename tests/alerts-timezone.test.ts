import { describe, expect, it } from 'vitest';
import { fmtClock, fmtWhen } from '../server/alerts/format.js';
import { ConfigSchema, isValidTimeZone, systemTimeZone } from '../server/config.js';

const base = { proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'dash@pve!ro', tokenSecret: 'x' } };

describe('config.timezone', () => {
  it('accepts IANA zones and rejects anything else with a readable error', () => {
    expect(ConfigSchema.parse({ ...base, timezone: 'Europe/Berlin' }).timezone).toBe('Europe/Berlin');
    expect(ConfigSchema.parse({ ...base, timezone: 'UTC' }).timezone).toBe('UTC');
    for (const bad of ['Mars/Olympus', '', 'Europe/Berlin; rm -rf /']) {
      const r = ConfigSchema.safeParse({ ...base, timezone: bad });
      expect(r.success, bad).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('IANA time zone');
    }
  });

  it('defaults to TZ, else the system zone', () => {
    expect(ConfigSchema.parse(base).timezone).toBe(systemTimeZone());
    expect(systemTimeZone({ TZ: 'America/Chicago' })).toBe('America/Chicago');
    expect(systemTimeZone({ TZ: ':Asia/Tokyo' })).toBe('Asia/Tokyo');
    // an unusable TZ falls back to what the runtime reports
    expect(isValidTimeZone(systemTimeZone({ TZ: '/etc/localtime' }))).toBe(true);
    expect(isValidTimeZone(systemTimeZone({}))).toBe(true);
  });
});

describe('zone-aware clock formatting', () => {
  const t = Date.UTC(2026, 9, 10, 23, 5); // 23:05 UTC

  it('fmtClock uses the given zone (24 h, zero padded)', () => {
    expect(fmtClock(t, 'UTC')).toBe('23:05');
    expect(fmtClock(t, 'Europe/Berlin')).toBe('01:05');
    expect(fmtClock(t, 'Asia/Kolkata')).toBe('04:35');
    expect(fmtClock(Date.UTC(2026, 9, 10, 0, 0), 'UTC')).toBe('00:00'); // never "24:00"
  });

  it('fmtWhen decides "same day" in the given zone', () => {
    const later = Date.UTC(2026, 9, 11, 0, 10); // 00:10 UTC on 11 Oct = 02:10 in Berlin
    // 23:05 UTC on 10 Oct is "yesterday" in UTC, but 01:05 on the same day (11 Oct) in Berlin
    expect(fmtWhen(t, later, 'UTC')).toBe('10 Oct 23:05');
    expect(fmtWhen(t, later, 'Europe/Berlin')).toBe('01:05');
    // and the other way round: same UTC day, different Berlin days (23:00 on 10 Oct vs 00:30 on 11 Oct)
    expect(fmtWhen(Date.UTC(2026, 9, 10, 21, 0), Date.UTC(2026, 9, 10, 22, 30), 'UTC')).toBe('21:00');
    expect(fmtWhen(Date.UTC(2026, 9, 10, 21, 0), Date.UTC(2026, 9, 10, 22, 30), 'Europe/Berlin')).toBe('10 Oct 23:00');
    expect(fmtWhen(Date.UTC(2026, 9, 9, 12, 0), later, 'UTC')).toBe('9 Oct 12:00');
  });

  it('daylight saving time is applied', () => {
    expect(fmtClock(Date.UTC(2026, 0, 15, 12, 0), 'Europe/Berlin')).toBe('13:00'); // CET
    expect(fmtClock(Date.UTC(2026, 6, 15, 12, 0), 'Europe/Berlin')).toBe('14:00'); // CEST
  });

  it('an unknown zone falls back to the process zone instead of throwing', () => {
    expect(fmtClock(t, 'Not/AZone')).toBe(fmtClock(t));
  });
});
