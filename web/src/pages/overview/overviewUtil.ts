/**
 * Pure helpers for Overview cards (departures order, temperature grouping, guest ranking). Tested in
 * tests/web-overview-attention.test.ts.
 */
import type { Guest, ServiceEntry, ServiceStatus, TempReading } from '../../../../shared/types';
import { plural } from '../../format';
import type { GuestsUpdateSummary } from '../guests/guestUtil';

// ───────────────────────────────────────────────────────────── departures

/** Most relevant first: down, slow, not yet checked, up, paused (guest stopped). */
const DEPARTURE_RANK: Record<ServiceStatus, number> = { down: 0, slow: 1, unknown: 2, up: 3, paused: 4 };

/** Services ordered for the MiniBoard: by status relevance, then most recent change, then name. */
export function departureOrder(services: readonly ServiceEntry[]): ServiceEntry[] {
  return [...services].sort(
    (a, b) =>
      (DEPARTURE_RANK[a.status] ?? 5) - (DEPARTURE_RANK[b.status] ?? 5) || (b.lastChange ?? 0) - (a.lastChange ?? 0) || a.name.localeCompare(b.name),
  );
}

/**
 * The services starred on this device (D49), in the order they were starred; ids that no longer exist are skipped.
 * At most `max`.
 */
export function favouriteServices(services: readonly ServiceEntry[], favourites: readonly string[], max = 12): ServiceEntry[] {
  if (!favourites.length) return [];
  const byId = new Map(services.map((s) => [s.id, s] as const));
  const out: ServiceEntry[] = [];
  for (const id of favourites) {
    const s = byId.get(id);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** A launcher URL the browser can open (http/https only). */
export function openableUrl(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

// ───────────────────────────────────────────────────────────── guests

/** Running guests with the highest CPU use (non-templates), at most `n`. */
export function topByCpu(guests: readonly Guest[], n = 5): Guest[] {
  return guests
    .filter((g) => g.status === 'running' && !g.template)
    .sort((a, b) => b.cpu - a.cpu || a.vmid - b.vmid)
    .slice(0, n);
}

// ───────────────────────────────────────────────────────────── updates inside guests

/** "5 guests have updates · 2 need a reboot" (empty when there is nothing pending). */
export function updatesLine(u: GuestsUpdateSummary): string {
  const parts: string[] = [];
  if (u.guests) parts.push(`${plural(u.guests, 'guest')} ${u.guests === 1 ? 'has' : 'have'} updates`);
  if (u.reboot) parts.push(`${u.reboot} need${u.reboot === 1 ? 's' : ''} a reboot`);
  return parts.join(' · ');
}

// ───────────────────────────────────────────────────────────── temperatures

export type TempTone = 'ok' | 'warn' | 'crit';

/** Colour only from the sensor's own limits (lm-sensors high/crit) — no invented thresholds. */
export function tempTone(r: Pick<TempReading, 'celsius' | 'highC' | 'critC'>): TempTone {
  if (r.critC !== undefined && r.critC > 0 && r.celsius >= r.critC) return 'crit';
  if (r.highC !== undefined && r.highC > 0 && r.celsius >= r.highC) return 'warn';
  return 'ok';
}

const CHIPS: [RegExp, string][] = [
  [/^(k10temp|coretemp|zenpower|cpu_thermal|cpu-thermal)/i, 'CPU'],
  [/^nvme/i, 'NVMe drive'],
  [/^drivetemp/i, 'Drive'],
  [/^(amdgpu|radeon|nouveau|i915|xe)/i, 'GPU'],
  [/^(nct|it8|f71|w83|asus|acpitz|pch_|thinkpad|dell)/i, 'Mainboard'],
  [/^iwlwifi/i, 'Wi-Fi'],
  [/^(bnxt|mlx|ixgbe|igb|i40e|ice|r8169|enp|eth)/i, 'Network card'],
];

/** "k10temp-pci-00c3" → "CPU", "nvme-pci-0100" → "NVMe drive", unknown chips → their driver name. */
export function chipName(source: string): string {
  for (const [re, name] of CHIPS) if (re.test(source)) return name;
  return source.split('-')[0] || source;
}

/** Labels that name a chip's headline reading, best first. */
const PRIMARY_LABEL = [/^tctl$/i, /^tdie$/i, /^package id \d+$/i, /^composite$/i, /^edge$/i, /^cpu ?temp$/i];

export interface TempRow {
  /** stable key (the sensor chip) */
  key: string;
  /** "CPU", "NVMe drive 2", "GPU" … */
  title: string;
  /** the chip's other readings ("Sensor 1 44 °C · Sensor 2 48 °C"), or its headline label when alone */
  subtitle: string;
  /** the chip, e.g. "nvme-pci-0100" (tooltip) */
  source: string;
  /** the headline reading */
  reading: TempReading;
  /** worst tone across the chip's readings */
  tone: TempTone;
}

export interface TempGroup {
  kind: TempReading['kind'];
  label: string;
  rows: TempRow[];
}

const GROUP_LABEL: Record<TempReading['kind'], string> = { cpu: 'Processor', disk: 'Drives', other: 'Other sensors' };
const TONE_ORDER: Record<TempTone, number> = { ok: 0, warn: 1, crit: 2 };

const fmt = (c: number) => `${Math.abs(c) < 10 ? Math.round(c * 10) / 10 : Math.round(c)} °C`;

/** Headline reading of a chip: a well-known label (Tctl, Package id 0, Composite, edge), else the first one. */
function primaryOf(list: readonly TempReading[]): TempReading {
  for (const re of PRIMARY_LABEL) {
    const hit = list.find((t) => re.test(t.label.trim()));
    if (hit) return hit;
  }
  return list[0]!;
}

/**
 * One row per sensor chip, grouped as Processor / Drives / Other. The row shows the chip's headline reading and
 * lists the rest in the subtitle; chips sharing a friendly name are numbered ("NVMe drive 1", "NVMe drive 2").
 */
export function groupTemps(temps: readonly TempReading[]): TempGroup[] {
  const valid = temps.filter((t) => Number.isFinite(t.celsius));
  const bySource = new Map<string, TempReading[]>();
  for (const t of valid) {
    const list = bySource.get(t.source) ?? [];
    list.push(t);
    bySource.set(t.source, list);
  }
  const groups: TempGroup[] = [];
  for (const kind of ['cpu', 'disk', 'other'] as const) {
    const chips = [...bySource.entries()].filter(([, list]) => (primaryOf(list).kind ?? 'other') === kind);
    if (!chips.length) continue;
    const perName = new Map<string, number>();
    for (const [source] of chips) perName.set(chipName(source), (perName.get(chipName(source)) ?? 0) + 1);
    const seen = new Map<string, number>();
    const rows = chips.map(([source, list]): TempRow => {
      const name = chipName(source);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const primary = primaryOf(list);
      const others = list.filter((t) => t !== primary);
      const tone = list.map(tempTone).reduce<TempTone>((a, b) => (TONE_ORDER[b] > TONE_ORDER[a] ? b : a), 'ok');
      let subtitle: string;
      if (!others.length) subtitle = primary.label;
      else if (others.length <= 2) subtitle = others.map((t) => `${t.label} ${fmt(t.celsius)}`).join(' · ');
      else subtitle = `${others.length} more sensors, up to ${fmt(Math.max(...others.map((t) => t.celsius)))}`;
      return { key: source, title: perName.get(name)! > 1 ? `${name} ${n}` : name, subtitle, source, reading: primary, tone };
    });
    groups.push({ kind, label: GROUP_LABEL[kind], rows });
  }
  return groups;
}

/** The hottest reading (for the card subtitle). */
export function hottest(temps: readonly TempReading[]): TempReading | undefined {
  let best: TempReading | undefined;
  for (const t of temps) if (Number.isFinite(t.celsius) && (!best || t.celsius > best.celsius)) best = t;
  return best;
}
