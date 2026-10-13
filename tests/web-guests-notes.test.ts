import { describe, expect, it } from 'vitest';
import { decodeEntities, looksLikeHtml, parseNotes, safeHref } from '../web/src/pages/guests/detail/notes';

/** What community-scripts (tteck's helper scripts) write into a new LXC's notes. */
const COMMUNITY = `<div align='center'>
  <a href='https://Helper-Scripts.com' target='_blank' rel='noopener noreferrer'>
    <img src='https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/images/logo-81x112.png' alt='Logo' style='width:81px;height:112px;'/>
  </a>

  <h2 style='font-size: 24px; margin: 20px 0;'>Docker LXC</h2>

  <p style='margin: 16px 0;'>
    <a href='https://ko-fi.com/community_scripts' target='_blank' rel='noopener noreferrer'>
      <img src='https://img.shields.io/badge/&#x2615;-Buy us a coffee-blue' alt='spend Coffee' />
    </a>
  </p>

  <span style='margin: 0 10px;'>
    <i class="fa fa-github fa-fw" style="color: #f5f5f5;"></i>
    <a href='https://github.com/community-scripts/ProxmoxVE' target='_blank' rel='noopener noreferrer'>GitHub</a>
  </span>
  <span style='margin: 0 10px;'>
    <a href='https://github.com/community-scripts/ProxmoxVE/discussions' target='_blank'>Discussions</a>
  </span>
  <a href="javascript:alert(1)">evil</a> &amp; 1 &lt; 2
  <script>alert('x')</script><style>body{display:none}</style>
</div>`;

const text = (lines: ReturnType<typeof parseNotes>['lines']) => lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');

describe('guest notes (D48)', () => {
  it('reduces helper-script HTML to its text, keeps headings and only http(s) links', () => {
    const n = parseNotes(COMMUNITY);
    expect(n.html).toBe(true);
    const flat = text(n.lines);
    expect(flat).not.toMatch(/[<>]\s*\/?\s*(div|img|span|a|h2|p)\b/i);
    expect(flat).toContain('Docker LXC');
    expect(flat).toContain('evil & 1 < 2');
    // scripts and styles are dropped, not shown as text
    expect(flat).not.toMatch(/alert\('x'\)|display:none/);
    expect(n.lines.find((l) => l.heading)?.spans[0]?.text).toBe('Docker LXC');
    expect(n.links.map((l) => l.href)).toEqual([
      'https://helper-scripts.com/',
      'https://ko-fi.com/community_scripts',
      'https://github.com/community-scripts/ProxmoxVE',
      'https://github.com/community-scripts/ProxmoxVE/discussions',
    ]);
    // an image-only link is labelled by its alt text; javascript: never becomes a link
    expect(n.links[0]!.label).toBe('Logo');
    const spans = n.lines.flatMap((l) => l.spans);
    expect(spans.find((s) => s.text.includes('evil'))?.href).toBeUndefined();
    expect(spans.every((s) => s.href === undefined || /^https?:\/\//.test(s.href))).toBe(true);
  });

  it('never leaves blank lines at the ends or two in a row', () => {
    const n = parseNotes(COMMUNITY);
    expect(n.lines[0]!.spans.length).toBeGreaterThan(0);
    expect(n.lines.at(-1)!.spans.length).toBeGreaterThan(0);
    for (let i = 1; i < n.lines.length; i++) expect(n.lines[i - 1]!.spans.length + n.lines[i]!.spans.length).toBeGreaterThan(0);
  });

  it('linkifies bare URLs and Markdown links in plain notes, and understands "# Heading"', () => {
    const n = parseNotes('# Media box\nJellyfin at https://jelly.example.com/web/index.html, (see http://x.y/a_(b)).\n\n\n\nSee [docs](https://docs.example.com) ok');
    expect(n.html).toBe(false);
    expect(n.lines[0]).toEqual({ spans: [{ text: 'Media box' }], heading: true });
    expect(n.links).toEqual([
      { href: 'https://jelly.example.com/web/index.html', label: 'jelly.example.com/web/index.html' },
      { href: 'http://x.y/a_(b)', label: 'x.y/a_(b)' },
      { href: 'https://docs.example.com/', label: 'docs' },
    ]);
    // trailing punctuation stays text, the balanced parenthesis belongs to the URL
    const line1 = n.lines[1]!.spans;
    expect(line1.find((s) => s.href?.startsWith('https://jelly'))?.text).toBe('https://jelly.example.com/web/index.html');
    expect(line1.map((s) => s.text).join('')).toBe('Jellyfin at https://jelly.example.com/web/index.html, (see http://x.y/a_(b)).');
    // several blank lines collapse to one
    expect(n.lines.filter((l) => l.spans.length === 0)).toHaveLength(1);
    expect(n.lines.at(-1)!.spans.find((s) => s.href)?.text).toBe('docs');
  });

  it('treats angle brackets in prose as text, not HTML', () => {
    expect(looksLikeHtml('ssh root@<guest-ip> and a < b > c')).toBe(false);
    expect(looksLikeHtml('<b>bold</b>')).toBe(true);
    const n = parseNotes('ssh root@<guest-ip>');
    expect(n.html).toBe(false);
    expect(text(n.lines)).toBe('ssh root@<guest-ip>');
    // inside real HTML notes too: "< b >" with spaces is not a tag (browsers agree)
    expect(text(parseNotes('<b>Note</b>: a < b > c').lines)).toBe('Note: a < b > c');
  });

  it('is empty for missing or blank notes', () => {
    expect(parseNotes(undefined)).toEqual({ html: false, lines: [], links: [] });
    expect(parseNotes('  \n\n ')).toEqual({ html: false, lines: [], links: [] });
  });

  it('only accepts http(s) hrefs without credentials', () => {
    expect(safeHref(' https://pve.lan:8006/ ')).toBe('https://pve.lan:8006/');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,hi')).toBeUndefined();
    expect(safeHref('/relative')).toBeUndefined();
    expect(safeHref('https://user:pw@host/')).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });

  it('decodes common and numeric entities, leaving unknown ones alone', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#x2615; &#169; &nbsp;x &bogus; &#0;')).toBe('a & b <c> ☕ ©  x &bogus; &#0;');
  });
});
