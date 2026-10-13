/**
 * Proxmox guest notes → safe, readable text (pure; tested in tests/web-guests-notes.test.ts).
 *
 * Proxmox renders notes as Markdown with inline HTML, and helper scripts (community-scripts) write whole HTML blocks
 * into them (`<div align='center'><a href=…><img …/></a><h2>Docker LXC</h2>…`). pve1-dash never injects HTML: markup is
 * reduced to its text here, links are kept as data (http/https only) and React renders everything as text nodes.
 * Images are never loaded. A light touch of Markdown is understood: "# Heading" lines and [label](url) links.
 */

export interface NoteLink {
  href: string;
  label: string;
}

/** A run of text, optionally a link (always http/https). */
export interface NoteSpan {
  text: string;
  href?: string;
}

export interface NoteLine {
  spans: NoteSpan[];
  /** a "# Heading" line (Markdown) or an <h1>–<h6> block */
  heading?: boolean;
}

export interface ParsedNotes {
  /** the notes contained HTML markup, which was removed */
  html: boolean;
  /** lines; an empty `spans` array is a blank line (never two in a row, none at the ends) */
  lines: NoteLine[];
  /** every distinct http(s) link, in order of appearance (anchors, Markdown links and bare URLs) */
  links: NoteLink[];
}

/** Only http(s) URLs become links; anything else (javascript:, data:, relative) stays text. */
export function safeHref(href: string | undefined | null): string | undefined {
  const raw = (href ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  rarr: '→',
  larr: '←',
  laquo: '«',
  raquo: '»',
  euro: '€',
  deg: '°',
};

/** Decode the HTML entities that show up in notes (named basics and numeric). Unknown ones stay as they are. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      return String.fromCodePoint(code);
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Tags that look like markup a person (or script) wrote, as opposed to "<guest-ip>" or "a < b" in prose. */
const HTML_TAG =
  /<\/?(a|abbr|b|big|blockquote|br|center|code|dd|del|details|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|s|small|span|strike|strong|sub|summary|sup|table|tbody|td|th|thead|tr|tt|u|ul)\b[^<>]*>/i;

export function looksLikeHtml(text: string): boolean {
  return HTML_TAG.test(text);
}

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'ul',
]);
/** content of these is never text */
const DROP = /<(script|style|template|noscript|iframe|object|svg|math|head|title)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

/** Marker characters for the inline structure the tokenizer finds (private-use code points never typed by people). */
const LINK_OPEN = '\uE000';
const LINK_MID = '\uE001';
const LINK_CLOSE = '\uE002';
const HEAD_OPEN = '\uE003';
const HEAD_CLOSE = '\uE004';
/** a paragraph break (blank line) */
const PARA = '\uE005';
const MARKERS = /[\uE000-\uE005]/g;
/** elements that separate paragraphs (a blank line), not just lines */
const PARAGRAPH = new Set(['p', 'hr', 'blockquote', 'table', 'ul', 'ol', 'dl', 'pre', 'figure', 'details']);

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * Reduce HTML to text with line structure: block elements and <br> break lines, anchors become link markers (their
 * label is their text, or an image's alt text), images and everything else disappear. Source newlines are kept,
 * because Proxmox notes mix Markdown lines and HTML.
 */
function htmlToMarked(html: string): string {
  // HTML (and Markdown) semantics: a single newline is just a space, a blank line separates paragraphs
  const src = html
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(DROP, '')
    .replace(/\n[ \t]*(\n[ \t]*)+/g, PARA)
    .replace(/\n/g, ' ');
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = '';
  let last = 0;
  /** open anchors: their href and where their text started (to fall back on an image's alt text) */
  const anchors: { href?: string; start: number; alt?: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src))) {
    out += decodeEntities(src.slice(last, m.index));
    last = tag.lastIndex;
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';
    if (name === 'br') {
      out += '\n';
    } else if (name === 'a') {
      if (!closing) {
        const href = safeHref(attr(attrs, 'href'));
        anchors.push({ href, start: out.length });
        if (href) out += LINK_OPEN;
      } else {
        const a = anchors.pop();
        if (a?.href) {
          // a link is one line: line breaks inside it (indented markup, block children) become spaces
          const label = out.slice(a.start + 1).replace(/\s*\n\s*/g, ' ');
          out = out.slice(0, a.start + 1) + label;
          // an anchor around an image only: use its alt text as the label
          if (!label.trim() && a.alt) out += a.alt;
          out += `${LINK_MID}${a.href}${LINK_CLOSE}`;
        }
      }
    } else if (name === 'img') {
      const alt = attr(attrs, 'alt')?.trim();
      const open = anchors[anchors.length - 1];
      if (open && alt && !open.alt) open.alt = alt;
    } else if (/^h[1-6]$/.test(name)) {
      out += closing ? `${HEAD_CLOSE}${PARA}` : `${PARA}${HEAD_OPEN}`;
    } else if (PARAGRAPH.has(name)) {
      out += PARA;
    } else if (name === 'li' && !closing) {
      out += '\n• ';
    } else if (name === 'td' || name === 'th') {
      if (closing) out += '  ';
    } else if (BLOCK.has(name)) {
      out += '\n';
    }
  }
  out += decodeEntities(src.slice(last));
  // anchors left open (malformed markup): close them so the markers stay balanced
  while (anchors.length) {
    const a = anchors.pop()!;
    if (a.href) out = `${out.slice(0, a.start + 1)}${out.slice(a.start + 1).replace(/\s*\n\s*/g, ' ')}${LINK_MID}${a.href}${LINK_CLOSE}`;
  }
  return out.replace(/\uE005/g, `\n${PARA}\n`);
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

