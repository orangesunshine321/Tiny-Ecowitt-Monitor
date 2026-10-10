/** Stable colour hashing for tags, monograms and icons. */

/** Non-status system colours (status colours are reserved for meaning). */
export const HASH_PALETTE = ['--blue', '--indigo', '--purple', '--pink', '--teal', '--cyan', '--mint', '--brown'] as const;

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** CSS var reference of a stable palette colour for `key`, e.g. "var(--teal)". */
export function colorFor(key: string): string {
  return `var(${HASH_PALETTE[hashString(key.toLowerCase()) % HASH_PALETTE.length]})`;
}
