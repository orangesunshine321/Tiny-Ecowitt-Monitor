import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guest, GuestInventory, HostInventory } from '../shared/types.js';
import { ConfigSchema, type SshTarget } from '../server/config.js';
import type { AppContext, CommandResult, CommandRunner, HostHelper, Logger } from '../server/context.js';
import { Store } from '../server/state.js';
import { createHostHelper } from '../server/inventory/hostHelper.js';
import { createInventoryService, mergeInventory, pruneInventory } from '../server/inventory/index.js';
import { parseHostInventory } from '../server/inventory/parse.js';

const FIX = join(import.meta.dirname, 'fixtures/inventory');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'pve1-dash-inventory-service-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function logger(lines: string[]): Logger {
  const l: Logger = {
    debug: (m, e) => void lines.push(`debug ${m}${e ? ' ' + JSON.stringify(e) : ''}`),
    info: (m, e) => void lines.push(`info ${m}${e ? ' ' + JSON.stringify(e) : ''}`),
    warn: (m, e) => void lines.push(`warn ${m}${e ? ' ' + JSON.stringify(e) : ''}`),
    error: (m, e) => void lines.push(`error ${m}${e ? ' ' + JSON.stringify(e) : ''}`),
    child: () => l,
  };
  return l;
}

function makeCtx(inventory: Record<string, unknown>, logs: string[] = []): AppContext {
  const config = ConfigSchema.parse({
    proxmox: { url: 'https://10.10.20.10:8006', tokenId: 'pve1dash@pve!dashboard', tokenSecret: 'x' },
    inventory,
  });
  const store = new Store(
    {
      appVersion: 'test',
      title: 'pve1',
      demo: false,
      pveUiUrl: 'https://10.10.20.10:8006',
      inventoryEnabled: config.inventory.enabled,
      pushEnabled: false,
      board: { title: 'DEPARTURES', station: 'PVE1', sound: false },
      thresholds: { storageWarnPercent: 85, storageCritPercent: 95, backupStaleDays: 7, slowMs: 1500, wearWarnPercent: 80 },
    },
    'pve1',
  );
  return { config, store, log: logger(logs), dataDir: tmp, appVersion: 'test' };
}

type Handler = (target: SshTarget, command: string) => CommandResult | Error | Promise<CommandResult | Error>;
class FakeRunner implements CommandRunner {
  calls: Array<{ target: SshTarget; command: string; timeoutMs: number }> = [];
  constructor(public handler: Handler) {}
  async run(target: SshTarget, command: string, timeoutMs: number): Promise<CommandResult> {
    this.calls.push({ target, command, timeoutMs });
    const r = await this.handler(target, command);
    if (r instanceof Error) throw r;
    return r;
  }
  close() {}
}

const HOST = { address: '10.10.20.10' };
const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', code: 0 });

// ───────────────────────────────────────────────────────────── host helper

