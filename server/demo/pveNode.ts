/**
 * Node and cluster payloads of the mock Proxmox VE 9 API (standalone node "pve1", PVEAuditor token).
 * Field names, types and presence follow docs/research/pve-api-node.md.
 */
import { DEMO_GUESTS, DEMO_NODE, DEMO_UPDATES } from './world.js';
import { DAY_S, between, hashHex, round, type DemoSim } from './sim.js';
import { guestResource } from './pveGuests.js';
import { storageResources } from './pveStorage.js';
import { fakeFingerprint, NODE, paramError, rrdDropout, rrdRows, type RrdRow, type Timeframe } from './pveCommon.js';

type Obj = Record<string, unknown>;

const PVE_MANAGER = `pve-manager/${DEMO_NODE.pveVersion}/${DEMO_NODE.repoid}`;
const KERNEL_BUILD = '#1 SMP PREEMPT_DYNAMIC PMX 6.14.11-2 (2025-09-12T09:46Z)';
export const SSL_FINGERPRINT = fakeFingerprint('pve-ssl.pem', DEMO_NODE.name);

/** pvestatd broadcasts every 10 s, so /cluster/resources and /nodes values are up to 10 s old. */
const statdTime = (nowMs: number) => Math.floor(nowMs / 10_000) * 10_000;

export function version(): Obj {
  return { version: DEMO_NODE.pveVersion, release: DEMO_NODE.release, repoid: DEMO_NODE.repoid };
}

/** Standalone node: exactly one synthetic node entry, nodeid 0, no "cluster" entry. */
export function clusterStatus(): Obj[] {
  return [{ type: 'node', id: `node/${NODE}`, name: NODE, ip: DEMO_NODE.ip, local: 1, nodeid: 0, online: 1, level: '' }];
}

function nodeStats(sim: DemoSim, t: number): Obj {
  const mem = sim.nodeMemory(t);
  const root = sim.nodeRootFs(t);
  return {
    uptime: sim.nodeUptime(t),
    cpu: round(sim.nodeCpu(t), 6),
    maxcpu: DEMO_NODE.threads,
    mem: mem.used,
    maxmem: mem.total,
    disk: root.used,
    maxdisk: root.total,
  };
}

export function nodesIndex(sim: DemoSim, nowMs: number): Obj[] {
  const t = statdTime(nowMs);
  return [{ id: `node/${NODE}`, node: NODE, type: 'node', status: 'online', level: '', ...nodeStats(sim, t), ssl_fingerprint: SSL_FINGERPRINT }];
}

export function clusterResources(sim: DemoSim, nowMs: number, type?: 'vm' | 'storage' | 'node' | 'sdn'): Obj[] {
  const t = statdTime(nowMs);
  const out: Obj[] = [];
  if (!type || type === 'vm') {
    // Proxmox sorts guests by vmid as strings ("1000" before "101").
    const guests = [...DEMO_GUESTS].sort((a, b) => (String(a.vmid) < String(b.vmid) ? -1 : 1));
    for (const g of guests) out.push(guestResource(sim, g, t));
  }
  if (!type || type === 'node') {
    out.push({ id: `node/${NODE}`, type: 'node', node: NODE, status: 'online', level: '', 'cgroup-mode': 2, ...nodeStats(sim, t) });
  }
  if (!type || type === 'storage') out.push(...storageResources(sim, t));
  // PVE 9: the node publishes the new `network` kv, so no legacy "sdn" entries; localnetwork is type "network".
  if (!type) {
    out.push({ id: `network/${NODE}/zone/localnetwork`, type: 'network', 'network-type': 'zone', network: 'localnetwork', node: NODE, status: 'ok' });
  }
  return out;
}

