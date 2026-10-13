/**
 * Static facts about the demo guests that both the mock API and the mock SSH runner need: the OS each guest runs, and
 * the network interfaces inside it. Derived from server/demo/world.ts; nothing here varies with time.
 */
import { DEMO_NODE, type DemoGuest } from './world.js';
import { hashHex } from './sim.js';
import { linkLocalFromMac } from './pveCommon.js';

export interface OsInfo {
  /** os-release ID */
  id: string;
  name: string;
  prettyName: string;
  version: string;
  versionId: string;
  /** `uname -r` inside the guest (LXCs share the host kernel) */
  kernel: string;
  /** `uname -v` */
  kernelVersion: string;
  /** contents of /etc/os-release */
  osRelease: string;
  init: 'systemd' | 'openrc';
}

const HOST_KERNEL_VERSION = '#1 SMP PREEMPT_DYNAMIC PMX 6.14.11-2 (2025-09-12T09:46Z)';

const DEBIAN_13 = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
DEBIAN_VERSION_FULL=13.1
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"`;

const DEBIAN_12 = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
SUPPORT_URL="https://www.debian.org/support"
BUG_REPORT_URL="https://bugs.debian.org/"`;

const UBUNTU_2404 = `PRETTY_NAME="Ubuntu 24.04.3 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.3 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo`;

const ALPINE_322 = `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.22.1
PRETTY_NAME="Alpine Linux v3.22"
HOME_URL="https://alpinelinux.org/"
BUG_REPORT_URL="https://gitlab.alpinelinux.org/alpine/aports/-/issues"`;

const HAOS = `NAME="Home Assistant OS"
VERSION="16.2"
ID=haos
VERSION_ID=16.2
PRETTY_NAME="Home Assistant OS 16.2"
CPE_NAME=cpe:2.3:o:home-assistant:haos:16.2:*:production:*:*:*:generic-x86-64:*
HOME_URL=https://hass.io/
VARIANT="Home Assistant OS generic-x86-64"
VARIANT_ID=generic-x86-64
SUPPORT_URL=https://www.home-assistant.io/help/
BUG_REPORT_URL=https://github.com/home-assistant/operating-system/issues
DOCUMENTATION_URL=https://developers.home-assistant.io/docs/operating-system`;

/** The OS inside a guest, or undefined when the world doesn't say (Windows, templates). */
export function guestOs(g: DemoGuest): OsInfo | undefined {
  const lxc = g.type === 'lxc';
  const hostKernel = { kernel: DEMO_NODE.kernel, kernelVersion: HOST_KERNEL_VERSION };
  switch (g.osPretty) {
    case 'Debian GNU/Linux 13 (trixie)':
      return {
        id: 'debian',
        name: 'Debian GNU/Linux',
        prettyName: g.osPretty,
        version: '13 (trixie)',
        versionId: '13',
        // the PBS VM runs the Proxmox kernel too
        ...hostKernel,
        osRelease: DEBIAN_13,
        init: 'systemd',
      };
    case 'Debian GNU/Linux 12 (bookworm)':
      return {
        id: 'debian',
        name: 'Debian GNU/Linux',
        prettyName: g.osPretty,
        version: '12 (bookworm)',
        versionId: '12',
        ...(lxc ? hostKernel : { kernel: '6.1.0-40-amd64', kernelVersion: '#1 SMP PREEMPT_DYNAMIC Debian 6.1.153-1 (2025-09-20)' }),
        osRelease: DEBIAN_12,
        init: 'systemd',
      };
    case 'Ubuntu 24.04.3 LTS':
      return {
        id: 'ubuntu',
        name: 'Ubuntu',
        prettyName: g.osPretty,
        version: '24.04.3 LTS (Noble Numbat)',
        versionId: '24.04',
        ...(lxc ? hostKernel : { kernel: '6.8.0-85-generic', kernelVersion: '#85-Ubuntu SMP PREEMPT_DYNAMIC Thu Sep 18 15:26:59 UTC 2025' }),
        osRelease: UBUNTU_2404,
        init: 'systemd',
      };
    case 'Alpine Linux v3.22':
      return {
        id: 'alpine',
        name: 'Alpine Linux',
        prettyName: g.osPretty,
        version: '3.22.1',
        versionId: '3.22.1',
        ...hostKernel,
        osRelease: ALPINE_322,
        init: 'openrc',
      };
    case 'Home Assistant OS 16.2':
      return {
        id: 'haos',
        name: 'Home Assistant OS',
        prettyName: g.osPretty,
        version: '16.2',
        versionId: '16.2',
        kernel: '6.12.43-haos',
        kernelVersion: '#1 SMP PREEMPT_DYNAMIC Tue Sep 30 09:12:05 UTC 2025',
        osRelease: HAOS,
        init: 'systemd',
      };
    default:
      return undefined;
  }
}

