/**
 * Opt-in edge states of the demo world (PVE1_DASH_DEMO_EDGECASES=1): a paused VM, an unreachable PBS storage, a
 * disabled backup job and a pending config change. Off by default, so the normal demo never shows them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SshTarget } from '../server/config.js';
import { createMockChecker } from '../server/demo/mockChecker.js';
import { startMockProxmox, type MockProxmox } from '../server/demo/mockProxmox.js';
import { createMockRunner } from '../server/demo/mockRunner.js';
import { DemoSim, EDGE_PAUSED_VMID } from '../server/demo/sim.js';

/** Saturday 2026-10-10 19:00 UTC */
const ANCHOR = Date.UTC(2026, 9, 10, 19, 0, 0);
const PAUSED_AT = ANCHOR + 12 * 60_000; // 19:12, inside the pause window
const PBS_DOWN_AT = ANCHOR + 45 * 60_000; // 19:45, PBS unreachable
const NORMAL_AT = ANCHOR + 25 * 60_000; // 19:25, nothing special
const TOKEN = 'PVEAPIToken=pve1dash@pve!dashboard=00000000-0000-0000-0000-000000000000';
const HOST: SshTarget = { address: '10.10.20.10', port: 22, user: 'root' };

let clock = ANCHOR;
let edge: MockProxmox;
let plain: MockProxmox;

beforeAll(async () => {
  edge = await startMockProxmox({ sim: new DemoSim({ anchor: ANCHOR, now: () => clock, edgeCases: true }), latency: false });
  plain = await startMockProxmox({ sim: new DemoSim({ anchor: ANCHOR, now: () => clock }), latency: false });
});
afterAll(async () => {
  await edge.close();
  await plain.close();
});

async function get(pve: MockProxmox, path: string): Promise<{ status: number; body: { data: any; message?: string } }> {
  const res = await fetch(`${pve.url}/api2/json${path}`, { headers: { Authorization: TOKEN } });
  return { status: res.status, body: (await res.json()) as { data: any; message?: string } };
}
const data = async (pve: MockProxmox, path: string) => {
  const r = await get(pve, path);
  expect(r.status, `${path}: ${r.body.message}`).toBe(200);
  return r.body.data;
};

describe('paused VM (edge cases)', () => {
  it('reports the QMP state in cluster/resources and qmpstatus, keeping memory and uptime', async () => {
    clock = PAUSED_AT;
    const vm = (await data(edge, '/cluster/resources?type=vm')).find((r: any) => r.vmid === EDGE_PAUSED_VMID);
    expect(vm).toMatchObject({ status: 'paused', cpu: 0 });
    expect(vm.mem).toBeGreaterThan(0);
    expect(vm.memhost).toBeGreaterThan(0);
    expect(vm.uptime).toBeGreaterThan(0);
    // without full=1 the list has only the process state; with it, qmpstatus
    const list = (await data(edge, '/nodes/pve1/qemu')).find((r: any) => r.vmid === EDGE_PAUSED_VMID);
    expect(list.status).toBe('running');
    expect(list.qmpstatus).toBeUndefined();
    const full = (await data(edge, '/nodes/pve1/qemu?full=1')).find((r: any) => r.vmid === EDGE_PAUSED_VMID);
    expect(full).toMatchObject({ status: 'running', qmpstatus: 'paused' });
    // its guest agent cannot answer
    const agent = await get(edge, `/nodes/pve1/qemu/${EDGE_PAUSED_VMID}/agent/network-get-interfaces`);
    expect(agent).toEqual({ status: 500, body: { data: null, message: 'QEMU guest agent is not running\n' } });
  });

  it('resumes outside the window, and the default demo never pauses it', async () => {
    clock = NORMAL_AT;
    expect((await data(edge, '/cluster/resources?type=vm')).find((r: any) => r.vmid === EDGE_PAUSED_VMID).status).toBe('running');
    clock = PAUSED_AT;
    expect((await data(plain, '/cluster/resources?type=vm')).find((r: any) => r.vmid === EDGE_PAUSED_VMID).status).toBe('running');
  });

  it('the host helper skips the paused VM and its services time out', async () => {
    const stdout = async (sim: DemoSim) => (await createMockRunner({ sim, delays: false }).run(HOST, 'inventory', 120_000)).stdout;
    const guestsIn = (out: string) => [...out.matchAll(/^@@pve1-dash:guest (\d+)/gm)].map((m) => Number(m[1]));
    expect(guestsIn(await stdout(new DemoSim({ anchor: ANCHOR, now: () => PAUSED_AT, edgeCases: true })))).not.toContain(EDGE_PAUSED_VMID);
    expect(guestsIn(await stdout(new DemoSim({ anchor: ANCHOR, now: () => NORMAL_AT, edgeCases: true })))).toContain(EDGE_PAUSED_VMID);

    const check = createMockChecker({ sim: new DemoSim({ anchor: ANCHOR, now: () => PAUSED_AT, edgeCases: true }), sleep: false });
    expect(await check({ type: 'tcp', target: '10.10.20.40:2283', insecureTls: false, timeoutMs: 5000 })).toEqual({ ok: false, message: 'timeout after 5s' });
    const normal = createMockChecker({ sim: new DemoSim({ anchor: ANCHOR, now: () => NORMAL_AT, edgeCases: true }), sleep: false });
    expect((await normal({ type: 'tcp', target: '10.10.20.40:2283', insecureTls: false, timeoutMs: 5000 })).ok).toBe(true);
  });
});

