/**
 * Deterministic simulation behind demo mode.
 *
 * Every time-varying number the mock Proxmox API and the mock SSH runner report is a pure function of
 * (world baseline, anchor, time). There is no hidden mutable state apart from memoisation caches, so two simulations
 * with the same anchor return identical values for the same instant (tests rely on this), and the values move
 * smoothly when polled repeatedly (sum of sines seeded per guest, plus piecewise-constant "bursts" for traffic).
 *
 * Time model:
 *  - `anchor` is the instant the world's relative values refer to (uptimeDays, lastBackupHoursAgo, task hoursAgo).
 *    In demo mode it is the process start, so the world "ages" naturally while the demo runs.
 *  - The demo node's local timezone is UTC (backup schedules, vzdump log timestamps, archive file names).
 *
 * Units follow Proxmox: bytes, bytes/s, fractions 0..1 for cpu/iowait, percent for PSI pressure, seconds for uptime.
 */
import { DEMO_GUESTS, DEMO_NODE, type DemoGuest } from './world.js';

export const KiB = 1024;
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const DAY_S = 86_400;
export const HOUR_S = 3_600;

// ───────────────────────────────────────────────────────────── deterministic pseudo-randomness

/** Stable hash of the parts → [0, 1). FNV-1a over the joined string, finished with the murmur3 fmix32 mixer. */
export function hash01(...parts: Array<string | number>): number {
  const s = parts.join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

/** Deterministic number in [lo, hi). */
export const between = (lo: number, hi: number, ...parts: Array<string | number>): number => lo + (hi - lo) * hash01(...parts);

/** Deterministic integer in [0, max). */
export const hashInt = (max: number, ...parts: Array<string | number>): number => Math.floor(hash01(...parts) * max);

/** Deterministic lowercase hex string of `len` characters. */
export function hashHex(len: number, ...parts: Array<string | number>): string {
  let out = '';
  for (let i = 0; out.length < len; i++) out += Math.floor(hash01(...parts, 'hex', i) * 0x1_0000_0000).toString(16).padStart(8, '0');
  return out.slice(0, len);
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

// ───────────────────────────────────────────────────────────── smooth waves (sum of sines)

export interface WaveTerm {
  amp: number;
  omega: number;
  phase: number;
}

/**
 * A sum of sines. `spec` lists [minPeriodSec, maxPeriodSec, amplitude]; the period and phase of each term are derived
 * from `seed`. With amplitudes summing to ≤ 1 the wave stays within [-1, 1].
 */
export function makeWave(seed: string, spec: Array<[number, number, number]>): WaveTerm[] {
  return spec.map(([lo, hi, amp], i) => ({
    amp,
    omega: (2 * Math.PI) / (lo + (hi - lo) * hash01(seed, i, 'period')),
    phase: 2 * Math.PI * hash01(seed, i, 'phase'),
  }));
}

/** A 24 h term whose maximum falls on `peakHourUtc`. */
export function dailyTerm(amp: number, peakHourUtc: number): WaveTerm {
  const omega = (2 * Math.PI) / DAY_S;
  return { amp, omega, phase: Math.PI / 2 - omega * peakHourUtc * HOUR_S };
}

export function waveAt(terms: WaveTerm[], tSec: number): number {
  let v = 0;
  for (const w of terms) v += w.amp * Math.sin(w.omega * tSec + w.phase);
  return v;
}

/** ∫ wave dt over [t0, t1] (closed form, so cumulative counters cost O(terms)). */
export function waveIntegral(terms: WaveTerm[], t0: number, t1: number): number {
  let v = 0;
  for (const w of terms) v += (w.amp / w.omega) * (Math.cos(w.omega * t0 + w.phase) - Math.cos(w.omega * t1 + w.phase));
  return v;
}

/** 0..1 diurnal factor peaking at `peakHourUtc`. */
export function diurnal(tSec: number, peakHourUtc: number): number {
  return 0.5 + 0.5 * waveAt([dailyTerm(1, peakHourUtc)], tSec);
}

// ───────────────────────────────────────────────────────────── rates with exact cumulative counters

/** Burst rate (bytes/s) that is constant within one minute; `minute` = floor(epochSec / 60). */
type BurstFn = (minute: number) => number;

/**
 * Rate(t) = base + Σ sines + burst(minute). base ≥ Σ|amp| keeps it non-negative. The cumulative integral since a start
 * time is exact (closed form for the sines, a memoised running sum for the minute bursts), so counters derived from it
 * grow monotonically and their differences match the instantaneous rates — as real Proxmox counters do.
 */
export class RateModel {
  private cache?: { from: number; to: number; sum: number };

  constructor(
    readonly base: number,
    readonly terms: WaveTerm[],
    private readonly burst?: BurstFn,
  ) {}

  at(tSec: number): number {
    return Math.max(0, this.base + waveAt(this.terms, tSec) + (this.burst ? this.burst(Math.floor(tSec / 60)) : 0));
  }

  /** Bytes transferred over [t0, t1] seconds. */
  integral(t0: number, t1: number): number {
    if (t1 <= t0) return 0;
    let total = this.base * (t1 - t0) + waveIntegral(this.terms, t0, t1);
    if (this.burst) total += this.burstIntegral(t0, t1);
    return Math.max(0, total);
  }

  private burstIntegral(t0: number, t1: number): number {
    const fn = this.burst!;
    const m0 = Math.floor(t0 / 60);
    const m1 = Math.floor(t1 / 60);
    if (m0 === m1) return fn(m0) * (t1 - t0);
    return fn(m0) * ((m0 + 1) * 60 - t0) + this.fullMinutes(m0 + 1, m1) + fn(m1) * (t1 - m1 * 60);
  }

  /** Σ fn(m) * 60 for m in [from, to). Extends the cached prefix when polled forward in time (the common case). */
  private fullMinutes(from: number, to: number): number {
    const fn = this.burst!;
    let start = from;
    let sum = 0;
    const c = this.cache;
    if (c && c.from === from && c.to <= to) {
      start = c.to;
      sum = c.sum;
    }
    for (let m = start; m < to; m++) sum += fn(m) * 60;
    this.cache = { from, to, sum };
    return sum;
  }
}

// ───────────────────────────────────────────────────────────── the simulation

export interface GuestRates {
  netIn: number;
  netOut: number;
  diskRead: number;
  diskWrite: number;
}

export interface GuestCounters {
  netin: number;
  netout: number;
  diskread: number;
  diskwrite: number;
}

export interface Pressure {
  cpuSome: number;
  cpuFull: number;
  ioSome: number;
  ioFull: number;
  memSome: number;
  memFull: number;
}

export interface NodeMemory {
  total: number;
  used: number;
  free: number;
  available: number;
  arc: number;
}

interface GuestModel {
  g: DemoGuest;
  /** epoch ms of the current boot; undefined while stopped */
  bootMs?: number;
  maxmem: number;
  maxdisk: number;
  cpuWave: WaveTerm[];
  memWave: WaveTerm[];
  pressureWave: WaveTerm[];
  net: { in: RateModel; out: RateModel };
  disk: { read: RateModel; write: RateModel };
}

export interface DemoSimOptions {
  /** epoch ms the world's relative values refer to (default: now) */
  anchor?: number;
  /** clock (default Date.now); tests pass a fixed or stepping clock */
  now?: () => number;
}

/** Age of the installation at the anchor (matches the node certificate's age in pveNode.ts). */
export const INSTALLED_DAYS_AGO = 690;

/** Hour (UTC) the evening media peak is centred on. */
const EVENING_PEAK_H = 21;
const STREAM_VMID = 102;
const PROXY_VMID = 103;
const PBS_VMID = 108;

/** The nightly backup job (world: schedule 02:00) runs about half an hour. */
export function inBackupWindow(tSec: number): boolean {
  const s = ((tSec % DAY_S) + DAY_S) % DAY_S;
  return s >= 2 * HOUR_S && s < 2 * HOUR_S + 31 * 60;
}

export class DemoSim {
  readonly anchor: number;
  readonly nodeBootMs: number;
  /** when pve1 was installed (its node certificate is that old too); RRD history starts here */
  readonly installedMs: number;
  private readonly clock: () => number;
  private readonly models = new Map<number, GuestModel>();
  private readonly nodeWave: WaveTerm[];

  constructor(opts: DemoSimOptions = {}) {
    this.clock = opts.now ?? Date.now;
    this.anchor = opts.anchor ?? this.clock();
    this.nodeBootMs = this.anchor - Math.round(DEMO_NODE.uptimeDays * DAY_S * 1000);
    this.installedMs = this.anchor - INSTALLED_DAYS_AGO * DAY_S * 1000;
    this.nodeWave = makeWave('node', [
      [240, 600, 0.45],
      [1500, 3600, 0.35],
      [7200, 18000, 0.2],
    ]);
    for (const g of DEMO_GUESTS) this.models.set(g.vmid, this.buildModel(g));
  }

  now(): number {
    return this.clock();
  }

  guests(): DemoGuest[] {
    return DEMO_GUESTS;
  }

  guest(vmid: number): DemoGuest | undefined {
    return this.models.get(vmid)?.g;
  }

  isRunning(g: DemoGuest): boolean {
    return g.status === 'running' && !g.template;
  }

  /** epoch ms of the guest's current boot, undefined when stopped */
  guestBootMs(g: DemoGuest): number | undefined {
    return this.model(g).bootMs;
  }

  /** seconds */
  guestUptime(g: DemoGuest, tMs: number): number {
    const boot = this.model(g).bootMs;
    return boot === undefined ? 0 : Math.max(0, Math.floor((tMs - boot) / 1000));
  }

  /** allocated memory in bytes (config `memory` MiB × 1024²) */
  guestMaxMem(g: DemoGuest): number {
    return this.model(g).maxmem;
  }

  /** boot disk (qemu) / rootfs (lxc) size in bytes */
  guestMaxDisk(g: DemoGuest): number {
    return this.model(g).maxdisk;
  }

  /*
   * The per-guest metric functions below return 0 only for guests that are stopped now. For instants before the current
   * boot they still return values (the guest's previous run), which RRD history uses; callers mask the reboot gap.
   */

  /** whether the guest was up at tMs: running now, and not inside the short gap of its last restart or the node's */
  guestUpAt(g: DemoGuest, tMs: number): boolean {
    const boot = this.model(g).bootMs;
    if (boot === undefined) return false;
    if (tMs >= boot) return true;
    return tMs < boot - 150_000 && this.nodeUpAt(tMs);
  }

  /** the node exists since its installation and was down for a few minutes around its last reboot */
  nodeUpAt(tMs: number): boolean {
    if (tMs < this.installedMs) return false;
    return !(tMs >= this.nodeBootMs - 180_000 && tMs < this.nodeBootMs + 30_000);
  }

  /** CPU usage fraction of the guest's own vCPUs */
  guestCpu(g: DemoGuest, tMs: number): number {
    const m = this.model(g);
    if (m.bootMs === undefined) return 0;
    const t = tMs / 1000;
    const day = diurnal(t, g.tags.includes('media') ? EVENING_PEAK_H : 14);
    let cpu = g.cpuBase * (0.8 + 0.4 * day) * (1 + 0.3 * waveAt(m.cpuWave, t));
    // Jellyfin transcodes on the iGPU, so a stream costs only a little CPU
    if (g.vmid === STREAM_VMID && this.streamingAt(t)) cpu += 0.05 + 0.02 * waveAt(m.cpuWave, t * 3.1);
    if (inBackupWindow(t)) cpu += g.vmid === PBS_VMID ? 0.35 : 0.02;
    return clamp(cpu, 0.0005, 1);
  }

  /** guest-view memory in use (bytes). lxc: cgroup memory minus page cache; qemu: balloon total − free. */
  guestMem(g: DemoGuest, tMs: number): number {
    const m = this.model(g);
    if (m.bootMs === undefined) return 0;
    return Math.round(m.maxmem * clamp(g.memBase * (1 + 0.05 * waveAt(m.memWave, tMs / 1000)), 0.01, 0.98));
  }

  /** PVE 9 qemu `memhost`: host-side memory of the VM process (bytes) */
  guestMemHost(g: DemoGuest, tMs: number): number {
    const m = this.model(g);
    if (m.bootMs === undefined) return 0;
    const frac = clamp(g.memBase + 0.22 + 0.015 * waveAt(m.memWave, tMs / 1000 + 977), 0.05, 0.97);
    return Math.round(m.maxmem * frac);
  }

  /** lxc rootfs bytes used (0 for qemu: Proxmox has no guest-side disk usage for VMs) */
  guestDiskUsed(g: DemoGuest, tMs: number): number {
    if (g.type !== 'lxc' || this.model(g).bootMs === undefined) return 0;
    const m = this.model(g);
    const growth = ((tMs - this.anchor) / 1000 / DAY_S) * 0.0015; // logs and caches creep up slowly
    return Math.round(m.maxdisk * clamp((g.diskUsed ?? 0.3) + growth + 0.0005 * waveAt(m.memWave, tMs / 1000), 0.01, 0.99));
  }

  /** instantaneous rates in bytes/s (0 while stopped) */
  guestRates(g: DemoGuest, tMs: number): GuestRates {
    const m = this.model(g);
    if (m.bootMs === undefined) return { netIn: 0, netOut: 0, diskRead: 0, diskWrite: 0 };
    const t = tMs / 1000;
    return { netIn: m.net.in.at(t), netOut: m.net.out.at(t), diskRead: m.disk.read.at(t), diskWrite: m.disk.write.at(t) };
  }

  /** cumulative byte counters since the guest's boot (what /cluster/resources and status/current report) */
  guestCounters(g: DemoGuest, tMs: number): GuestCounters {
    const m = this.model(g);
    if (m.bootMs === undefined || tMs <= m.bootMs) return { netin: 0, netout: 0, diskread: 0, diskwrite: 0 };
    const t0 = m.bootMs / 1000;
    const t1 = tMs / 1000;
    return {
      netin: Math.round(m.net.in.integral(t0, t1)),
      netout: Math.round(m.net.out.integral(t0, t1)),
      diskread: Math.round(m.disk.read.integral(t0, t1)),
      diskwrite: Math.round(m.disk.write.integral(t0, t1)),
    };
  }

  /** PSI avg10 of the guest cgroup, percent (PVE 9) */
  guestPressure(g: DemoGuest, tMs: number): Pressure {
    const m = this.model(g);
    if (m.bootMs === undefined) return { cpuSome: 0, cpuFull: 0, ioSome: 0, ioFull: 0, memSome: 0, memFull: 0 };
    const t = tMs / 1000;
    const cpu = this.guestCpu(g, tMs);
    const w = waveAt(m.pressureWave, t);
    const cpuSome = Math.max(0, cpu * 9 + 0.25 * w);
    const ioSome = Math.max(0, (inBackupWindow(t) ? 2.5 : 0.08) + 0.1 * w);
    return {
      cpuSome: round(cpuSome, 2),
      cpuFull: round(cpuSome * 0.35, 2),
      ioSome: round(ioSome, 2),
      ioFull: round(ioSome * 0.6, 2),
      memSome: 0,
      memFull: 0,
    };
  }

  /** whether docker-media is streaming at time t (20-60 Mbit/s bursts) */
  streamingAt(tSec: number): boolean {
    return this.streamRate(Math.floor(tSec / 60)) > 0;
  }

  // ── node

  nodeUptime(tMs: number): number {
    return Math.max(0, Math.floor((tMs - this.nodeBootMs) / 1000));
  }

  /** CPU usage fraction of all host threads */
  nodeCpu(tMs: number): number {
    let used = 0.2 + 0.06 * waveAt(this.nodeWave, tMs / 1000); // pve daemons, zfs, kernel
    for (const g of DEMO_GUESTS) if (this.isRunning(g)) used += this.guestCpu(g, tMs) * g.cores * 1.04;
    return clamp(used / DEMO_NODE.threads, 0.002, 1);
  }

  nodeIoWait(tMs: number): number {
    const t = tMs / 1000;
    return clamp(0.0035 + 0.0025 * waveAt(this.nodeWave, t * 1.7) + (inBackupWindow(t) ? 0.045 : 0), 0, 1);
  }

  /** 1-minute load average */
  nodeLoad1(tMs: number): number {
    return this.nodeCpu(tMs) * DEMO_NODE.threads * 1.12 + this.nodeIoWait(tMs) * DEMO_NODE.threads * 0.6 + 0.08 * (1 + waveAt(this.nodeWave, tMs / 1000 + 333));
  }

  /** 1, 5 and 15 minute load averages */
  nodeLoad(tMs: number): [number, number, number] {
    const avg = (spanS: number) => {
      let s = 0;
      for (let i = 0; i < 5; i++) s += this.nodeLoad1(tMs - (i * spanS * 1000) / 5);
      return s / 5;
    };
    return [round(this.nodeLoad1(tMs), 2), round(avg(300), 2), round(avg(900), 2)];
  }

  nodeMemory(tMs: number): NodeMemory {
    const total = DEMO_NODE.memTotalGiB * GiB;
    const t = tMs / 1000;
    // PVE ≥ 8.1 installs cap the ZFS ARC at 10 % of RAM, so it hovers just below that.
    const arc = Math.round(6.2 * GiB + 0.15 * GiB * waveAt(this.nodeWave, t / 7));
    let used = 2.6 * GiB + 0.1 * GiB * waveAt(this.nodeWave, t / 3) + arc;
    for (const g of DEMO_GUESTS) {
      if (!this.isRunning(g)) continue;
      used += g.type === 'qemu' ? this.guestMemHost(g, tMs) : this.guestMem(g, tMs);
    }
    used = Math.round(Math.min(used, total * 0.97));
    const available = total - used;
    const free = Math.max(0, available - Math.round(2.4 * GiB)); // MemFree excludes reclaimable page cache
    return { total, used, free, available, arc };
  }

  nodeSwap(tMs: number): { total: number; used: number; free: number } {
    const total = DEMO_NODE.swapTotalGiB * GiB;
    const used = Math.round(96 * MiB + 12 * MiB * waveAt(this.nodeWave, tMs / 1000 / 11));
    return { total, used, free: total - used };
  }

  /** root filesystem: total, used (blocks − bfree), avail (bavail), free (bfree) */
  nodeRootFs(tMs: number): { total: number; used: number; avail: number; free: number } {
    const total = Math.round(DEMO_NODE.rootTotalGiB * GiB);
    const growth = ((tMs - this.anchor) / 1000 / DAY_S) * 18 * MiB; // logs, rrd, apt cache
    const used = Math.round(DEMO_NODE.rootUsedGiB * GiB + growth);
    const free = total - used;
    return { total, used, avail: free, free };
  }

  /** physical NIC rates (bytes/s): guest traffic leaving the host; PBS backup traffic stays on the bridge */
  nodeNetRates(tMs: number): { netIn: number; netOut: number } {
    let netIn = 2_400 + 900 * (1 + waveAt(this.nodeWave, tMs / 1000));
    let netOut = 3_100 + 1_200 * (1 + waveAt(this.nodeWave, tMs / 1000 + 51));
    for (const g of DEMO_GUESTS) {
      if (!this.isRunning(g) || g.vmid === PBS_VMID) continue;
      const r = this.guestRates(g, tMs);
      netIn += r.netIn * 0.92;
      netOut += r.netOut * 0.92;
    }
    return { netIn, netOut };
  }

  /** node PSI (percent); the node has no cpu "full" line */
  nodePressure(tMs: number): Omit<Pressure, 'cpuFull'> {
    const cpu = this.nodeCpu(tMs);
    const io = this.nodeIoWait(tMs);
    const w = waveAt(this.nodeWave, tMs / 1000 + 99);
    const ioSome = Math.max(0, io * 110 + 0.05 * w);
    return {
      cpuSome: round(Math.max(0, cpu ** 1.4 * 32 + 0.15 * (1 + w)), 2),
      ioSome: round(ioSome, 2),
      ioFull: round(ioSome * 0.62, 2),
      memSome: 0,
      memFull: 0,
    };
  }

  // ── internals

  private model(g: DemoGuest): GuestModel {
    const m = this.models.get(g.vmid);
    if (!m) throw new Error(`unknown demo guest ${g.vmid}`);
    return m;
  }

  private buildModel(g: DemoGuest): GuestModel {
    const seed = `guest-${g.vmid}`;
    let bootMs: number | undefined;
    if (this.isRunning(g)) {
      bootMs = this.anchor - Math.round((g.uptimeDays ?? 1) * DAY_S * 1000);
      // Guests started at host boot come up a little after the node (onboot ordering).
      if (bootMs <= this.nodeBootMs + 45_000) bootMs = this.nodeBootMs + 45_000 + hashInt(90, seed, 'boot') * 1000;
    }
    const maxmem = g.memoryMiB * MiB;
    const maxdisk = g.diskGiB * GiB;
    const t = (periodsAmp: Array<[number, number, number]>, salt: string) => makeWave(`${seed}-${salt}`, periodsAmp);
    // Traffic profile: [inBase, outBase] bytes/s; waves add ±60 % of the base.
    const profile = NET_PROFILES[g.vmid] ?? [3_000, 3_000];
    const netWave = (base: number, salt: string): RateModel =>
      new RateModel(
        base,
        [dailyTerm(base * 0.3, g.tags.includes('media') ? EVENING_PEAK_H : 15), ...t([[90, 400, base * 0.2], [900, 2400, base * 0.1]], salt)],
        this.burstFor(g.vmid, salt),
      );
    const diskBase = Math.max(2_000, g.cpuBase * 900_000);
    return {
      g,
      bootMs,
      maxmem,
      maxdisk,
      cpuWave: t([[120, 420, 0.5], [900, 2700, 0.3], [5400, 14400, 0.2]], 'cpu'),
      memWave: t([[1800, 5400, 0.6], [14400, 43200, 0.4]], 'mem'),
      pressureWave: t([[60, 240, 1]], 'psi'),
      net: { in: netWave(profile[0], 'in'), out: netWave(profile[1], 'out') },
      disk: {
        read: new RateModel(diskBase * 0.6, t([[150, 600, diskBase * 0.35], [1800, 5400, diskBase * 0.2]], 'dr')),
        write: new RateModel(diskBase, t([[100, 500, diskBase * 0.4], [2400, 7200, diskBase * 0.3]], 'dw')),
      },
    };
  }

  /** Minute-granular traffic bursts: media streaming (and the reverse proxy in front of it), torrents, nightly backups. */
  private burstFor(vmid: number, dir: string): BurstFn | undefined {
    if (vmid === STREAM_VMID) {
      // Jellyfin streams go out, qBittorrent downloads come in.
      return dir === 'out'
        ? (m) => this.streamRate(m)
        : (m) => this.streamRate(m) * 0.04 + this.torrentRate(m);
    }
    if (vmid === PROXY_VMID) {
      // About a third of the streams are remote viewers going through the reverse proxy (in from jellyfin, out to WAN).
      return (m) => this.streamRate(m) * (dir === 'out' ? 0.34 : 0.33);
    }
    if (vmid === PBS_VMID && dir === 'in') {
      return (m) => (inBackupWindow(m * 60) ? between(28, 64, 'pbs-ingest', m) * MiB : 0);
    }
    return undefined;
  }

  /** docker-media streaming rate (bytes/s) for a minute: 20-60 Mbit/s while a 15-minute block is "playing". */
  private streamRate(minute: number): number {
    const block = Math.floor(minute / 15);
    const hour = Math.floor((((block * 15 * 60) % DAY_S) + DAY_S) % DAY_S / HOUR_S);
    const p = hour >= 18 ? 0.6 : hour >= 12 ? 0.25 : hour >= 7 ? 0.12 : 0.05;
    if (hash01('stream-block', block) >= p) return 0;
    const mbit = between(20, 60, 'stream-rate', block) * between(0.85, 1.15, 'stream-jitter', minute);
    return (mbit * 1_000_000) / 8;
  }

  private torrentRate(minute: number): number {
    const block = Math.floor(minute / 30);
    if (hash01('torrent-block', block) >= 0.18) return 0;
    return between(1, 9, 'torrent-rate', block) * between(0.6, 1.2, 'torrent-jitter', minute) * MiB;
  }
}

/** [netIn, netOut] base rates in bytes/s for each guest (traffic seen at the guest's vNIC). */
const NET_PROFILES: Record<number, [number, number]> = {
  100: [6_500, 4_200],
  101: [11_000, 15_500],
  102: [42_000, 28_000],
  103: [21_000, 26_000],
  104: [3_200, 7_400],
  105: [150_000, 220_000],
  107: [8_200, 6_100],
  108: [2_100, 1_300],
  109: [4_100, 3_900],
};