describe('host helper', () => {
  it('is unavailable without inventory.enabled or a host, and never calls the runner', async () => {
    for (const inv of [{ enabled: false, host: HOST }, { enabled: true }]) {
      const runner = new FakeRunner(() => ok(''));
      const h = createHostHelper(makeCtx(inv), runner);
      expect(h.available()).toBe(false);
      expect(await h.guests()).toBeNull();
      expect(await h.host()).toBeNull();
      expect(await h.pkgUpdates()).toBeNull();
      expect(await h.backups('local')).toBeNull();
      expect(runner.calls).toEqual([]);
    }
  });

  it('collects guest inventories', async () => {
    const runner = new FakeRunner(() => ok(fixture('host-inventory.txt')));
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }), runner);
    expect(h.available()).toBe(true);
    const all = await h.guests();
    expect(all!.map((g) => g.vmid)).toEqual([100, 101, 105, 106, 107, 109, 110, 111]);
    expect(runner.calls[0]).toEqual({ target: { address: '10.10.20.10', port: 22, user: 'root' }, command: 'inventory', timeoutMs: 120_000 });
    const one = await h.guests(101);
    expect(one!.map((g) => g.vmid)).toEqual([101]);
    expect(runner.calls[1]).toMatchObject({ command: 'inventory 101', timeoutMs: 90_000 });
    expect(await h.guests(-5)).toBeNull();
    expect(await h.guests(1.5)).toBeNull();
    expect(runner.calls).toHaveLength(2);
  });

  it('returns null on failures and rate-limits the warnings', async () => {
    const logs: string[] = [];
    const runner = new FakeRunner(() => new Error('ssh root@10.10.20.10: connection refused (is sshd running?)'));
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }, logs), runner);
    expect(await h.guests()).toBeNull();
    expect(await h.guests()).toBeNull();
    expect(logs.filter((l) => l.startsWith('warn'))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('debug host helper "inventory" failed'))).toHaveLength(1);
    expect(h.lastError('inventory')).toBe('host helper "inventory" failed: ssh root@10.10.20.10: connection refused (is sshd running?)');

    runner.handler = () => ok(fixture('host-inventory.txt'));
    expect(await h.guests()).not.toBeNull();
    expect(h.lastError('inventory')).toBeUndefined();
    expect(logs).toContain('info host helper inventory is working again');

    runner.handler = () => ({ stdout: '', stderr: 'denied\n', code: 1 });
    expect(await h.pkgUpdates()).toBeNull();
    expect(h.lastError('pkgupdates')).toMatch(/denied by \/usr\/local\/sbin\/pve1-dash-helper/);

    runner.handler = () => ({ stdout: 'Welcome to pve1\n', stderr: 'bash: pve1-dash-helper: command not found\n', code: 127 });
    expect(await h.guests()).toBeNull();
    expect(h.lastError('inventory')).toBe('host helper returned no inventory: bash: pve1-dash-helper: command not found');
  });

  it('keeps finished guests when the inventory is cut off', async () => {
    const full = fixture('host-inventory.txt');
    const cut = full.slice(0, full.indexOf('@@pve1-dash:guest 106'));
    const runner = new FakeRunner(() => ({ stdout: cut + '@@pve1-dash:guest 106 qemu qm-guest-exec\n{\n', stderr: 'ssh: command timed out after 120s\n', code: null }));
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }), runner);
    const r = await h.guests();
    expect(r!.map((g) => [g.vmid, g.ok])).toEqual([
      [100, false],
      [101, true],
      [105, true],
      [106, false],
    ]);
    expect(r![3]!.error).toBe('helper output was cut off before this guest finished');
  });

  it('treats a helper that gave up (non-zero exit, no done line) as failed', async () => {
    const runner = new FakeRunner(() => ({
      stdout: '@@pve1-dash:inventory v1\n',
      stderr: 'cannot list the guests of node pve1 (pvesh and pct/qm list failed)\n',
      code: 2,
    }));
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }), runner);
    expect(await h.guests()).toBeNull();
    expect(h.lastError('inventory')).toBe('host helper inventory failed: cannot list the guests of node pve1 (pvesh and pct/qm list failed)');
  });

  it('reads host sensors', async () => {
    const runner = new FakeRunner(() => ok(`motd line\n${fixture('sensors-intel.json')}`));
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }), runner);
    const r = await h.host();
    expect(r).toMatchObject({ ok: true, sensorsAvailable: true });
    expect(r!.temps.map((t) => t.label)).toEqual(['Package id 0', 'Core 0', 'Core 4', 'temp1', 'Composite']);
    expect(runner.calls[0]).toMatchObject({ command: 'sensors', timeoutMs: 30_000 });

    runner.handler = () => ({ stdout: '', stderr: 'lm-sensors not installed\n', code: 3 });
    expect(await h.host()).toMatchObject({ ok: true, sensorsAvailable: false, temps: [] });

    runner.handler = () => ({ stdout: '', stderr: 'No sensors found!\nMake sure you loaded all the kernel drivers you need.\n', code: 1 });
    expect(await h.host()).toMatchObject({ ok: true, sensorsAvailable: true, temps: [] });

    runner.handler = () => ({ stdout: 'garbage', stderr: 'boom\n', code: 2 });
    expect(await h.host()).toBeNull();
    expect(h.lastError('sensors')).toBe('host sensors output could not be read: boom');
  });

  it('passes pkgupdates and backups through as raw arrays', async () => {
    const runner = new FakeRunner((_t, cmd) => {
      if (cmd === 'pkgupdates') return ok(fixture('pkgupdates.json'));
      if (cmd === 'backups local') return ok('[{"volid":"local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst","vmid":101}]\n');
      return { stdout: '', stderr: "storage 'nas' does not exist\n", code: 255 };
    });
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }), runner);
    expect((await h.pkgUpdates())!.map((p) => (p as { Package: string }).Package)).toEqual(['pve-manager', 'proxmox-kernel-6.14.11-3-pve-signed', 'openssl']);
    expect(await h.backups('local')).toEqual([{ volid: 'local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst', vmid: 101 }]);
    expect(await h.backups('nas')).toBeNull();
    expect(h.lastError('backups:nas')).toBe(`host helper "backups nas" returned no JSON array: storage 'nas' does not exist`);
    for (const bad of ['../../etc', '', '-rf', 'a b', 'x'.repeat(65), 'local;id']) expect(await h.backups(bad)).toBeNull();
    expect(runner.calls.map((c) => c.command)).toEqual(['pkgupdates', 'backups local', 'backups nas']);
  });
});

