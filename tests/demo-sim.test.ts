import { describe, expect, it } from 'vitest';
import { DemoSim, hash01, RateModel, makeWave } from '../server/demo/sim.js';
import { nearestRun, nextRun, prevRun } from '../server/demo/schedule.js';
import { DEMO_GUESTS } from '../server/demo/world.js';
import { demoBackups, demoTasks, fmtCtime } from '../server/demo/history.js';
import { humanDuration, dockerPorts } from '../server/demo/guestInventory.js';
import { formatSensorsJson, perlPrettyJson } from '../server/demo/mockRunner.js';

const ANCHOR = Date.UTC(2026, 9, 10, 19, 0, 0);
const g = (vmid: number) => DEMO_GUESTS.find((x) => x.vmid === vmid)!;

describe('simulation', () => {
  it('is deterministic for the same anchor', () => {
    const a = new DemoSim({ anchor: ANCHOR, now: () => ANCHOR });
    const b = new DemoSim({ anchor: ANCHOR, now: () => ANCHOR });
    for (const t of [ANCHOR, ANCHOR + 12_345, ANCHOR - 86_400_000]) {
      for (const guest of DEMO_GUESTS) {
        expect(a.guestCpu(guest, t)).toBe(b.guestCpu(guest, t));
        expect(a.guestCounters(guest, t)).toEqual(b.guestCounters(guest, t));
      }
      expect(a.nodeMemory(t)).toEqual(b.nodeMemory(t));
      expect(a.nodeLoad(t)).toEqual(b.nodeLoad(t));
    }
    expect(hash01('x', 1)).toBe(hash01('x', 1));
    expect(hash01('x', 1)).not.toBe(hash01('x', 2));
  });

  it('keeps values around the world baselines', () => {
    const sim = new DemoSim({ anchor: ANCHOR });
    for (const guest of DEMO_GUESTS.filter((x) => x.status === 'running')) {
      let cpu = 0;
      let mem = 0;
      const n = 288;
      for (let i = 0; i < n; i++) {
        const t = ANCHOR - i * 300_000;
        cpu += sim.guestCpu(guest, t);
        mem += sim.guestMem(guest, t) / sim.guestMaxMem(guest);
      }
      expect(mem / n, guest.name).toBeCloseTo(guest.memBase, 1);
      if (guest.vmid !== 102) expect(cpu / n / guest.cpuBase, guest.name).toBeGreaterThan(0.7);
      if (guest.vmid !== 102) expect(cpu / n / guest.cpuBase, guest.name).toBeLessThan(1.4);
    }
  });

  it('reports nothing for stopped guests and templates', () => {
    const sim = new DemoSim({ anchor: ANCHOR });
    for (const vmid of [106, 110, 9000]) {
      expect(sim.guestCpu(g(vmid), ANCHOR)).toBe(0);
      expect(sim.guestUptime(g(vmid), ANCHOR)).toBe(0);
      expect(sim.guestCounters(g(vmid), ANCHOR)).toEqual({ netin: 0, netout: 0, diskread: 0, diskwrite: 0 });
    }
  });

  it('grows uptime from the world values', () => {
    const sim = new DemoSim({ anchor: ANCHOR });
    expect(sim.guestUptime(g(102), ANCHOR)).toBe(Math.round(6.2 * 86400));
    expect(sim.guestUptime(g(102), ANCHOR + 3_600_000) - sim.guestUptime(g(102), ANCHOR)).toBe(3600);
    expect(sim.nodeUptime(ANCHOR)).toBe(Math.round(23.4 * 86400));
    // guests that came up with the node boot shortly after it
    expect(sim.guestBootMs(g(101))!).toBeGreaterThan(sim.nodeBootMs);
  });

  it('accumulates counters monotonically, consistent with the rates', () => {
    const sim = new DemoSim({ anchor: ANCHOR });
    for (const vmid of [100, 102, 105, 108]) {
      let prev = sim.guestCounters(g(vmid), ANCHOR);
      for (let i = 1; i <= 30; i++) {
        const t = ANCHOR + i * 60_000;
        const cur = sim.guestCounters(g(vmid), t);
        for (const k of ['netin', 'netout', 'diskread', 'diskwrite'] as const) expect(cur[k]).toBeGreaterThanOrEqual(prev[k]);
        // the rate over a 10 s step matches the instantaneous rate (bursts are constant per minute)
        const t1 = t + 20_000;
        const t2 = t1 + 10_000;
        const delta = (sim.guestCounters(g(vmid), t2).netout - sim.guestCounters(g(vmid), t1).netout) / 10;
        const rate = sim.guestRates(g(vmid), t1 + 5_000).netOut;
        expect(Math.abs(delta - rate)).toBeLessThan(Math.max(50, rate * 0.05));
        prev = cur;
      }
    }
  });

  it('streams 20-60 Mbit/s from docker-media in bursts, mostly in the evening', () => {
    const sim = new DemoSim({ anchor: ANCHOR });
    const base = Date.UTC(2026, 9, 5, 0, 0, 0);
    let evening = 0;
    let night = 0;
    for (let m = 0; m < 7 * 24 * 60; m += 5) {
      const t = base + m * 60_000;
      const out = sim.guestRates(g(102), t).netOut;
      const streaming = sim.streamingAt(t / 1000);
      if (streaming) {
        expect(out * 8).toBeGreaterThan(15e6);
        expect(out * 8).toBeLessThan(75e6);
        const h = new Date(t).getUTCHours();
        if (h >= 18) evening++;
        else if (h < 7) night++;
      } else expect(out * 8).toBeLessThan(2e6);
    }
    expect(evening).toBeGreaterThan(night * 3);
    // the apps VM stays moderate
    const apps = sim.guestRates(g(105), ANCHOR);
    expect(apps.netOut).toBeGreaterThan(20_000);
    expect(apps.netOut).toBeLessThan(1_000_000);
  });

  it('keeps node memory consistent', () => {
    const sim = new DemoSim({ anchor: ANCHOR });
    const m = sim.nodeMemory(ANCHOR);
    expect(m.used + m.available).toBe(m.total);
    expect(m.used / m.total).toBeGreaterThan(0.3);
    expect(m.used / m.total).toBeLessThan(0.9);
    expect(m.arc).toBeGreaterThan(5 * 1024 ** 3);
    const cpu = sim.nodeCpu(ANCHOR);
    expect(cpu).toBeGreaterThan(0.02);
    expect(cpu).toBeLessThan(0.5);
  });

  it('integrates rate models exactly', () => {
    const model = new RateModel(1000, makeWave('t', [[60, 120, 400]]), (m) => (m % 2 === 0 ? 500 : 0));
    let numeric = 0;
    for (let s = 1000; s < 1600; s += 0.25) numeric += model.at(s + 0.125) * 0.25;
    expect(model.integral(1000, 1600)).toBeCloseTo(numeric, -1);
    expect(model.integral(1000, 1300) + model.integral(1300, 1600)).toBeCloseTo(model.integral(1000, 1600), 3);
  });
});

