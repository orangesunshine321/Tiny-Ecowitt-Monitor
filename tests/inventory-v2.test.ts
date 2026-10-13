/**
 * Helper protocol v2: the df / updates / reboot sections, `hostinfo`, quick inventories, partial output, the
 * "not inspectable by design" classification and the shared virtual-interface filter. v1 output must keep parsing.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestInventory } from '../shared/types.js';
import { ConfigSchema, type SshTarget } from '../server/config.js';
import type { AppContext, CommandResult, CommandRunner, HostHelper, Logger } from '../server/context.js';
import { Store } from '../server/state.js';
import { createHostHelper } from '../server/inventory/hostHelper.js';
import { createInventoryService, mergeInventory, UPDATES_EVERY_MS } from '../server/inventory/index.js';
import {
  compareVersions,
  inspectableFromError,
  kernelFlavor,
  newestKernel,
  parseDf,
  parseHostInfo,
  parseHostInventory,
  parseInnerOutput,
  parseIpOutput,
  parseReboot,
  parseUpdates,
} from '../server/inventory/parse.js';
import { isVirtualInterface } from '../server/util/ipfilter.js';

const FIX = join(import.meta.dirname, 'fixtures/inventory');
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');
const KiB = 1024;

describe('inner script v2 sections', () => {
  const inv = parseInnerOutput(fixture('inner-v2-debian-vm.txt'), { vmid: 105, source: 'qm-guest-exec', collectedAt: 1 });

  it('parses df: real filesystems only, bind mounts once, mount points with spaces', () => {
    expect(inv.ok).toBe(true);
    expect(inv.error).toBeUndefined();
    expect(inv.filesystems!.map((f) => f.mount)).toEqual(['/', '/boot/efi', '/srv/my data', '/var/lib/docker/volumes', '/mnt/media']);
    expect(inv.filesystems![0]).toEqual({
      mount: '/',
      fstype: 'ext4',
      device: '/dev/sda1',
      size: 31861548 * KiB,
      used: 27450000 * KiB,
      avail: 2766436 * KiB,
    });
    expect(inv.filesystems!.find((f) => f.mount === '/mnt/media')).toMatchObject({ fstype: 'nfs4', device: 'nas:/export/media' });
  });

  it('parses the update count, security count and the newest package-list stamp', () => {
    expect(inv.updates).toEqual({ count: 12, security: 4, manager: 'apt', checkedAt: 1_760_003_600_000 });
  });

  it('flags a reboot when a newer kernel of the same flavour is installed', () => {
    expect(inv.kernel).toBe('6.1.0-27-amd64');
    expect(inv.rebootRequired).toBe(true);
    expect(inv.inspectable).toBe('yes');
    // the shared interface filter drops docker0 and lo
    expect(inv.ips.map((i) => i.iface)).toEqual(['ens18']);
  });

  it('still parses v1 output, leaving the v2 fields unknown', () => {
    const v1 = parseInnerOutput(fixture('inner-debian-systemd-docker.txt'), { vmid: 102, source: 'pct-exec', collectedAt: 1 });
    expect(v1).toMatchObject({ ok: true, inspectable: 'yes' });
    expect(v1.error).toBeUndefined();
    expect(v1.filesystems).toBeUndefined();
    expect(v1.updates).toBeUndefined();
    expect(v1.rebootRequired).toBeUndefined();
  });

  it('parses busybox df without a Type column', () => {
    const lines = [
      'Filesystem           1024-blocks    Used Available Capacity Mounted on',
      'overlay                  2031440   20000   2011440   1% /',
      '/dev/vda1                 999424  880000    119424  89% /data',
      'tmpfs                      65536       0     65536   0% /dev/shm',
      '/dev/loop0                 10240   10240         0 100% /media/cdrom',
      '/dev/vda1                 999424  880000    119424  89% /var/lib/docker/overlay2/abc/merged',
      'garbage line',
      '/dev/vdb                       0       0         0   - /empty',
    ];
    expect(parseDf(lines)).toEqual([{ mount: '/data', device: '/dev/vda1', size: 999424 * KiB, used: 880000 * KiB, avail: 119424 * KiB }]);
    expect(parseDf(['no header at all'])).toEqual([]);
    expect(parseDf([])).toEqual([]);
  });

  it('parses the update section of each package manager', () => {
    expect(parseUpdates(['manager apk', 'count 2', 'stamp 1760000000', 'stamp 1759990000'])).toEqual({
      count: 2,
      manager: 'apk',
      checkedAt: 1_760_000_000_000,
    });
    expect(parseUpdates(['manager dnf', 'count 0'])).toEqual({ count: 0, manager: 'dnf' });
    // quick mode, no package manager, broken lines
    expect(parseUpdates(['skipped'])).toBeUndefined();
    expect(parseUpdates([])).toBeUndefined();
    expect(parseUpdates(['manager apt'])).toBeUndefined();
    expect(parseUpdates(['manager Apt;rm', 'count 3'])).toBeUndefined();
    // a security count can never exceed the total
    expect(parseUpdates(['manager apt', 'count 1', 'security 5'])).toMatchObject({ count: 1, security: 1 });
  });

  it('reads the reboot signals', () => {
    expect(parseReboot(['flag reboot-required', 'container'], '6.8.12-4-pve')).toBe(true);
    expect(parseReboot(['flag needs-restarting'], undefined)).toBe(true);
    expect(parseReboot(['modules-missing'], '6.6.31-0-lts')).toBe(true);
    expect(parseReboot(['container'], '6.8.12-4-pve')).toBe(false);
    expect(parseReboot([], '6.1.0-27-amd64')).toBe(false);
    // the running kernel must be among the installed ones (proves /boot belongs to this system)
    expect(parseReboot(['vmlinuz 6.1.0-30-amd64'], '6.1.0-27-amd64')).toBe(false);
    // another flavour or a rescue image is not "newer"
    expect(parseReboot(['vmlinuz 6.1.0-27-amd64', 'vmlinuz 6.1.0-30-cloud-amd64'], '6.1.0-27-amd64')).toBe(false);
    expect(
      parseReboot(['vmlinuz 6.10.6-200.fc40.x86_64', 'vmlinuz 0-rescue-0123456789abcdef'], '6.10.6-200.fc40.x86_64'),
    ).toBe(false);
    expect(parseReboot(['vmlinuz 6.8.0-85-generic', 'vmlinuz 6.8.0-79-generic'], '6.8.0-85-generic')).toBe(false);
    expect(parseReboot(['vmlinuz 6.8.0-85-generic', 'vmlinuz 6.8.0-87-generic'], '6.8.0-85-generic')).toBe(true);
  });

  it('orders kernel versions naturally', () => {
    expect(compareVersions('6.8.12-10-pve', '6.8.12-9-pve')).toBeGreaterThan(0);
    expect(compareVersions('6.8.4-2-pve', '6.8.12-1-pve')).toBeLessThan(0);
    expect(compareVersions('6.14.11-2-pve', '6.14.11-2-pve')).toBe(0);
    expect(kernelFlavor('6.10.6-200.fc40.x86_64')).toBe('fc40.x86_64');
    expect(kernelFlavor('6.8.12-4-pve')).toBe('pve');
    expect(newestKernel(['6.8.12-4-pve', '6.14.11-2-pve', '6.1.0-18-amd64'], '6.8.12-4-pve')).toBe('6.14.11-2-pve');
    expect(newestKernel(['linux', '6.1.0-1-amd64'])).toBe('6.1.0-1-amd64');
  });
});

describe('hostinfo', () => {
  const base = [
    ' 12:00:01 up 3 days,  1 user,  load average: 0.10, 0.12, 0.09', // root's .bashrc
    'running 6.8.12-4-pve',
    'vmlinuz 6.1.0-18-amd64',
    'vmlinuz 6.8.12-4-pve',
    'package proxmox-kernel-6.8.12-4-pve-signed',
    'package proxmox-kernel-6.8.12-9-pve-signed',
    'package proxmox-kernel-6.8',
    'package pve-kernel-5.15.158-2-pve',
    'stamp-lists 1760000000',
    'stamp-lists 1760007200',
    'stamp-pkgupdates 1760100000',
  ];

  it('finds the newest installed Proxmox kernel and when the package lists were refreshed', () => {
    expect(parseHostInfo(base.join('\n'))).toEqual({
      runningKernel: '6.8.12-4-pve',
      newestKernel: '6.8.12-9-pve',
      updatesCheckedAt: 1_760_007_200_000,
    });
  });

  it('reports the pinned kernel as the next one (next-boot pin first)', () => {
    expect(parseHostInfo([...base, 'pin 6.8.12-4-pve'].join('\n'))!.newestKernel).toBe('6.8.12-4-pve');
    expect(parseHostInfo([...base, 'pin 6.8.12-4-pve', 'next-boot-pin 6.5.13-6-pve'].join('\n'))!.newestKernel).toBe('6.5.13-6-pve');
  });

  it('falls back to the pkgupdates file time, and returns null for unrelated output', () => {
    expect(parseHostInfo('running 6.8.12-4-pve\nstamp-pkgupdates 1760100000\n')).toEqual({
      runningKernel: '6.8.12-4-pve',
      newestKernel: '6.8.12-4-pve',
      updatesCheckedAt: 1_760_100_000_000,
    });
    expect(parseHostInfo('')).toBeNull();
    expect(parseHostInfo('Welcome to pve1\n')).toBeNull();
    expect(parseHostInfo('running $(id)\n')).toBeNull();
  });
});

describe('partial output and inspectability', () => {
  it('keeps what a cut-off pct exec printed and says why it stopped', () => {
    const out = [
      '@@pve1-dash:inventory v2',
      '@@pve1-dash:guest 101 lxc pct-exec',
      '##pve1-dash:inventory v2',
      '##pve1-dash:section kernel',
      '6.8.12-4-pve',
      '##pve1-dash:section updates',
      '@@pve1-dash:error timeout after 25s',
      '@@pve1-dash:end 101 124',
      '@@pve1-dash:done',
      '',
    ].join('\n');
    const [inv] = parseHostInventory(out, 1)!.inventories;
    expect(inv).toMatchObject({ vmid: 101, ok: true, kernel: '6.8.12-4-pve', error: 'partial inventory: timeout after 25s' });
    expect(inv!.updates).toBeUndefined();
  });

  it('tells "cannot be inspected by design" from fixable failures', () => {
    for (const e of [
      "VM 100 qga command 'guest-exec' failed - Command guest-exec has been disabled",
      'The command guest-exec has been disabled for this instance',
      'guest-exec is disabled',
      'unsupported OS (windows)',
    ]) {
      expect(inspectableFromError(e), e).toBe('unsupported');
    }
    for (const e of ['QEMU guest agent is not running', 'timeout after 25s', 'ssh timeout', undefined]) {
      expect(inspectableFromError(e), String(e)).toBe('yes');
    }
  });

  it('merge keeps the last update count on quick inventories and records inspectability on failures', () => {
    const full: GuestInventory = {
      vmid: 5,
      source: 'pct-exec',
      collectedAt: 1,
      ok: true,
      ips: [],
      services: [],
      containers: [],
      ports: [],
      kernel: 'k',
      updates: { count: 3, manager: 'apt' },
    };
    const quick: GuestInventory = { ...full, collectedAt: 2, updates: undefined };
    delete quick.updates;
    const merged = mergeInventory({ '5': full }, [quick]);
    expect(merged['5']).toMatchObject({ collectedAt: 2, updates: { count: 3, manager: 'apt' } });
    const disabled: GuestInventory = {
      vmid: 5,
      source: 'qm-guest-exec',
      collectedAt: 3,
      ok: false,
      error: 'Command guest-exec has been disabled',
      ips: [],
      services: [],
      containers: [],
      ports: [],
      inspectable: 'unsupported',
    };
    expect(mergeInventory(merged, [disabled])['5']).toMatchObject({ ok: false, inspectable: 'unsupported', kernel: 'k', collectedAt: 2 });
  });
});

describe('interface filter shared with the guest agent path', () => {
  it('drops container, VM and overlay bridges but keeps the LAN and VPNs', () => {
    const lines = [
      '1: lo    inet 127.0.0.1/8 scope host lo',
      '2: ens18    inet 10.10.10.31/24 brd 10.10.10.255 scope global ens18',
      '3: cni0    inet 10.42.0.1/24 brd 10.42.0.255 scope global cni0',
      '4: flannel.1    inet 10.42.0.0/32 scope global flannel.1',
      '5: virbr0    inet 192.168.122.1/24 brd 192.168.122.255 scope global virbr0',
      '6: lxcbr0    inet 10.0.3.1/24 brd 10.0.3.255 scope global lxcbr0',
      '7: podman0    inet 10.88.0.1/16 brd 10.88.255.255 scope global podman0',
      '8: hassio    inet 172.30.32.1/23 brd 172.30.33.255 scope global hassio',
      '9: kube-ipvs0    inet 10.43.0.1/32 scope global kube-ipvs0',
      '10: docker_gwbridge    inet 172.18.0.1/16 scope global docker_gwbridge',
      '11: br-3f2a9c1d8e7b    inet 172.19.0.1/16 scope global br-3f2a9c1d8e7b',
      '12: tailscale0    inet 100.101.102.103/32 scope global tailscale0',
      '13: wg0    inet 10.6.0.1/24 scope global wg0',
      '14: ztabcdef12    inet 10.147.17.5/24 scope global ztabcdef12',
      '15: br-lan    inet 192.168.1.1/24 scope global br-lan',
      '16: cali1234abcd    inet 169.254.1.1/32 scope global cali1234abcd',
      '17: vxlan.calico    inet 10.244.1.0/32 scope global vxlan.calico',
      '18: eth1    inet 169.254.10.10/16 scope link eth1',
    ];
    expect(parseIpOutput(lines).map((i) => i.iface)).toEqual(['ens18', 'tailscale0', 'wg0', 'ztabcdef12', 'br-lan']);
    expect(isVirtualInterface('cilium_host')).toBe(true);
    expect(isVirtualInterface('weave')).toBe(true);
    expect(isVirtualInterface('tunl0')).toBe(true);
    expect(isVirtualInterface('eth0')).toBe(false);
    expect(isVirtualInterface(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────── host helper wrapper and service policy

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };

function makeCtx(inventory: Record<string, unknown>): AppContext {
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
  return { config, store, log: quiet, dataDir: tmpdir(), appVersion: 'test' };
}

class FakeRunner implements CommandRunner {
  calls: string[] = [];
  constructor(public handler: (target: SshTarget, command: string) => CommandResult) {}
  async run(target: SshTarget, command: string): Promise<CommandResult> {
    this.calls.push(command);
    return this.handler(target, command);
  }
  close() {}
}
const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', code: 0 });
const DENIED: CommandResult = { stdout: '', stderr: 'denied\n', code: 1 };
const HOST = { address: '10.10.20.10' };
const EMPTY_INVENTORY = '@@pve1-dash:inventory v2\n@@pve1-dash:done\n';

describe('host helper wrapper (protocol v2)', () => {
  it('hostInfo parses "hostinfo"; an older helper that denies it yields null with the update hint', async () => {
    const runner = new FakeRunner((_t, c) => (c === 'hostinfo' ? ok('running 6.8.12-4-pve\nvmlinuz 6.8.12-4-pve\nstamp-lists 1760000000\n') : DENIED));
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }), runner);
    expect(await h.hostInfo!()).toEqual({ runningKernel: '6.8.12-4-pve', newestKernel: '6.8.12-4-pve', updatesCheckedAt: 1_760_000_000_000 });

    const old = createHostHelper(makeCtx({ enabled: true, host: HOST }), new FakeRunner(() => DENIED));
    expect(await old.hostInfo!()).toBeNull();
    expect(old.lastError('hostinfo')).toMatch(/install\.sh --update-helper/);
  });

  it('asks for quick inventories and falls back to a full one when a v1 helper denies "quick"', async () => {
    const runner = new FakeRunner((_t, c) => (c.endsWith(' quick') ? DENIED : ok(EMPTY_INVENTORY)));
    const h = createHostHelper(makeCtx({ enabled: true, host: HOST }), runner);
    expect(await h.guests(undefined, { quick: true })).toEqual([]);
    expect(runner.calls).toEqual(['inventory quick', 'inventory']);
    // no second attempt at "quick" for a while
    expect(await h.guests(undefined, { quick: true })).toEqual([]);
    expect(await h.guests(101)).toEqual([]);
    expect(runner.calls).toEqual(['inventory quick', 'inventory', 'inventory', 'inventory 101']);

    const v2 = new FakeRunner(() => ok(EMPTY_INVENTORY));
    const h2 = createHostHelper(makeCtx({ enabled: true, host: HOST }), v2);
    await h2.guests(101, { quick: true });
    await h2.guests();
    expect(v2.calls).toEqual(['inventory 101 quick', 'inventory']);
  });
});

describe('inventory service: update counts hourly, quick sweeps in between', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('runs a full sweep first and then once per UPDATES_EVERY_MS, for the host helper and direct SSH guests', async () => {
    const ctx = makeCtx({ enabled: true, host: HOST, interval: 300, guests: [{ vmid: 108, address: '10.10.20.60' }] });
    const guests = vi.fn(async (_vmid?: number, _opts?: { quick?: boolean }) => [] as GuestInventory[]);
    const helper: HostHelper = {
      available: () => true,
      pkgUpdates: async () => null,
      backups: async () => null,
      host: async () => null,
      guests,
    };
    const inner = (updates: string) => `##pve1-dash:inventory v2\n##pve1-dash:section updates\n${updates}\n##pve1-dash:end\n`;
    const runner = new FakeRunner((_t, c) => ok(inner(c === 'inventory quick' ? 'skipped' : 'manager apk\ncount 4')));
    const svc = createInventoryService(ctx, { runner, hostHelper: helper });
    svc.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(guests.mock.calls.at(-1)).toEqual([undefined, { quick: false }]);
    expect(runner.calls).toEqual(['inventory']);
    expect(ctx.store.get('inventory')['108']!.updates).toEqual({ count: 4, manager: 'apk' });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(guests.mock.calls.at(-1)).toEqual([undefined, { quick: true }]);
    expect(runner.calls.at(-1)).toBe('inventory quick');
    // the quick sweep keeps the last count
    expect(ctx.store.get('inventory')['108']!.updates).toEqual({ count: 4, manager: 'apk' });

    const sweepsPerFull = Math.ceil(UPDATES_EVERY_MS / 300_000);
    await vi.advanceTimersByTimeAsync((sweepsPerFull - 1) * 300_000);
    expect(guests.mock.calls.at(-1)).toEqual([undefined, { quick: false }]);
    expect(runner.calls.at(-1)).toBe('inventory');
    expect(runner.calls.filter((c) => c === 'inventory')).toHaveLength(2);
    svc.stop();
  });
});