const MD_LINK = /\[([^\][\n]{1,200})\]\((https?:\/\/[^\s()]+)\)/gi;
const BARE_URL = /\bhttps?:\/\/[^\s<>"'`\uE000-\uE005]+/gi;

/** Split one line into text and link spans: link markers first, then Markdown links, then bare URLs. */
function lineSpans(line: string, links: NoteLink[]): NoteSpan[] {
  const spans: NoteSpan[] = [];
  const addLink = (href: string, label: string) => {
    if (!links.some((l) => l.href === href)) links.push({ href, label });
  };
  const pushText = (text: string) => {
    if (!text) return;
    // Markdown links and bare URLs inside plain text
    const md = new RegExp(MD_LINK.source, 'gi');
    let pos = 0;
    let mm: RegExpExecArray | null;
    const pieces: NoteSpan[] = [];
    while ((mm = md.exec(text))) {
      const href = safeHref(mm[2]);
      if (!href) continue;
      pieces.push(...bare(text.slice(pos, mm.index)));
      const label = mm[1]!.trim() || href;
      pieces.push({ text: label, href });
      addLink(href, label);
      pos = md.lastIndex;
    }
    pieces.push(...bare(text.slice(pos)));
    for (const p of pieces) {
      const prev = spans[spans.length - 1];
      if (!p.href && prev && !prev.href) prev.text += p.text;
      else if (p.text) spans.push(p);
    }
  };
  const bare = (text: string): NoteSpan[] => {
    const out: NoteSpan[] = [];
    let pos = 0;
    let bm: RegExpExecArray | null;
    const re = new RegExp(BARE_URL.source, 'gi');
    while ((bm = re.exec(text))) {
      let url = bm[0];
      // trailing punctuation belongs to the sentence; a ")" only when it doesn't close a "(" of the URL
      while (/[.,;:!?'"\]}>]$/.test(url) || (url.endsWith(')') && count(url, '(') < count(url, ')'))) url = url.slice(0, -1);
      const href = safeHref(url);
      if (!href) continue;
      if (bm.index > pos) out.push({ text: text.slice(pos, bm.index) });
      out.push({ text: url, href });
      addLink(href, url.replace(/^https?:\/\//i, '').replace(/\/$/, ''));
      pos = bm.index + url.length;
      re.lastIndex = pos;
    }
    if (pos < text.length) out.push({ text: text.slice(pos) });
    return out;
  };

  let i = 0;
  while (i < line.length) {
    const open = line.indexOf(LINK_OPEN, i);
    if (open === -1) {
      pushText(line.slice(i));
      break;
    }
    pushText(line.slice(i, open));
    const mid = line.indexOf(LINK_MID, open);
    const close = mid === -1 ? -1 : line.indexOf(LINK_CLOSE, mid);
    if (mid === -1 || close === -1) {
      pushText(line.slice(open + 1));
      break;
    }
    const href = line.slice(mid + 1, close);
    const label = line.slice(open + 1, mid).replace(MARKERS, '').replace(/\s+/g, ' ').trim();
    const shown = label || href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    spans.push({ text: shown, href });
    addLink(href, shown);
    i = close + 1;
  }
  return spans;
}

/** Parse Proxmox notes for display: structure as lines of text and http(s) links, never markup. */
export function parseNotes(text: string | undefined | null): ParsedNotes {
  const src = (text ?? '').replace(/\r\n?/g, '\n').replace(MARKERS, '');
  const html = looksLikeHtml(src);
  const marked = html ? htmlToMarked(src) : src;
  const links: NoteLink[] = [];
  const lines: NoteLine[] = [];
  let headingOpen = false;
  for (const rawLine of marked.split('\n')) {
    // HTML whitespace collapses; plain notes keep their indentation
    let line = html ? rawLine.replace(/[ \t ]+/g, ' ').trim() : rawLine.replace(/\s+$/, '');
    let heading = headingOpen;
    if (line.includes(HEAD_OPEN)) heading = true;
    if (line.includes(HEAD_CLOSE)) headingOpen = false;
    else if (line.includes(HEAD_OPEN)) headingOpen = true;
    const para = line.includes(PARA);
    line = line.replace(/[\uE003-\uE005]/g, '');
    if (html) line = line.trim();
    const md = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (md) {
      line = md[2]!;
      heading = true;
    }
    if (!line.trim()) {
      // plain notes: every empty line is a blank line; HTML: only paragraph breaks are (tags leave empty lines behind)
      if ((!html || para) && lines.length && lines[lines.length - 1]!.spans.length) lines.push({ spans: [] });
      continue;
    }
    const spans = lineSpans(line, links);
    if (!spans.length) continue;
    lines.push(heading ? { spans, heading: true } : { spans });
  }
  while (lines.length && !lines[lines.length - 1]!.spans.length) lines.pop();
  return { html, lines, links };
}
