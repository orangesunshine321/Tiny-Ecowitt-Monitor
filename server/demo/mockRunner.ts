/**
 * Mock SSH CommandRunner for demo mode: plays the two forced-command helpers of docs/HELPER_PROTOCOL.md.
 *
 *  - pve1 host (10.10.20.10): /usr/local/sbin/pve1-dash-helper — version | inventory [vmid] | sensors | pkgupdates |
 *    backups <storage>, with the helper's allow-list ("denied" + exit 1 otherwise). Root's chatty .bashrc prints one
 *    line before every output, as on real hosts.
 *  - guests reached directly (world `inventoryVia: 'ssh'`, e.g. PBS at 10.10.20.60): pve1-dash-guest-inventory —
 *    inventory | version, raw inner script output.
 *  - anything else: OpenSSH-style "Connection refused", exit 255.
 *
 * Commands take a plausible amount of time; when that exceeds the caller's timeout the result mirrors the real runner
 * (code null, partial stdout, "ssh: command timed out" on stderr).
 */
import type { SshTarget } from '../config.js';
import type { CommandResult, CommandRunner, Logger } from '../context.js';
import { DEMO_GUESTS, DEMO_NODE, DEMO_STORAGE, DEMO_UPDATES, DEMO_DISKS, type DemoGuest } from './world.js';
import { DemoSim, between, waveAt, makeWave } from './sim.js';
import { backupsOnStorage, contentItem } from './history.js';
import { innerInventory } from './guestInventory.js';
import { agentEnabled } from './pveGuests.js';
import { diskTempC } from './pveStorage.js';

export interface MockRunnerOptions {
  sim?: DemoSim;
  log?: Logger;
  /** simulate command durations (default true); tests turn it off */
  delays?: boolean;
}

const HELPER_PROTOCOL = 1;
const RE_LINE = /^[A-Za-z0-9._ -]*$/;
const RE_VMID = /^[0-9]{1,9}$/;
const RE_STORAGE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export interface Simulated extends CommandResult {
  /** how long the command takes on the "remote" side, ms */
  durationMs: number;
}

const ok = (stdout: string, durationMs: number, stderr = ''): Simulated => ({ stdout, stderr, code: 0, durationMs });
const fail = (code: number, stderr: string, durationMs = 40, stdout = ''): Simulated => ({ stdout, stderr, code, durationMs });

export function createMockRunner(opts: MockRunnerOptions = {}): CommandRunner {
  const sim = opts.sim ?? new DemoSim();
  const delays = opts.delays ?? true;
  const log = opts.log;
  let closed = false;
  const pending = new Map<NodeJS.Timeout, () => void>();

  function simulate(target: SshTarget, command: string): Simulated {
    const now = sim.now();
    const port = target.port ?? 22;
    if (target.address === DEMO_NODE.ip) {
      if (port !== 22) return fail(255, `ssh: connect to host ${target.address} port ${port}: Connection refused\n`, 5);
      if (target.user !== 'root') return fail(255, `${target.user}@${target.address}: Permission denied (publickey).\n`, 90);
      const r = hostHelper(sim, command, now);
      // sshd runs the forced command through root's login shell; this host's .bashrc greets every session
      return { ...r, stdout: bashrcNoise(sim, now) + r.stdout };
    }
    const guest = DEMO_GUESTS.find((g) => g.ip === target.address && g.inventoryVia === 'ssh');
    if (guest) {
      if (!sim.isRunning(guest)) return fail(255, `ssh: connect to host ${target.address} port ${port}: No route to host\n`, 3_000);
      if (port !== 22) return fail(255, `ssh: connect to host ${target.address} port ${port}: Connection refused\n`, 5);
      if (target.user !== 'root') return fail(255, `${target.user}@${target.address}: Permission denied (publickey).\n`, 90);
      return guestHelper(sim, guest, command, now);
    }
    return fail(255, `ssh: connect to host ${target.address} port ${port}: Connection refused\n`, 5);
  }

  return {
    run(target: SshTarget, command: string, timeoutMs: number): Promise<CommandResult> {
      if (closed) return Promise.reject(new Error('ssh runner is closed'));
      let r: Simulated;
      try {
        r = simulate(target, command);
      } catch (err) {
        log?.error('mock runner failed', { target: target.address, command, err });
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      const handshake = target.address === DEMO_NODE.ip ? 60 : 110;
      const total = r.durationMs + handshake;
      const timedOut = total > timeoutMs;
      const result: CommandResult = timedOut
        ? {
            // the helpers stream framed output, so a client that gives up early still has the beginning
            stdout: r.stdout.slice(0, Math.floor((r.stdout.length * Math.max(0, timeoutMs - handshake)) / Math.max(1, r.durationMs))),
            stderr: `${r.stderr}ssh: command timed out after ${Math.round(timeoutMs / 100) / 10}s\n`,
            code: null,
          }
        : { stdout: r.stdout, stderr: r.stderr, code: r.code };
      log?.debug('mock ssh', { target: target.address, command, code: result.code, ms: Math.min(total, timeoutMs) });
      if (!delays) return Promise.resolve(result);
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(t);
          pending.delete(t);
          resolve(result);
        };
        const t = setTimeout(finish, Math.min(total, timeoutMs));
        pending.set(t, finish);
      });
    },
    close(): void {
      closed = true;
      // commands already in flight still resolve (with their result), just without waiting
      for (const finish of [...pending.values()]) finish();
    },
  };
}