const CPU_FLAGS =
  'fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx mmxext fxsr_opt pdpe1gb rdtscp lm constant_tsc rep_good nopl nonstop_tsc cpuid extd_apicid aperfmperf rapl pni pclmulqdq monitor ssse3 fma cx16 sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand lahf_lm cmp_legacy svm extapic cr8_legacy abm sse4a misalignsse 3dnowprefetch osvw ibs skinit wdt tce topoext perfctr_core perfctr_nb bpext perfctr_llc mwaitx cpb cat_l3 cdp_l3 hw_pstate ssbd mba ibrs ibpb stibp vmmcall fsgsbase bmi1 avx2 smep bmi2 erms invpcid cqm rdt_a rdseed adx smap clflushopt clwb sha_ni xsaveopt xsavec xgetbv1 xsaves cqm_llc cqm_occup_llc cqm_mbm_total cqm_mbm_local user_shstk clzero irperf xsaveerptr rdpru wbnoinvd cppc arat npt lbrv svm_lock nrip_save tsc_scale vmcb_clean flushbyasid decodeassists pausefilter pfthreshold avic v_vmsave_vmload vgif v_spec_ctrl umip pku ospke vaes vpclmulqdq rdpid overflow_recov succor smca fsrm debug_swap';

/** GET /nodes/{node}/status (PVE 9.0: memory.available present; cpuinfo.vendor/family need libpve-common ≥ 9.1.6). */
export function nodeStatus(sim: DemoSim, nowMs: number): Obj {
  const mem = sim.nodeMemory(nowMs);
  const swap = sim.nodeSwap(nowMs);
  const root = sim.nodeRootFs(nowMs);
  const load = sim.nodeLoad(nowMs);
  const cpu = sim.nodeCpu(nowMs);
  const mhz = 1_400 + cpu * 3_100 + between(0, 260, 'mhz', Math.floor(nowMs / 5000));
  return {
    uptime: sim.nodeUptime(nowMs),
    idle: 0,
    // regex captures of /proc/loadavg → JSON strings
    loadavg: load.map((v) => v.toFixed(2)),
    kversion: `Linux ${DEMO_NODE.kernel} ${KERNEL_BUILD}`,
    'current-kernel': { sysname: 'Linux', release: DEMO_NODE.kernel, version: KERNEL_BUILD, machine: 'x86_64' },
    'boot-info': DEMO_NODE.bootMode === 'efi' ? { mode: 'efi', secureboot: DEMO_NODE.secureBoot ? 1 : 0 } : { mode: 'legacy-bios' },
    cpuinfo: {
      user_hz: 100,
      model: DEMO_NODE.cpuModel,
      mhz: mhz.toFixed(3),
      cpus: DEMO_NODE.threads,
      sockets: DEMO_NODE.sockets,
      cores: DEMO_NODE.cores,
      hvm: '1',
      flags: CPU_FLAGS,
    },
    cpu: round(cpu, 6),
    wait: round(sim.nodeIoWait(nowMs), 6),
    memory: { total: mem.total, used: mem.used, free: mem.free, available: mem.available },
    ksm: { shared: 0 },
    swap,
    pveversion: PVE_MANAGER,
    rootfs: root,
  };
}

/** GET /nodes/{node}/rrddata — PVE 9 node data sources (pve-node-9.0). */
export function nodeRrd(sim: DemoSim, timeframe: Timeframe, cf: 'AVERAGE' | 'MAX', nowMs: number): RrdRow[] {
  return rrdRows(nowMs, timeframe, cf, (tMs) => {
    if (!sim.nodeUpAt(tMs) || tMs > nowMs || rrdDropout(tMs, 'node')) return null;
    const mem = sim.nodeMemory(tMs);
    const swap = sim.nodeSwap(tMs);
    const root = sim.nodeRootFs(tMs);
    const net = sim.nodeNetRates(tMs);
    const p = sim.nodePressure(tMs);
    return {
      loadavg: sim.nodeLoad1(tMs),
      maxcpu: DEMO_NODE.threads,
      cpu: sim.nodeCpu(tMs),
      iowait: sim.nodeIoWait(tMs),
      memtotal: mem.total,
      memused: mem.used,
      swaptotal: swap.total,
      swapused: swap.used,
      roottotal: root.total,
      rootused: root.used,
      netin: net.netIn,
      netout: net.netOut,
      memavailable: mem.available,
      arcsize: mem.arc,
      pressurecpusome: p.cpuSome,
      pressureiosome: p.ioSome,
      pressureiofull: p.ioFull,
      pressurememorysome: p.memSome,
      pressurememoryfull: p.memFull,
    };
  });
}

