/**
 * Split-flap drums (docs/research/design-lang.md §6.1–6.2).
 *
 * A real module is one spool of flaps that only turns forwards: to get from "A" to "Z" it shows every character in
 * between. A drum here is the ordered list of faces; the first face is "home" (blank). Character drums hold single
 * characters; a word drum (the REMARKS column) holds one whole word per flap, like a Solari status flap.
 */

/** Character drum: blank, A–Z, 0–9, then punctuation (the order a flap passes them). */
export const CHAR_DRUM: readonly string[] = Object.freeze([' ', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789', ...".,:-/'&!?#@+()%"]);

/** Digits only (the flip clock), so 9 → 0 is a single step like a real clock. */
export const DIGIT_DRUM: readonly string[] = Object.freeze([...'0123456789']);

/** Characters outside the drum that have a natural stand-in. */
const SUBSTITUTE: Record<string, string> = {
  _: '-',
  '–': '-',
  '—': '-',
  '·': '.',
  '…': '.',
  '"': "'",
  '`': "'",
  '’': "'",
  '‘': "'",
  '[': '(',
  ']': ')',
  '{': '(',
  '}': ')',
  '|': '/',
  '\\': '/',
  ';': ':',
};

/**
 * Normalise text for a character drum: upper case, accents stripped, a few look-alikes substituted, anything else
 * the drum doesn't have becomes a blank flap.
 */
export function toDrumText(text: string, drum: readonly string[] = CHAR_DRUM): string {
  const faces = new Set(drum);
  let out = '';
  for (const raw of text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()) {
    const ch = SUBSTITUTE[raw] ?? raw;
    out += faces.has(ch) ? ch : ' ';
  }
  return out;
}

/**
 * Lay text into exactly `width` flaps: normalised, truncated (boards simply cut long names) and padded with blank
 * flaps on the right (or left for `align: 'right'`).
 */
export function fitText(text: string, width: number, align: 'left' | 'right' = 'left', drum: readonly string[] = CHAR_DRUM): string[] {
  if (width <= 0) return [];
  const chars = [...toDrumText(text, drum).trimEnd()];
  const cut = chars.slice(0, width);
  const pad = Array.from({ length: width - cut.length }, () => drum[0] ?? ' ');
  return align === 'right' ? [...pad, ...cut] : [...cut, ...pad];
}

/** Index of a face on the drum (unknown faces map to home, index 0). */
export function drumIndex(drum: readonly string[], face: string): number {
  const i = drum.indexOf(face);
  return i < 0 ? 0 : i;
}

/** Forward steps a flap needs to turn from `from` to `to` (the drum only turns one way). */
export function stepsBetween(drum: readonly string[], from: string, to: string): number {
  const n = drum.length;
  if (n === 0) return 0;
  return (drumIndex(drum, to) - drumIndex(drum, from) + n) % n;
}