// ───────────────────────────────────────────────────────────── network interfaces inside the guest

export interface Addr {
  addr: string;
  prefix: number;
  /** extra `ip -o addr` flags after "scope …" */
  scope: 'host' | 'global' | 'link';
  dynamic?: boolean;
}

export interface GuestIface {
  index: number;
  name: string;
  /** lower-case MAC as the guest sees it */
  mac: string;
  v4: Addr[];
  v6: Addr[];
  kind: 'lo' | 'nic' | 'docker' | 'tailscale' | 'veth';
}

export const LAN_PREFIX = 24;
export const LAN_GATEWAY = '10.10.20.1';

/** Interface name of the first NIC inside the guest. */
export function nicName(g: DemoGuest): string {
  if (g.type === 'lxc') return 'eth0';
  if (g.osPretty?.startsWith('Home Assistant')) return 'enp0s18';
  return 'ens18';
}

const TAILSCALE: Record<number, { v4: string; v6: string }> = {
  105: { v4: '100.101.17.42', v6: 'fd7a:115c:a1e0::5f01:112a' },
  109: { v4: '100.88.12.7', v6: 'fd7a:115c:a1e0::6a01:c07' },
};

/** Docker networks per guest: [bridge name, IPv4 gateway, prefix]. */
function dockerNetworks(g: DemoGuest): Array<[string, string, number]> {
  if (g.osPretty?.startsWith('Home Assistant')) {
    return [
      ['hassio', '172.30.32.1', 23],
      ['docker0', '172.30.232.1', 23],
    ];
  }
  if (!g.containers?.length) return [];
  const projects = [...new Set(g.containers.map((c) => c.compose).filter((p): p is string => !!p))];
  return [['docker0', '172.17.0.1', 16], ...projects.map((p, i): [string, string, number] => [`br-${hashHex(12, 'br', g.vmid, p)}`, `172.${18 + i}.0.1`, 16])];
}

const mac = (...parts: Array<string | number>) => {
  const h = hashHex(10, 'mac', ...parts);
  return `02:42:${h.slice(0, 2)}:${h.slice(2, 4)}:${h.slice(4, 6)}:${h.slice(6, 8)}`;
};

/** Interfaces as `ip addr` inside the guest shows them (running guests only). */
export function guestInterfaces(g: DemoGuest): GuestIface[] {
  const lo: GuestIface = {
    index: 1,
    name: 'lo',
    mac: '00:00:00:00:00:00',
    v4: [{ addr: '127.0.0.1', prefix: 8, scope: 'host' }],
    v6: [{ addr: '::1', prefix: 128, scope: 'host' }],
    kind: 'lo',
  };
  const nic: GuestIface = {
    index: 2,
    name: nicName(g),
    mac: g.mac.toLowerCase(),
    v4: g.ip ? [{ addr: g.ip, prefix: LAN_PREFIX, scope: 'global', dynamic: g.type === 'qemu' && g.ostype === 'l26' && !g.osPretty?.startsWith('Debian') }] : [],
    v6: [{ addr: linkLocalFromMac(g.mac), prefix: 64, scope: 'link' }],
    kind: 'nic',
  };
  const out = [lo, nic];
  let index = 3;
  for (const [name, gw, prefix] of dockerNetworks(g)) {
    out.push({
      index: index++,
      name,
      mac: mac(g.vmid, name),
      v4: [{ addr: gw, prefix, scope: 'global' }],
      v6: [{ addr: linkLocalFromMac(mac(g.vmid, name)), prefix: 64, scope: 'link' }],
      kind: 'docker',
    });
  }
  const ts = TAILSCALE[g.vmid];
  if (ts) {
    out.push({
      index: index++,
      name: 'tailscale0',
      mac: '',
      v4: [{ addr: ts.v4, prefix: 32, scope: 'global' }],
      v6: [{ addr: ts.v6, prefix: 128, scope: 'global' }],
      kind: 'tailscale',
    });
  }
  // A couple of container veths (link-local only), as on any Docker host.
  const running = (g.containers ?? []).filter((c) => c.state === 'running').slice(0, 2);
  for (const c of running) {
    const m = mac(g.vmid, 'veth', c.name);
    out.push({ index: index++, name: `veth${hashHex(7, 'veth', g.vmid, c.name)}`, mac: m, v4: [], v6: [{ addr: linkLocalFromMac(m), prefix: 64, scope: 'link' }], kind: 'veth' });
  }
  return out;
}

