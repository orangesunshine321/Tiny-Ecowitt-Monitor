import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'pve1-dash';
const MAX_LEVELS = 6;

/**
 * The app version from our own package.json, read at runtime.
 *
 * Walks up from the calling module's directory, so it works for tsx in development (server/index.ts → ./package.json),
 * the esbuild bundle (dist/server/index.js → ../../package.json) and the release tarball (server/index.mjs →
 * ../package.json). Only a package.json whose name is "pve1-dash" counts, so a stray one in node_modules is ignored.
 */
export function readAppVersion(fromUrl: string = import.meta.url, env: NodeJS.ProcessEnv = process.env): string {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(fromUrl));
  } catch {
    return env.npm_package_version ?? '0.0.0-unknown';
  }
  for (let i = 0; i < MAX_LEVELS; i++) {
    const version = versionAt(join(dir, 'package.json'));
    if (version) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return env.npm_package_version ?? '0.0.0-unknown';
}

function versionAt(path: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown };
    return pkg.name === PACKAGE_NAME && typeof pkg.version === 'string' && pkg.version ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