describe('unreachable PBS storage (edge cases)', () => {
  it('reports pbs as inactive and fails its listings, then recovers', async () => {
    clock = PBS_DOWN_AT;
    const storages = await data(edge, '/nodes/pve1/storage?content=backup');
    expect(storages.find((s: any) => s.storage === 'pbs')).toMatchObject({ enabled: 1, active: 0, total: 0, used: 0, avail: 0 });
    expect(storages.find((s: any) => s.storage === 'nas-backups')).toMatchObject({ active: 1 });
    const prune = await get(edge, '/nodes/pve1/storage/pbs/prunebackups?prune-backups=keep-all%3D1');
    expect(prune.status).toBe(500);
    expect(prune.body.message).toMatch(/^pbs: error fetching datastores/);
    const helper = await createMockRunner({ sim: new DemoSim({ anchor: ANCHOR, now: () => PBS_DOWN_AT, edgeCases: true }), delays: false }).run(HOST, 'backups pbs', 120_000);
    expect(helper.code).toBe(255);
    expect(helper.stderr).toMatch(/^pbs: error fetching datastores/);
    expect((await data(edge, '/cluster/resources?type=storage')).find((s: any) => s.storage === 'pbs').status).toBe('unknown');

    clock = NORMAL_AT;
    expect((await data(edge, '/nodes/pve1/storage?content=backup')).find((s: any) => s.storage === 'pbs')).toMatchObject({ active: 1 });
    expect((await data(edge, '/nodes/pve1/storage/pbs/prunebackups?prune-backups=keep-all%3D1')).length).toBeGreaterThan(0);
    clock = PBS_DOWN_AT;
    expect((await data(plain, '/nodes/pve1/storage?content=backup')).find((s: any) => s.storage === 'pbs')).toMatchObject({ active: 1 });
  });
});

describe('disabled job and pending config (edge cases)', () => {
  it('lists a disabled job that still has a next-run and still covers its guest', async () => {
    clock = NORMAL_AT;
    const jobs = await data(edge, '/cluster/backup');
    expect(jobs.map((j: any) => j.id)).toEqual(['backup-nightly', 'backup-weekly-nas', 'backup-sandbox-offsite']);
    expect(jobs[2]).toMatchObject({ enabled: 0, vmid: '110', 'next-run': expect.any(Number) });
    expect((await data(edge, '/cluster/backup-info/not-backed-up')).map((g: any) => g.vmid)).toEqual([108, 9000]);
    expect((await data(plain, '/cluster/backup')).map((j: any) => j.id)).toEqual(['backup-nightly', 'backup-weekly-nas']);
  });

  it('merges a pending memory change unless current=1', async () => {
    expect((await data(edge, `/nodes/pve1/qemu/${EDGE_PAUSED_VMID}/config`)).memory).toBe('16384');
    expect((await data(edge, `/nodes/pve1/qemu/${EDGE_PAUSED_VMID}/config?current=1`)).memory).toBe('12288');
    expect((await data(plain, `/nodes/pve1/qemu/${EDGE_PAUSED_VMID}/config`)).memory).toBe('12288');
  });
});