// ───────────────────────────────────────────────────────────── network

const NIC_MAC = ['a8:a1:59:c4:e0:f2', 'a8:a1:59:c4:e0:f3'];
const NETWORK_TYPES = ['bridge', 'bond', 'eth', 'alias', 'vlan', 'fabric', 'OVSBridge', 'OVSBond', 'OVSPort', 'OVSIntPort', 'vnet', 'any_bridge', 'any_local_bridge', 'include_sdn'] as const;

export function nodeNetwork(q: URLSearchParams): Obj[] {
  const ifaces: Obj[] = [
    {
      iface: 'enp5s0',
      type: 'eth',
      method: 'manual',
      method6: 'manual',
      families: ['inet'],
      priority: 3,
      exists: 1,
      active: 1,
      altnames: [`enx${NIC_MAC[0]!.replace(/:/g, '')}`],
    },
    {
      // second onboard NIC, cabled but unused: no `active` key while the link is down
      iface: 'enp4s0',
      type: 'eth',
      method: 'manual',
      method6: 'manual',
      families: ['inet'],
      priority: 4,
      exists: 1,
      altnames: [`enx${NIC_MAC[1]!.replace(/:/g, '')}`],
    },
    {
      iface: 'vmbr0',
      type: 'bridge',
      method: 'static',
      method6: 'manual',
      families: ['inet'],
      priority: 5,
      autostart: 1,
      active: 1,
      address: DEMO_NODE.ip,
      netmask: '24',
      cidr: `${DEMO_NODE.ip}/24`,
      gateway: '10.10.20.1',
      bridge_ports: 'enp5s0',
      bridge_stp: 'off',
      bridge_fd: '0',
      bridge_vlan_aware: 1,
      bridge_vids: '2-4094',
      comments: 'LAN (VLAN 20 untagged)\n',
    },
  ];
  const type = q.get('type');
  if (type === null || type === '' || type === 'include_sdn') return ifaces;
  if (!(NETWORK_TYPES as readonly string[]).includes(type)) {
    throw paramError({ type: `value '${type}' does not have a value in the enumeration '${NETWORK_TYPES.join(', ')}'` });
  }
  if (type === 'any_bridge' || type === 'any_local_bridge') return ifaces.filter((i) => i.type === 'bridge' || i.type === 'OVSBridge');
  return ifaces.filter((i) => i.type === type);
}

// ───────────────────────────────────────────────────────────── packages, subscription, certificates, services

interface Pkg {
  Package: string;
  Title: string;
  Description: string;
  Version: string;
  OldVersion?: string;
  Section: string;
  Arch: string;
  extra?: Obj;
}