describe('schedules and history', () => {
  it('computes vzdump calendar events in node time (UTC)', () => {
    const sat19 = ANCHOR / 1000;
    expect(nextRun('02:00', sat19)).toBe(Date.UTC(2026, 9, 11, 2, 0) / 1000);
    expect(nextRun('sun 03:30', sat19)).toBe(Date.UTC(2026, 9, 11, 3, 30) / 1000);
    expect(nextRun('mon..fri 22:00', sat19)).toBe(Date.UTC(2026, 9, 12, 22, 0) / 1000);
    expect(nextRun('*/6:00', sat19)).toBe(Date.UTC(2026, 9, 11, 0, 0) / 1000);
    expect(nextRun('nonsense', sat19)).toBeUndefined();
    expect(prevRun('02:00', sat19)).toBe(Date.UTC(2026, 9, 10, 2, 0) / 1000);
    expect(nearestRun('02:00', sat19 - 20 * 3600, sat19)).toBe(Date.UTC(2026, 9, 10, 2, 0) / 1000);
  });

  it('aligns backups and vzdump tasks to the job schedules', () => {
    const sim = new DemoSim({ anchor: ANCHOR });
    const tasks = demoTasks(sim, ANCHOR);
    const failed = tasks.find((t) => t.status === 'job errors')!;
    expect(new Date(failed.starttime * 1000).toISOString()).toBe('2026-10-10T02:00:00.000Z');
    expect(failed.endtime! - failed.starttime).toBe(1840);
    const backups = demoBackups(sim);
    // every guest backed up in the failed run (all but 105) has a snapshot from it
    const inRun = backups.filter((b) => b.storage === 'pbs' && b.ctime >= failed.starttime && b.ctime <= failed.endtime!).map((b) => b.vmid);
    expect(inRun.sort()).toEqual([100, 101, 102, 103, 104, 107, 109]);
    const weekly = backups.filter((b) => b.vmid === 106);
    expect(weekly.map((b) => new Date(b.ctime * 1000).getUTCDay())).toEqual([0, 0, 0]);
  });

  it('formats like the tools it imitates', () => {
    expect(fmtCtime(Date.UTC(2026, 9, 9, 2, 0, 13) / 1000)).toBe('Fri Oct  9 02:00:13 2026');
    expect(humanDuration(30)).toBe('30 seconds');
    expect(humanDuration(90)).toBe('About a minute');
    expect(humanDuration(3 * 3600)).toBe('3 hours');
    expect(humanDuration(6.2 * 86400)).toBe('6 days');
    expect(humanDuration(20 * 86400)).toBe('2 weeks');
    expect(dockerPorts({ name: 'x', image: 'x', ports: ['443:443', '80:80', '81:81'], state: 'running' }, ['53/udp'])).toBe(
      '0.0.0.0:80-81->80-81/tcp, [::]:80-81->80-81/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp, 53/udp',
    );
    expect(perlPrettyJson({ b: 1, a: 'x"y' })).toBe('{\n   "a" : "x\\"y",\n   "b" : 1\n}\n');
    expect(formatSensorsJson({ 'k10temp-pci-00c3': { Adapter: 'PCI adapter', Tctl: { temp1_input: 41.5 } } })).toBe(
      '{\n   "k10temp-pci-00c3":{\n      "Adapter": "PCI adapter",\n      "Tctl":{\n         "temp1_input": 41.500\n      }\n   }\n}\n',
    );
  });
});