// ───────────────────────────────────────────────────────────── host helper

/** One line a chatty /root/.bashrc prints (here: `uptime`), before the helper's own output. */
function bashrcNoise(sim: DemoSim, now: number): string {
  const d = new Date(now);
  const hhmmss = d.toISOString().slice(11, 19);
  const up = sim.nodeUptime(now);
  const days = Math.floor(up / 86_400);
  const h = Math.floor((up % 86_400) / 3600);
  const m = Math.floor((up % 3600) / 60);
  const load = sim.nodeLoad(now).map((v) => v.toFixed(2)).join(', ');
  return ` ${hhmmss} up ${days} days, ${String(h).padStart(2, ' ')}:${String(m).padStart(2, '0')},  1 user,  load average: ${load}\n`;
}

const denied = (): Simulated => fail(1, 'denied\n', 15);

export function hostHelper(sim: DemoSim, cmdline: string, now: number): Simulated {
  if (cmdline.length > 200 || !RE_LINE.test(cmdline)) return denied();
  const argv = cmdline.split(' ').filter(Boolean);
  const n = argv.length;
  switch (argv[0] ?? 'inventory') {
    case 'version':
      return n === 1 ? ok(`pve1-dash-helper ${HELPER_PROTOCOL}\n`, 20) : denied();
    case 'inventory':
      if (n <= 1) return hostInventory(sim, undefined, now);
      if (n === 2 && RE_VMID.test(argv[1]!)) return hostInventory(sim, Number(argv[1]), now);
      return denied();
    case 'sensors':
      return n === 1 ? ok(sensorsJson(sim, now), 70) : denied();
    case 'pkgupdates':
      // /var/lib/pve-manager/pkgupdates: encode_json output, a single line without trailing newline
      return n === 1 ? ok(JSON.stringify(DEMO_UPDATES), 25) : denied();
    case 'backups':
      if (n !== 2 || !RE_STORAGE.test(argv[1]!)) return denied();
      return pveshBackups(sim, argv[1]!, now);
    default:
      return denied();
  }
}

/** `pvesh get /nodes/pve1/storage/<id>/content --content backup --output-format json` run as root. */
function pveshBackups(sim: DemoSim, storage: string, now: number): Simulated {
  const s = DEMO_STORAGE.find((x) => x.id === storage);
  if (!s) return fail(255, `storage '${storage}' does not exist\n`, 900);
  // edge cases: PBS unreachable for a few minutes (PVE gives up connecting after a while)
  if (!sim.storageActive(storage, now)) {
    return fail(255, `${storage}: error fetching datastores - 500 Can't connect to 10.10.20.60:8007 (No route to host)\n`, 3_000);
  }
  if (!s.content.includes('backup')) return ok('[]\n', 800);
  const items = backupsOnStorage(sim, storage).map(contentItem);
  // PBS answers are slower (PVE lists the datastore snapshots over HTTPS)
  return ok(`${JSON.stringify(items)}\n`, s.type === 'pbs' ? 1_400 : 600);
}