// ───────────────────────────────────────────────────────────── filesystems, package updates, reboot (helper v2)

/** A filesystem `df` lists inside a guest. `used` is a fraction of `sizeGiB`. */
export interface DemoMount {
  device: string;
  fstype: string;
  mount: string;
  sizeGiB: number;
  used: number;
}

/**
 * Data filesystems inside the guest, apart from an LXC's rootfs (that one comes from the simulation, so it matches what
 * Proxmox reports for the container). VMs report nothing to Proxmox, so these are the only disk numbers for them.
 */
export function guestMounts(g: DemoGuest): DemoMount[] {
  switch (g.vmid) {
    case 102:
      // the media library: a mount point (mp0) on the tank pool with its own quota; Proxmox shows no usage for it
      return [{ device: 'tank/subvol-102-disk-1', fstype: 'zfs', mount: '/mnt/media', sizeGiB: 6144, used: 0.72 }];
    case 105:
      return [
        { device: '/dev/mapper/ubuntu--vg-ubuntu--lv', fstype: 'ext4', mount: '/', sizeGiB: 123.9, used: 0.47 },
        { device: '/dev/sda2', fstype: 'ext4', mount: '/boot', sizeGiB: 1.9, used: 0.21 },
        { device: '/dev/sda1', fstype: 'vfat', mount: '/boot/efi', sizeGiB: 1.05, used: 0.006 },
      ];
    case 108:
      // the datastore disk is filling up: a guest_disk warning in the demo
      return [
        { device: '/dev/mapper/pbs-root', fstype: 'ext4', mount: '/', sizeGiB: 27.9, used: 0.23 },
        { device: '/dev/sdb1', fstype: 'xfs', mount: '/mnt/datastore', sizeGiB: 1862, used: 0.88 },
      ];
    default:
      return [];
  }
}

/** Pending OS updates and reboot state inside a guest, as its package manager would report them. */
export interface DemoUpdates {
  manager: 'apt' | 'apk';
  count: number;
  /** apt only: updates from a -security suite */
  security?: number;
  /** how long ago the package lists were refreshed */
  listsAgeH: number;
  /** /run/reboot-required exists */
  rebootFlag?: boolean;
  /** /boot/vmlinuz-* versions (VMs only; containers have none) */
  vmlinuz?: string[];
}

export function guestUpdates(g: DemoGuest): DemoUpdates | undefined {
  switch (g.vmid) {
    case 101:
      return { manager: 'apt', count: 3, security: 1, listsAgeH: 7 };
    case 102:
      return { manager: 'apt', count: 0, security: 0, listsAgeH: 7 };
    case 103:
      // apt-daily switched off in this container: the lists are 9 days old
      return { manager: 'apt', count: 7, security: 2, listsAgeH: 9 * 24 + 4 };
    case 104:
      return { manager: 'apt', count: 0, security: 0, listsAgeH: 11 };
    case 105:
      // unattended-upgrades installed a new kernel: reboot-required is set and 6.8.0-87 waits in /boot
      return {
        manager: 'apt',
        count: 12,
        security: 4,
        listsAgeH: 3,
        rebootFlag: true,
        vmlinuz: ['6.8.0-79-generic', '6.8.0-85-generic', '6.8.0-87-generic'],
      };
    case 107:
      return { manager: 'apt', count: 5, security: 2, listsAgeH: 15 };
    case 108:
      return { manager: 'apt', count: 2, security: 0, listsAgeH: 6, vmlinuz: [DEMO_NODE.kernel] };
    case 109:
      return { manager: 'apk', count: 2, listsAgeH: 50 };
    default:
      return undefined;
  }
}

/** What `pve1-dash-helper hostinfo` reports for the demo node: the running kernel is the newest one installed. */
export const DEMO_HOST_KERNELS = {
  vmlinuz: ['6.8.12-13-pve', DEMO_NODE.kernel],
  packages: ['proxmox-kernel-6.8.12-13-pve-signed', `proxmox-kernel-${DEMO_NODE.kernel}-signed`],
  /** hours since `apt-get update` (matches the "aptupdate" task in world.ts) */
  listsAgeH: 5,
};