/** GET /nodes/{node}/apt/versions: the curated Proxmox package list (installed = OldVersion, candidate = Version). */
export function aptVersions(): Obj[] {
  const upd = (name: string) => DEMO_UPDATES.find((u) => u.Package === name);
  const pkg = (name: string, title: string, installed: string, section = 'admin', arch = 'all', extra?: Obj): Pkg => {
    const u = upd(name);
    return { Package: name, Title: title, Description: `${title}.`, Version: u?.Version ?? installed, OldVersion: u?.OldVersion ?? installed, Section: section, Arch: arch, extra };
  };
  const list: Pkg[] = [
    pkg('proxmox-ve', 'Proxmox Virtual Environment', '9.0.0', 'admin', 'all', { RunningKernel: DEMO_NODE.kernel }),
    pkg('pve-manager', 'Proxmox Virtual Environment Management Tools', DEMO_NODE.pveVersion, 'admin', 'amd64', { ManagerVersion: DEMO_NODE.pveVersion }),
    pkg('proxmox-kernel-helper', 'Function for various kernel maintenance tasks', '9.0.4'),
    pkg('proxmox-kernel-6.14', 'Latest Proxmox Kernel Image', '6.14.11-2', 'kernel'),
    pkg(`proxmox-kernel-${DEMO_NODE.kernel}-signed`, 'Proxmox Kernel Image (signed)', '6.14.11-2', 'kernel', 'amd64'),
    pkg('ceph-fuse', 'FUSE-based client for the Ceph distributed file system', '19.2.3-pve1', 'admin', 'amd64'),
    pkg('corosync', 'cluster engine daemon and utilities', '3.1.9-pve2', 'admin', 'amd64'),
    pkg('criu', 'checkpoint and restore in userspace', '4.1.1-1', 'admin', 'amd64'),
    pkg('ifupdown2', 'Network Interface Management tool similar to ifupdown', '3.3.0-1+pmx10', 'admin', 'all'),
    pkg('libpve-access-control', 'Proxmox VE access control library', '9.0.3', 'perl'),
    pkg('libpve-common-perl', 'Proxmox VE base library', '9.0.11', 'perl'),
    pkg('libpve-guest-common-perl', 'Proxmox VE common guest-related modules', '6.0.2', 'perl'),
    pkg('libpve-storage-perl', 'Proxmox VE storage management library', '9.0.13', 'perl'),
    pkg('lxc-pve', 'Linux containers userspace tools', '6.0.5-1', 'admin', 'amd64'),
    pkg('lxcfs', 'FUSE based filesystem for LXC', '6.0.4-pve1', 'admin', 'amd64'),
    pkg('proxmox-backup-client', 'Proxmox Backup Client tools', '4.0.15-1', 'admin', 'amd64'),
    pkg('proxmox-firewall', 'Proxmox nftables firewall', '1.2.0', 'admin', 'amd64'),
    pkg('proxmox-widget-toolkit', 'Core Widgets and ExtJS Helper Classes for Proxmox Web UIs', '5.0.5', 'web'),
    pkg('pve-cluster', 'Cluster Infrastructure for Proxmox Virtual Environment', '9.0.6', 'admin', 'amd64'),
    pkg('pve-container', 'Proxmox VE Container management tool', '6.0.13', 'perl'),
    pkg('pve-firewall', 'Proxmox VE Firewall', '6.0.3', 'admin', 'amd64'),
    pkg('pve-firmware', 'Binary firmware code for the pve-kernel', '3.16-3', 'misc'),
    pkg('pve-ha-manager', 'Proxmox VE HA Manager', '5.0.4', 'perl', 'amd64'),
    pkg('pve-qemu-kvm', 'Full virtualization on x86 hardware', '10.0.2-4', 'admin', 'amd64'),
    pkg('qemu-server', 'Qemu Server Tools', '9.0.22', 'admin', 'amd64'),
    pkg('smartmontools', 'control and monitor storage systems using S.M.A.R.T.', '7.4-pve1', 'utils', 'amd64'),
    pkg('zfsutils-linux', 'command-line tools to manage OpenZFS filesystems', '2.3.4-pve1', 'contrib/admin', 'amd64'),
  ];
  return list.map(({ extra, ...p }) => ({ ...p, Origin: 'Proxmox', Priority: 'optional', CurrentState: 'Installed', ...(extra ?? {}) }));
}

export function subscription(): Obj {
  return {
    status: 'notfound',
    message: 'There is no subscription key',
    url: 'https://www.proxmox.com/en/proxmox-virtual-environment/pricing',
    serverid: hashHex(32, 'serverid').toUpperCase(),
    sockets: DEMO_NODE.sockets,
  };
}