/**
 * Running LXCs (pct exec) and running VMs with an enabled agent (qm guest exec), in vmid order. Like the real helper,
 * a VM counts as running by its QMP state, so a paused VM is skipped.
 */
function inspectable(sim: DemoSim, now: number): DemoGuest[] {
  return DEMO_GUESTS.filter((g) => !g.template && sim.runState(g, now) === 'running' && (g.type === 'lxc' || agentEnabled(g))).sort(
    (a, b) => a.vmid - b.vmid,
  );
}

/** `qm guest exec` result as qm prints it: Perl JSON pretty + canonical (3-space indent, " : ", sorted keys). */
export function perlPrettyJson(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `   ${JSON.stringify(k)} : ${JSON.stringify(obj[k])}`).join(',\n');
  return `{\n${body}\n}\n`;
}

function guestBlock(sim: DemoSim, g: DemoGuest, now: number): { text: string; ms: number } {
  const head = `@@pve1-dash:guest ${g.vmid} ${g.type} ${g.type === 'lxc' ? 'pct-exec' : 'qm-guest-exec'}\n`;
  if (g.type === 'lxc') {
    // a guest must not forge framing lines: the helper prefixes "@@" lines with a space
    const inner = innerInventory(sim, g, now).replace(/^@@/gm, ' @@');
    return { text: `${head}${inner}@@pve1-dash:end ${g.vmid} 0\n`, ms: 350 + between(0, 500, 'pct', g.vmid) };
  }
  if (g.inventoryVia !== 'qm-guest-exec') {
    // e.g. Home Assistant OS: its guest agent answers, but guest-exec is disabled in that build of qemu-ga.
    // `qm guest exec` dies with the QGA error (QEMU's exact "disabled" wording varies by version; UNVERIFIED).
    return {
      text: `${head}@@pve1-dash:error VM ${g.vmid} qga command 'guest-exec' failed - Command guest-exec has been disabled\n@@pve1-dash:end ${g.vmid} 255\n`,
      ms: 400,
    };
  }
  const wrapped = perlPrettyJson({ exitcode: 0, exited: 1, 'out-data': innerInventory(sim, g, now), 'out-truncated': 0 });
  return { text: `${head}${wrapped}@@pve1-dash:end ${g.vmid} 0\n`, ms: 1_200 + between(0, 800, 'qga', g.vmid) };
}

function hostInventory(sim: DemoSim, vmid: number | undefined, now: number): Simulated {
  const guests = inspectable(sim, now).filter((g) => vmid === undefined || g.vmid === vmid);
  let out = `@@pve1-dash:inventory v${HELPER_PROTOCOL}\n`;
  // `pvesh get /nodes/pve1/{lxc,qemu}` first, then at most 4 guests in parallel
  let ms = 1_100;
  const lanes = [0, 0, 0, 0];
  for (const g of guests) {
    const b = guestBlock(sim, g, now);
    out += b.text;
    const lane = lanes.indexOf(Math.min(...lanes));
    lanes[lane]! += b.ms;
  }
  ms += Math.max(...lanes);
  out += '@@pve1-dash:done\n';
  return ok(out, ms);
}

// ───────────────────────────────────────────────────────────── sensors -j

type Chip = Record<string, string | Record<string, number>>;

/** Exactly how `sensors -j` lays its JSON out (3-space indent, `"Feature":{`, values with 3 decimals). */
export function formatSensorsJson(chips: Record<string, Chip>): string {
  const chipBlocks = Object.entries(chips).map(([chip, features]) => {
    const entries = Object.entries(features).map(([name, v]) => {
      if (typeof v === 'string') return `      ${JSON.stringify(name)}: ${JSON.stringify(v)}`;
      const sub = Object.entries(v).map(([k, x]) => `         ${JSON.stringify(k)}: ${x.toFixed(3)}`);
      return `      ${JSON.stringify(name)}:{\n${sub.join(',\n')}\n      }`;
    });
    return `   ${JSON.stringify(chip)}:{\n${entries.join(',\n')}\n   }`;
  });
  return `{\n${chipBlocks.join(',\n')}\n}\n`;
}