// ───────────────────────────────────────────────────────────── merge / prune

const inv = (vmid: number, over: Partial<GuestInventory> = {}): GuestInventory => ({
  vmid,
  source: 'pct-exec',
  collectedAt: 1000,
  ok: true,
  ips: [],
  services: [],
  containers: [],
  ports: [],
  ...over,
});

describe('merging and pruning', () => {
  it('keeps the last good data when a guest fails', () => {
    const prev = { '101': inv(101, { kernel: '6.1', collectedAt: 1000 }), '102': inv(102, { ok: false, error: 'old', collectedAt: 1000 }) };
    const next = mergeInventory(prev, [
      inv(101, { ok: false, error: 'timeout after 25s', collectedAt: 2000 }),
      inv(102, { ok: false, error: 'new', collectedAt: 2000 }),
      inv(103, { kernel: '6.2', collectedAt: 2000 }),
    ]);
    expect(next['101']).toEqual(inv(101, { kernel: '6.1', collectedAt: 1000, ok: false, error: 'timeout after 25s' }));
    // nothing worth keeping: replaced
    expect(next['102']).toEqual(inv(102, { ok: false, error: 'new', collectedAt: 2000 }));
    expect(next['103']!.kernel).toBe('6.2');
    // a later success replaces everything, including the error
    expect(mergeInventory(next, [inv(101, { kernel: '6.3', collectedAt: 3000 })])['101']).toEqual(inv(101, { kernel: '6.3', collectedAt: 3000 }));
  });

  it('prunes guests that are gone, after an hour', () => {
    const map = { '1': inv(1, { collectedAt: 0 }), '2': inv(2, { collectedAt: 0 }), '3': inv(3, { collectedAt: 3_000_000 }) };
    expect(pruneInventory(map, null, 10_000_000)).toBe(map);
    expect(Object.keys(pruneInventory(map, new Set([1]), 3_700_000))).toEqual(['1', '3']);
    expect(Object.keys(pruneInventory(map, new Set([1, 2, 3]), 99_000_000))).toEqual(['1', '2', '3']);
  });
});

// ───────────────────────────────────────────────────────────── service

function fakeHostHelper(): HostHelper & {
  guestsFn: ReturnType<typeof vi.fn>;
  hostFn: ReturnType<typeof vi.fn>;
} {
  const guestsFn = vi.fn(async (_vmid?: number): Promise<GuestInventory[] | null> => parseHostInventory(fixture('host-inventory.txt'), Date.now())!.inventories);
  const hostFn = vi.fn(async (): Promise<HostInventory | null> => ({
    collectedAt: Date.now(),
    ok: true,
    sensorsAvailable: true,
    temps: [{ label: 'Tctl', source: 'k10temp-pci-00c3', celsius: 47.6, kind: 'cpu' }],
  }));
  return {
    available: () => true,
    guests: (vmid?: number) => guestsFn(vmid),
    host: () => hostFn(),
    pkgUpdates: async () => null,
    backups: async () => null,
    guestsFn,
    hostFn,
  };
}

