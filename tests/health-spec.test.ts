import { describe, expect, it } from 'vitest';
import { endpointKey, hostPortOfUrl, parseCheckSpec, splitHostPort } from '../server/health/spec.js';

describe('parseCheckSpec', () => {
  it('defaults to an HTTP check of the url, or none without a url', () => {
    expect(parseCheckSpec(undefined, 'http://10.10.20.2/admin')).toEqual({ type: 'http', target: 'http://10.10.20.2/admin' });
    expect(parseCheckSpec('', 'https://10.10.20.6:8443')).toEqual({ type: 'http', target: 'https://10.10.20.6:8443/' });
    expect(parseCheckSpec(undefined, undefined)).toEqual({ type: 'none' });
  });

  it('"http"/"https" use the url and need one', () => {
    expect(parseCheckSpec('http', 'http://10.10.20.20:8123')).toEqual({ type: 'http', target: 'http://10.10.20.20:8123/' });
    expect(parseCheckSpec('HTTPS', 'https://pbs:8007')).toEqual({ type: 'http', target: 'https://pbs:8007/' });
    expect(parseCheckSpec('http', undefined)).toMatchObject({ type: 'none', error: expect.stringContaining('needs a url') });
  });

  it('an explicit http(s) URL overrides the launcher url', () => {
    expect(parseCheckSpec('https://10.10.20.40:2283/api/server/ping', 'https://photos.home.lan')).toEqual({
      type: 'http',
      target: 'https://10.10.20.40:2283/api/server/ping',
    });
  });

  it('parses tcp://host:port including IPv6', () => {
    expect(parseCheckSpec('tcp://10.10.20.2:5335', undefined)).toEqual({ type: 'tcp', target: '10.10.20.2:5335' });
    expect(parseCheckSpec('tcp://[fd00::5]:53', undefined)).toEqual({ type: 'tcp', target: '[fd00::5]:53' });
    expect(parseCheckSpec('tcp://NAS.lan:445/', undefined)).toEqual({ type: 'tcp', target: 'nas.lan:445' });
  });

  it('"tcp" derives host and port from the url (scheme default ports)', () => {
    expect(parseCheckSpec('tcp', 'https://10.10.20.6:8443/manage')).toEqual({ type: 'tcp', target: '10.10.20.6:8443' });
    expect(parseCheckSpec('tcp', 'https://pve1.lan')).toEqual({ type: 'tcp', target: 'pve1.lan:443' });
    expect(parseCheckSpec('tcp', 'http://10.10.20.2/admin')).toEqual({ type: 'tcp', target: '10.10.20.2:80' });
  });

  it('"none" disables the check', () => {
    for (const w of ['none', 'off', 'NONE']) expect(parseCheckSpec(w, 'http://x.lan')).toEqual({ type: 'none' });
  });

  it('rejects malformed specs with a reason', () => {
    expect(parseCheckSpec('tcp://host', undefined)).toMatchObject({ type: 'none', error: expect.stringContaining('tcp://host:port') });
    expect(parseCheckSpec('tcp://host:99999', undefined)).toMatchObject({ type: 'none', error: expect.any(String) });
    expect(parseCheckSpec('ping', 'http://x.lan')).toMatchObject({ type: 'none', error: expect.stringContaining('unrecognised') });
    expect(parseCheckSpec(undefined, 'ftp://files.lan')).toMatchObject({ type: 'none', error: expect.stringContaining('http(s)') });
    expect(parseCheckSpec(undefined, '/relative')).toMatchObject({ type: 'none', error: expect.any(String) });
  });
});

describe('host/port helpers', () => {
  it('hostPortOfUrl uses the effective port', () => {
    expect(hostPortOfUrl('http://10.10.20.2/admin')).toEqual({ host: '10.10.20.2', port: 80 });
    expect(hostPortOfUrl('https://Dash.Home.lan')).toEqual({ host: 'dash.home.lan', port: 443 });
    expect(hostPortOfUrl('http://[fd00::1]:8080/')).toEqual({ host: '[fd00::1]', port: 8080 });
    expect(hostPortOfUrl('nonsense')).toBeUndefined();
  });

  it('splitHostPort strips IPv6 brackets', () => {
    expect(splitHostPort('10.0.0.1:22')).toEqual({ host: '10.0.0.1', port: 22 });
    expect(splitHostPort('[fd00::5]:53')).toEqual({ host: 'fd00::5', port: 53 });
    expect(splitHostPort('host')).toBeUndefined();
    expect(splitHostPort('host:0')).toBeUndefined();
  });

  it('endpointKey covers both the url and the check target', () => {
    expect(endpointKey(parseCheckSpec('tcp://10.10.20.2:5335', undefined), 'http://10.10.20.2/admin').sort()).toEqual([
      '10.10.20.2:5335',
      '10.10.20.2:80',
    ]);
    expect(endpointKey(parseCheckSpec(undefined, 'http://10.10.20.31:8096'), 'http://10.10.20.31:8096')).toEqual(['10.10.20.31:8096']);
  });
});
