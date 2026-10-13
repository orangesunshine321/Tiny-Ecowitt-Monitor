/**
 * deploy/config.example.yaml must parse with the real schema, document every option, and show true defaults.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigSchema, loadConfig } from '../server/config.js';

const ROOT = join(import.meta.dirname, '..');
const EXAMPLE_PATH = join(ROOT, 'deploy/config.example.yaml');
const EXAMPLE = readFileSync(EXAMPLE_PATH, 'utf8');

const tmp = mkdtempSync(join(tmpdir(), 'pve1-dash-config-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Every object key path of the schema; array elements are "[]", record values "{}". */
function schemaPaths(schema: unknown, prefix = ''): string[] {
  const def = (schema as { _zod: { def: Record<string, unknown> } })._zod.def;
  switch (def.type) {
    case 'default':
    case 'prefault':
    case 'optional':
    case 'nullable':
      return schemaPaths(def.innerType, prefix);
    case 'object': {
      const shape = def.shape as Record<string, unknown>;
      return Object.entries(shape).flatMap(([k, v]) => {
        const p = prefix ? `${prefix}.${k}` : k;
        return [p, ...schemaPaths(v, p)];
      });
    }
    case 'array':
      return schemaPaths(def.element, `${prefix}[]`);
    case 'record':
      return schemaPaths(def.valueType, `${prefix}{}`);
    default:
      return [];
  }
}

/** Is PATH present in the parsed document (any array element / record value counts)? */
function present(doc: unknown, path: string): boolean {
  const parts = path.split('.').flatMap((p) => p.split(/(?=\[\]|\{\})/));
  let nodes: unknown[] = [doc];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const n of nodes) {
      if (part === '[]' && Array.isArray(n)) next.push(...n);
      else if (part === '{}' && n && typeof n === 'object') next.push(...Object.values(n));
      else if (n && typeof n === 'object' && !Array.isArray(n) && part in (n as object)) next.push((n as Record<string, unknown>)[part]);
    }
    if (!next.length) return false;
    nodes = next;
  }
  return true;
}

function omit(obj: Record<string, unknown>, paths: string[]): Record<string, unknown> {
  const copy = structuredClone(obj);
  for (const p of paths) {
    const keys = p.split('.');
    let o: Record<string, unknown> | undefined = copy;
    for (const k of keys.slice(0, -1)) o = o?.[k] as Record<string, unknown> | undefined;
    if (o) delete o[keys.at(-1)!];
  }
  return copy;
}

describe('deploy/config.example.yaml', () => {
  const raw = parseYaml(EXAMPLE) as Record<string, unknown>;

  it('parses with ConfigSchema', () => {
    const r = ConfigSchema.safeParse(raw);
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
  });

  it('loads through loadConfig (PVE1_DASH_CONFIG) with its tokenSecretFile', () => {
    const tokenFile = join(tmp, 'token');
    writeFileSync(tokenFile, '0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f\n');
    const line = 'tokenSecretFile: /etc/pve1-dash/token';
    expect(EXAMPLE).toContain(line);
    const configPath = join(tmp, 'config.yaml');
    writeFileSync(configPath, EXAMPLE.replace(line, `tokenSecretFile: ${tokenFile}`));

    const cfg = loadConfig({ PVE1_DASH_CONFIG: configPath });
    expect(cfg.proxmox.tokenSecret).toBe('0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f');
    expect(cfg.proxmox.url).toBe('https://192.168.1.10:8006');
    expect(cfg.proxmox.tokenId).toBe('pve1dash@pve!dashboard');
    expect(cfg.proxmox.tls.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(cfg.inventory.enabled).toBe(true);
    expect(cfg.inventory.host).toEqual({ address: '192.168.1.10', port: 22, user: 'root' });
    expect(cfg.inventory.guests).toEqual([{ vmid: 108, address: '192.168.1.60', port: 22, user: 'root' }]);
    expect(cfg.services.items.map((s) => s.name)).toEqual(['Proxmox VE', 'Home Assistant', 'Pi-hole', 'Vaultwarden']);
    expect(cfg.services.items.find((s) => s.name === 'Pi-hole')?.check).toBe('tcp://192.168.1.53:53');
    expect(cfg.services.hide).toContain('watchtower');
    expect(cfg.services.overrides.jellyfin?.group).toBe('Media');
    expect(cfg.alerts.vapidSubject).toMatch(/^mailto:/);
    expect(cfg.alerts.vapidSubject).not.toContain('localhost');
    expect(cfg.board).toEqual({ title: 'SERVICE STATUS', station: 'PVE1', sound: false });
    expect(cfg.demo).toBe(false);
  });

  it('documents every option of the schema (as a value or a commented-out line)', () => {
    const paths = schemaPaths(ConfigSchema);
    // guard against the walker silently finding nothing (zod internals changing)
    expect(paths.length).toBeGreaterThan(80);
    expect(paths).toEqual(
      expect.arrayContaining(['proxmox.tls.fingerprint', 'inventory.guests[].vmid', 'services.overrides{}.alert', 'alerts.rules.guestStopped.watch']),
    );
    const missing = paths.filter((path) => {
      if (present(raw, path)) return false;
      const leaf = path.split(/\.|\[\]|\{\}/).filter(Boolean).at(-1)!;
      return !new RegExp(`^\\s*#\\s*${leaf}:`, 'm').test(EXAMPLE);
    });
    expect(missing).toEqual([]);
  });

  it('shows the real default for every option it does not mark as an example', () => {
    const example = ConfigSchema.parse(raw) as unknown as Record<string, unknown>;
    const defaults = ConfigSchema.parse({
      proxmox: { url: 'https://192.168.1.10:8006', tokenId: 'pve1dash@pve!dashboard' },
    }) as unknown as Record<string, unknown>;
    // The values the file labels "Example": everything else must equal the schema default.
    const examples = [
      'publicUrl',
      'proxmox.url',
      'proxmox.tokenId',
      'proxmox.tokenSecretFile',
      'proxmox.tls.fingerprint',
      'inventory.enabled',
      'inventory.host',
      'inventory.guests',
      'services.items',
      'services.hide',
      'services.overrides',
      'alerts.vapidSubject',
    ];
    expect(omit(example, examples)).toEqual(omit(defaults, examples));
  });
});