export function sensorsJson(sim: DemoSim, now: number): string {
  const cpu = sim.nodeCpu(now);
  const w = waveAt(makeWave('tctl', [[40, 160, 0.6], [600, 1800, 0.4]]), now / 1000);
  const tctl = 37.5 + cpu * 58 + 1.8 * w;
  const q = (v: number, step: number) => Math.round(v / step) * step;
  const diskTemp = (dev: string) => q(diskTempC(sim, dev, now) ?? 35, 1);
  const nvme = (dev: string, max: number, crit: number): Chip => {
    const t = q((diskTempC(sim, dev, now) ?? 40) + 0.85, 1) - 0.15;
    return {
      Adapter: 'PCI adapter',
      Composite: { temp1_input: t, temp1_max: max, temp1_min: -273.15, temp1_crit: crit, temp1_alarm: 0 },
      'Sensor 1': { temp2_input: t, temp2_max: 65261.85, temp2_min: -273.15 },
      'Sensor 2': { temp3_input: t + 4, temp3_max: 65261.85, temp3_min: -273.15 },
    };
  };
  const drive = (dev: string): Chip => {
    const t = diskTemp(dev);
    return {
      Adapter: 'SCSI adapter',
      temp1: { temp1_input: t, temp1_max: 65, temp1_min: 0, temp1_crit: 70, temp1_lcrit: -40, temp1_lowest: 21, temp1_highest: t + 9 },
    };
  };
  const sata = DEMO_DISKS.filter((d) => d.devpath.startsWith('/dev/sd'));
  const nvmes = DEMO_DISKS.filter((d) => d.type === 'nvme');
  const chips: Record<string, Chip> = {
    'amdgpu-pci-0500': {
      Adapter: 'PCI adapter',
      vddgfx: { in0_input: 0.993 },
      vddnb: { in1_input: 0.968 },
      edge: { temp1_input: q(tctl - 2.5, 1) },
      PPT: { power1_average: q(8 + cpu * 40, 1) },
    },
    'k10temp-pci-00c3': { Adapter: 'PCI adapter', Tctl: { temp1_input: q(tctl, 0.125) } },
    'nct6798-isa-0290': {
      Adapter: 'ISA adapter',
      in0: { in0_input: 0.304, in0_min: 0, in0_max: 1.744, in0_alarm: 0, in0_beep: 0 },
      fan2: { fan2_input: q(820 + cpu * 900 + 30 * w, 1), fan2_min: 0, fan2_alarm: 0, fan2_beep: 0, fan2_pulses: 2 },
      SYSTIN: { temp1_input: q(31 + 0.8 * w, 0.5), temp1_max: 80, temp1_max_hyst: 75, temp1_alarm: 0, temp1_type: 4, temp1_offset: 0, temp1_beep: 0 },
      CPUTIN: { temp2_input: q(tctl - 6, 0.5), temp2_max: 80, temp2_max_hyst: 75, temp2_alarm: 0, temp2_type: 4, temp2_offset: 0, temp2_beep: 0 },
    },
  };
  nvmes.forEach((d, i) => {
    chips[`nvme-pci-0${i === 0 ? '1' : '4'}00`] = nvme(d.devpath, i === 0 ? 81.85 : 84.85, i === 0 ? 84.85 : 89.85);
  });
  sata.forEach((d, i) => {
    chips[`drivetemp-scsi-${i}-0`] = drive(d.devpath);
  });
  return formatSensorsJson(chips);
}

// ───────────────────────────────────────────────────────────── guest helper (direct SSH)

export function guestHelper(sim: DemoSim, g: DemoGuest, cmdline: string, now: number): Simulated {
  const cmd = cmdline.trim() || 'inventory';
  if (cmd === 'version') return ok('pve1-dash-guest-inventory 1\n', 20);
  if (cmd !== 'inventory') return denied();
  return ok(innerInventory(sim, g, now), 420);
}