/**
 * GET /nodes/{node}/certificates/info. The node certificate is close to its 2-year lifetime (it expires about six
 * weeks after the anchor). `pem` is omitted: the mock has no real certificate (every field is optional in the schema).
 */
export function certificates(sim: DemoSim): Obj[] {
  const anchorS = Math.floor(sim.anchor / 1000);
  // created at installation time (the CA a few minutes before the node certificate)
  const caBefore = Math.floor(sim.installedMs / 1000) + 600;
  const ou = hashHex(32, 'ca-ou');
  const caSubject = `/CN=Proxmox Virtual Environment/OU=${ou}/O=PVE Cluster Manager CA`;
  return [
    {
      filename: 'pve-root-ca.pem',
      fingerprint: fakeFingerprint('pve-root-ca.pem'),
      subject: caSubject,
      issuer: caSubject,
      notbefore: caBefore,
      notafter: caBefore + 3650 * DAY_S,
      san: [],
      'public-key-type': 'rsaEncryption',
      'public-key-bits': 4096,
    },
    {
      filename: 'pve-ssl.pem',
      fingerprint: SSL_FINGERPRINT,
      subject: `/OU=PVE Cluster Node/O=Proxmox Virtual Environment/CN=${NODE}.home.lan`,
      issuer: caSubject,
      notbefore: caBefore - DAY_S + 120,
      notafter: caBefore + 729 * DAY_S + 120,
      san: ['127.0.0.1', '0000:0000:0000:0000:0000:0000:0000:0001', 'localhost', DEMO_NODE.ip, NODE, `${NODE}.home.lan`],
      'public-key-type': 'rsaEncryption',
      'public-key-bits': 2048,
    },
  ];
}

/** GET /nodes/{node}/services — the 23 PVE 9 service ids (standalone node: corosync not running). */
export function services(): Obj[] {
  const s = (service: string, desc: string, state = 'running', active = 'active', unit = 'enabled'): Obj => ({
    service,
    name: service,
    desc,
    state,
    'active-state': active,
    'unit-state': unit,
  });
  return [
    s('chrony', 'chrony, an NTP client/server'),
    s('corosync', 'Corosync Cluster Engine', 'dead', 'inactive'),
    s('cron', 'Regular background program processing daemon'),
    s('ksmtuned', 'Kernel Samepage Merging (KSM) Tuning Daemon'),
    s('lxcfs', 'FUSE filesystem for LXC'),
    s('postfix', 'Postfix Mail Transport Agent', 'exited'),
    s('proxmox-firewall', 'Proxmox nftables firewall', 'dead', 'inactive'),
    s('pve-cluster', 'The Proxmox VE cluster filesystem'),
    s('pve-firewall', 'Proxmox VE firewall'),
    s('pve-ha-crm', 'PVE Cluster HA Resource Manager Daemon'),
    s('pve-ha-lrm', 'PVE Local HA Resource Manager Daemon'),
    s('pve-lxc-syscalld', 'Proxmox VE LXC Syscall Daemon', 'running', 'active', 'static'),
    s('pvedaemon', 'PVE API Daemon'),
    s('pvefw-logger', 'Proxmox VE firewall logger', 'running', 'active', 'static'),
    s('pveproxy', 'PVE API Proxy Server'),
    s('pvescheduler', 'Proxmox VE scheduler'),
    s('pvestatd', 'PVE Status Daemon'),
    s('qmeventd', 'PVE Qemu Event Daemon'),
    s('spiceproxy', 'PVE SPICE Proxy Server'),
    s('sshd', 'OpenBSD Secure Shell server'),
    s('syslog', 'System Logging Service', 'running', 'active', 'static'),
    s('systemd-journald', 'Journal Service', 'running', 'active', 'static'),
    // PVE uses chrony; systemd-timesyncd is not installed
    s('systemd-timesyncd', 'systemd-timesyncd.service', 'dead', 'inactive', 'not-found'),
  ];
}
