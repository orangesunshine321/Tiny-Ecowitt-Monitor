/**
 * Pure icon helpers (no DOM, no JSX) shared by AppIcon/OsIcon and unit-tested in tests/web-icons.test.ts.
 */

/** homarr-labs/dashboard-icons via jsDelivr (allowed by the server's CSP img-src). */
export const DASHBOARD_ICONS_BASE = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons';

/** Resolve an icon reference: absolute/relative URLs pass through; anything else is a dashboard-icons slug (webp). */
export function iconUrl(icon: string): string {
  const v = icon.trim();
  if (/^(https?:|data:|blob:)/i.test(v) || v.startsWith('/') || v.startsWith('./') || /\.(png|svg|webp|jpe?g|ico|gif|avif)(\?.*)?$/i.test(v)) return v;
  return `${DASHBOARD_ICONS_BASE}/webp/${encodeURIComponent(v.toLowerCase())}.webp`;
}

/** Up to two initials: "Home Assistant" → "HA", "jellyfin" → "J", "pve1-dash" → "PD". */
export function monogram(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-./]+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0]![0]!.toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * Map an OS name / PVE ostype to a dashboard-icons slug (real slugs per research: debian-linux, ubuntu-linux,
 * alpine-linux, microsoft-windows, home-assistant, proxmox, …). Undefined when unknown.
 */
export function osSlug(os?: string, ostype?: string): string | undefined {
  const s = `${os ?? ''} ${ostype ?? ''}`.toLowerCase();
  if (/home assistant|\bhaos\b/.test(s)) return 'home-assistant';
  if (/proxmox backup/.test(s)) return 'proxmox';
  if (/proxmox/.test(s)) return 'proxmox';
  if (/truenas/.test(s)) return 'truenas-scale';
  if (/openmediavault/.test(s)) return 'openmediavault';
  if (/debian/.test(s)) return 'debian-linux';
  if (/ubuntu/.test(s)) return 'ubuntu-linux';
  if (/alpine/.test(s)) return 'alpine-linux';
  if (/arch/.test(s)) return 'arch-linux';
  if (/fedora/.test(s)) return 'fedora';
  if (/rocky/.test(s)) return 'rocky-linux';
  if (/centos/.test(s)) return 'centos';
  if (/suse/.test(s)) return 'opensuse';
  if (/nixos/.test(s)) return 'nixos';
  if (/windows|\bwin(xp|vista|7|8|10|11)\b|\bw2k\d*\b|\bwvista\b|\bwxp\b/.test(s)) return 'microsoft-windows';
  if (/\bl2[46]\b|linux/.test(s)) return 'linux';
  return undefined;
}
