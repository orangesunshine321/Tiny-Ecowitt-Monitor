import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readAppVersion } from '../server/version.js';

const tmp = mkdtempSync(join(tmpdir(), 'pve1-dash-version-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('readAppVersion', () => {
  it('reads our package.json from the source tree', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(readAppVersion()).toBe(pkg.version);
  });

  it('finds package.json from the bundle location (dist/server/index.js) and ignores foreign ones', () => {
    const root = join(tmp, 'release');
    mkdirSync(join(root, 'dist', 'server'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pve1-dash', version: '9.8.7' }));
    // a package.json of some other package on the way up must not be picked
    writeFileSync(join(root, 'dist', 'package.json'), JSON.stringify({ name: 'something-else', version: '1.0.0' }));
    const bundle = pathToFileURL(join(root, 'dist', 'server', 'index.js')).href;
    expect(readAppVersion(bundle, {})).toBe('9.8.7');
  });

  it('falls back to npm_package_version, then to a marker', () => {
    const lonely = pathToFileURL(join(tmp, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'index.js')).href;
    expect(readAppVersion(lonely, { npm_package_version: '1.2.3' })).toBe('1.2.3');
    expect(readAppVersion(lonely, {})).toBe('0.0.0-unknown');
  });
});