describe('inventory service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const setup = (inventory: Record<string, unknown> = { enabled: true, host: HOST, guests: [{ vmid: 108, address: '10.10.20.60' }] }) => {
    const logs: string[] = [];
    const ctx = makeCtx(inventory, logs);
    const helper = fakeHostHelper();
    const runner = new FakeRunner((t) => (t.address === '10.10.20.60' ? ok(fixture('inner-busybox.txt')) : new Error('unexpected target')));
    const svc = createInventoryService(ctx, { runner, hostHelper: helper });
    return { ctx, helper, runner, svc, logs };
  };

  it('sweeps on start and on every interval, writing inventory and hostInventory', async () => {
    const { ctx, helper, runner, svc } = setup();
    svc.start();
    svc.start(); // idempotent
    expect(helper.guestsFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(helper.guestsFn).toHaveBeenCalledTimes(1);
    expect(helper.hostFn).toHaveBeenCalledTimes(1);
    expect(runner.calls).toEqual([{ target: { address: '10.10.20.60', port: 22, user: 'root' }, command: 'inventory', timeoutMs: 60_000 }]);

    const inventory = ctx.store.get('inventory');
    expect(Object.keys(inventory).sort()).toEqual(['100', '101', '105', '106', '107', '108', '109', '110', '111']);
    expect(inventory['108']).toMatchObject({ source: 'ssh', ok: true, kernel: '6.12.48-0-lts' });
    expect(inventory['101']).toMatchObject({ source: 'pct-exec', ok: true });
    expect(ctx.store.get('hostInventory')).toMatchObject({ ok: true, temps: [{ label: 'Tctl' }] });
    const collectors = Object.fromEntries(ctx.store.collectorStatus().map((c) => [c.name, c]));
    expect(collectors.inventory).toMatchObject({ intervalSec: 300, lastSuccess: Date.now() });
    expect(collectors.sensors).toMatchObject({ intervalSec: 300 });

    // next sweep: 101 fails; its last good data stays, flagged
    const firstCollected = inventory['101']!.collectedAt;
    helper.guestsFn.mockImplementation(async () => [
      { vmid: 101, source: 'pct-exec', collectedAt: Date.now(), ok: false, error: 'timeout after 25s', ips: [], services: [], containers: [], ports: [] },
    ]);
    helper.hostFn.mockImplementation(async () => null);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(helper.guestsFn).toHaveBeenCalledTimes(2);
    const after = ctx.store.get('inventory');
    expect(after['101']).toMatchObject({ ok: false, error: 'timeout after 25s', collectedAt: firstCollected, kernel: '6.14.11-2-pve' });
    expect(after['105']!.ok).toBe(true); // not visited this time: untouched
    expect(ctx.store.get('hostInventory')).toMatchObject({ ok: false, error: 'host helper unavailable', temps: [{ label: 'Tctl' }] });
    expect(ctx.store.collectorStatus().find((c) => c.name === 'sensors')!.lastError).toBe('host helper unavailable');

    // host helper down entirely
    helper.guestsFn.mockImplementation(async () => null);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(ctx.store.collectorStatus().find((c) => c.name === 'inventory')!.lastError).toBe('host helper inventory failed');
    expect(ctx.store.get('inventory')['105']!.ok).toBe(true);

    svc.stop();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(helper.guestsFn).toHaveBeenCalledTimes(3);
  });

  it('rate-limits refreshes: 30 s for everything, 10 s per guest', async () => {
    const { ctx, helper, runner, svc } = setup();
    ctx.store.set('guests', [101, 105, 108].map((vmid) => ({ vmid }) as Guest));
    svc.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(helper.guestsFn).toHaveBeenCalledTimes(1);

    await svc.refresh();
    expect(helper.guestsFn).toHaveBeenCalledTimes(1); // the sweep just ran
    await vi.advanceTimersByTimeAsync(30_000);
    await svc.refresh();
    expect(helper.guestsFn).toHaveBeenCalledTimes(2);

    helper.guestsFn.mockImplementation(async (vmid?: number) =>
      parseHostInventory(fixture('host-inventory.txt'), Date.now())!.inventories.filter((g) => vmid === undefined || g.vmid === vmid),
    );
    await svc.refresh(101);
    expect(helper.guestsFn).toHaveBeenLastCalledWith(101);
    expect(helper.guestsFn).toHaveBeenCalledTimes(3);
    await svc.refresh(101);
    expect(helper.guestsFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    await svc.refresh(101);
    expect(helper.guestsFn).toHaveBeenCalledTimes(4);
    expect(ctx.store.get('inventory')['101']!.collectedAt).toBe(Date.now());

    // unknown guests are ignored; direct-SSH guests go over SSH
    await svc.refresh(4242);
    expect(helper.guestsFn).toHaveBeenCalledTimes(4);
    const sshCalls = runner.calls.length;
    await svc.refresh(108);
    expect(runner.calls.length).toBe(sshCalls + 1);
    expect(helper.guestsFn).toHaveBeenCalledTimes(4);
    svc.stop();
  });

  it('ignores single-guest refreshes while the guest list is unknown (except direct-SSH guests)', async () => {
    const { ctx, helper, runner, svc, logs } = setup();
    svc.start();
    await vi.advanceTimersByTimeAsync(1500); // first sweep done; Proxmox has not delivered a guest list
    expect(ctx.store.get('guests')).toEqual([]);
    const sweeps = helper.guestsFn.mock.calls.length;
    const ssh = runner.calls.length;
    for (let vmid = 1; vmid <= 500; vmid++) await svc.refresh(vmid);
    expect(helper.guestsFn.mock.calls.length).toBe(sweeps); // no helper run for arbitrary vmids
    expect(logs.filter((l) => l.startsWith('debug inventory refresh ignored')).length).toBe(499);
    // only vmid 108, configured for direct SSH, was refreshed
    expect(runner.calls.slice(ssh).map((c) => c.target.address)).toEqual(['10.10.20.60']);
    svc.stop();
  });

  it('runs at most two single-guest refreshes at once and prunes its rate-limit memory', async () => {
    const { ctx, helper, svc } = setup();
    const vmids = Array.from({ length: 12 }, (_, i) => 200 + i);
    ctx.store.set('guests', vmids.map((vmid) => ({ vmid }) as Guest));
    svc.start();
    await vi.advanceTimersByTimeAsync(1500);
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    helper.guestsFn.mockImplementation(async (vmid?: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1000));
      running--;
      done.push(vmid!);
      return [];
    });
    const all = Promise.all(vmids.map((v) => svc.refresh(v)));
    await vi.advanceTimersByTimeAsync(1);
    expect(running).toBe(2);
    await vi.advanceTimersByTimeAsync(6000);
    await all;
    expect(peak).toBe(2);
    expect(done.sort()).toEqual(vmids);
    // every vmid is rate limited for 10 s, then allowed again
    await svc.refresh(200);
    expect(helper.guestsFn).toHaveBeenCalledTimes(1 + vmids.length);
    await vi.advanceTimersByTimeAsync(10_000);
    const p = svc.refresh(200);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(helper.guestsFn).toHaveBeenCalledTimes(2 + vmids.length);
    svc.stop();
  });

  it('restarts cleanly while a sweep is still running', async () => {
    const { helper, svc } = setup();
    let release!: () => void;
    helper.guestsFn.mockImplementationOnce(() => new Promise<GuestInventory[]>((r) => (release = () => r([]))));
    svc.start();
    await vi.advanceTimersByTimeAsync(1500); // first sweep starts and hangs
    svc.stop();
    svc.start();
    release();
    await vi.advanceTimersByTimeAsync(1500); // the new loop's first sweep
    expect(helper.guestsFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(helper.guestsFn).toHaveBeenCalledTimes(3); // exactly one loop is running
    svc.stop();
  });

  it('records direct SSH failures per guest', async () => {
    const { ctx, runner, svc } = setup({ enabled: true, guests: [{ vmid: 108, address: '10.10.20.60' }] });
    runner.handler = () => new Error('ssh root@10.10.20.60: connection refused (is sshd running?)');
    svc.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(ctx.store.get('inventory')['108']).toMatchObject({
      ok: false,
      source: 'ssh',
      error: 'ssh root@10.10.20.60: connection refused (is sshd running?)',
    });
    // without a host, all-direct failures mark the collector as failing; no hostInventory is written
    expect(ctx.store.collectorStatus().find((c) => c.name === 'inventory')!.lastError).toMatch(/connection refused/);
    expect(ctx.store.get('hostInventory')).toBeUndefined();
    svc.stop();
  });

  it('does nothing when disabled', async () => {
    for (const cfg of [{ enabled: false, host: HOST, guests: [{ vmid: 108, address: '10.10.20.60' }] }, { enabled: true }]) {
      const { ctx, helper, runner, svc, logs } = setup(cfg);
      svc.start();
      await vi.advanceTimersByTimeAsync(600_000);
      await svc.refresh();
      await svc.refresh(101);
      expect(helper.guestsFn).not.toHaveBeenCalled();
      expect(runner.calls).toEqual([]);
      expect(ctx.store.get('inventory')).toEqual({});
      expect(logs.some((l) => l.startsWith('info inventory'))).toBe(true);
    }
  });

  it('reads the public key next to the private key', () => {
    const key = join(tmp, 'id_ed25519');
    const { svc } = setup({ enabled: true, host: HOST, privateKey: key });
    expect(svc.publicKey()).toBeUndefined();
    writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH pve1-dash@pve1-dash\n');
    expect(svc.publicKey()).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH pve1-dash@pve1-dash');
    writeFileSync(`${key}.pub`, 'not a key\n');
    expect(svc.publicKey()).toBeUndefined();
  });
});
