import { describe, expect, it } from 'vitest';
import {
  computeCoverage,
  describeSelection,
  healthStatus,
  clusterStorageEntries,
  lastBackups,
  mapBackupContent,
  mapBackupJobs,
  mapDisks,
  mapNotBackedUp,
  mapPruneBackups,
  mapLvmThin,
  mapSmart,
  mapTaskLog,
  mapTasks,
  mapZfsDetail,
  mapZfsPools,
  mergeStorage,
  parseUpid,
  sortBackups,
  taskSeverity,
} from '../server/proxmox/storageMapping.js';
import {
  compareKernels,
  installedKernels,
  mapAptVersions,
  mapHostServices,
  mapNetwork,
  mapPkgUpdates,
  mapSubscription,
  mapVersion,
  newestKernel,
  pickCertificate,
} from '../server/proxmox/hostMapping.js';

// Fixtures follow docs/research/pve-api-storage.md and pve-api-node.md (constructed from the PVE source, §-referenced).

describe('storage & ZFS', () => {
  // GET /nodes/{node}/storage rows (pve-api-storage.md §1a)
  const NODE_ROWS = [
    { storage: 'pbs-main', type: 'pbs', content: 'backup', enabled: 1, active: 1, shared: 1, total: 3985729650688, used: 1288490188800, avail: 2697239461888, used_fraction: 0.323275862068966 },
    { storage: 'local', type: 'dir', content: 'vztmpl,iso,backup', enabled: 1, active: 1, shared: 0, total: 100, used: 25, avail: 70 },
    { storage: 'nas-nfs', type: 'nfs', content: 'backup,iso', enabled: 1, active: 0, shared: 1, total: 0, used: 0, avail: 0 },
    { storage: 'old', type: 'dir', content: 'none', enabled: 0, active: 0, shared: 0, total: 0, used: 0, avail: 0 },
  ];
  // /cluster/resources type=storage entries of the same node (pve-api-node.md §5.3): enabled storages only,
  // disk/maxdisk only while pvestatd can read the storage
  const CLUSTER_ROWS = [
    { id: 'storage/pve1/pbs-main', type: 'storage', storage: 'pbs-main', node: 'pve1', plugintype: 'pbs', status: 'available', shared: 1, content: 'backup', disk: 1288490188800, maxdisk: 3985729650688 },
    { id: 'storage/pve1/local', type: 'storage', storage: 'local', node: 'pve1', plugintype: 'dir', status: 'available', shared: 0, content: 'iso,backup,vztmpl', disk: 26, maxdisk: 100 },
    { id: 'storage/pve1/nas-nfs', type: 'storage', storage: 'nas-nfs', node: 'pve1', plugintype: 'nfs', status: 'unknown', shared: 1, content: 'backup,iso' },
    { id: 'storage/pve2/local', type: 'storage', storage: 'local', node: 'pve2', plugintype: 'dir', status: 'available', disk: 1, maxdisk: 2 },
    { id: 'qemu/100', type: 'qemu', vmid: 100, node: 'pve1' },
  ];

  it('maps the node listing alone (inactive and disabled storages included)', () => {
    const s = mergeStorage({ cluster: [], node: NODE_ROWS, nodeFresh: true });
    expect(s.map((x) => x.id)).toEqual(['local', 'nas-nfs', 'old', 'pbs-main']);
    expect(s[0]).toEqual({ id: 'local', type: 'dir', content: ['backup', 'iso', 'vztmpl'], active: true, enabled: true, shared: false, total: 100, used: 25, avail: 70, usedFraction: 0.25 });
    expect(s[1]).toMatchObject({ active: false, shared: true, usedFraction: 0, total: 0 });
    expect(s[2]).toMatchObject({ content: [], enabled: false, active: false });
    expect(s[3]!.usedFraction).toBeCloseTo(0.3233, 4);
  });

  it('takes sizes and states from /cluster/resources and only avail/disabled storages from the node listing', () => {
    const cluster = clusterStorageEntries(CLUSTER_ROWS, 'pve1');
    expect(cluster.map((r) => r.storage)).toEqual(['pbs-main', 'local', 'nas-nfs']);
    const s = mergeStorage({ cluster, node: NODE_ROWS, nodeFresh: true });
    expect(s.map((x) => [x.id, x.enabled, x.active])).toEqual([
      ['local', true, true],
      ['nas-nfs', true, false],
      ['old', false, false],
      ['pbs-main', true, true],
    ]);
    // used/total from pvestatd (fresher), avail from the listing
    expect(s[0]).toEqual({ id: 'local', type: 'dir', content: ['backup', 'iso', 'vztmpl'], active: true, enabled: true, shared: false, total: 100, used: 26, avail: 70, usedFraction: 0.26 });

    // the slow listing timed out or never ran: the cluster data alone still describes every enabled storage
    const alone = mergeStorage({ cluster, nodeFresh: false });
    expect(alone.map((x) => x.id)).toEqual(['local', 'nas-nfs', 'pbs-main']);
    expect(alone[0]).toMatchObject({ total: 100, used: 26, avail: 74, active: true });
    expect(alone[1]).toMatchObject({ active: false, total: 0 });
  });

  it('trusts a fresh "inactive" from the node listing over pvestatd data kept for 5 minutes, and vice versa', () => {
    const cluster = clusterStorageEntries(CLUSTER_ROWS, 'pve1');
    const pbsDown = NODE_ROWS.map((r) => (r.storage === 'pbs-main' ? { ...r, active: 0, total: 0, used: 0, avail: 0 } : r));
    expect(mergeStorage({ cluster, node: pbsDown, nodeFresh: true }).find((x) => x.id === 'pbs-main')).toMatchObject({ active: false, total: 0 });
    // a stale listing is not trusted for that
    expect(mergeStorage({ cluster, node: pbsDown, nodeFresh: false }).find((x) => x.id === 'pbs-main')).toMatchObject({ active: true });
    // pvestatd has no data yet, the listing says it answers
    const nfsUp = NODE_ROWS.map((r) => (r.storage === 'nas-nfs' ? { ...r, active: 1, total: 1000, used: 400, avail: 600 } : r));
    expect(mergeStorage({ cluster, node: nfsUp, nodeFresh: true }).find((x) => x.id === 'nas-nfs')).toMatchObject({ active: true, total: 1000, used: 400, avail: 600, usedFraction: 0.4 });
  });

  it('maps LVM-thin pools with metadata usage', () => {
    expect(
      mapLvmThin([
        { lv: 'data', vg: 'pve', lv_size: 857619677184, used: 120065754317, metadata_size: 8749318144, metadata_used: 227481272, lv_state: 'a', lv_type: 't', ctime: '1700000000' },
        { lv: 'broken' },
      ]),
    ).toEqual([{ name: 'data', vg: 'pve', size: 857619677184, used: 120065754317, metadataSize: 8749318144, metadataUsed: 227481272 }]);
    expect(mapLvmThin(null)).toEqual([]);
  });

  it('maps zpool list and detail (vdev tree, optional status lines)', () => {
    expect(mapZfsPools([{ name: 'tank', size: 3985729650688, alloc: 1288490188800, free: 2697239461888, frag: 11, dedup: 1, health: 'DEGRADED' }])).toEqual([
      { name: 'tank', size: 3985729650688, alloc: 1288490188800, free: 2697239461888, fragPercent: 11, dedup: 1, health: 'DEGRADED' },
    ]);
    const d = mapZfsDetail(
      {
        name: 'tank', state: 'DEGRADED', status: 'One or more devices could not be used.', action: "Replace the device using 'zpool replace'.",
        see: 'https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-4J', scan: 'scrub repaired 0B in 03:12:44 with 0 errors', errors: 'No known data errors', leaf: 0,
        children: [
          { name: 'tank', state: 'DEGRADED', read: 0, write: 0, cksum: 0, msg: '', leaf: 0, children: [
            { name: 'mirror-0', state: 'DEGRADED', read: 0, write: 0, cksum: 0, msg: '', leaf: 0, children: [
              { name: '/dev/disk/by-id/ata-WDC-part1', state: 'ONLINE', read: 0, write: 0, cksum: 0, msg: '', leaf: 1 },
              { name: '1234567890123456789', state: 'UNAVAIL', read: 0, write: 0, cksum: 0, msg: 'was /dev/disk/by-id/ata-WDC2-part1', leaf: 1 },
            ] },
          ] },
          { name: 'spares', msg: '', leaf: 0, children: [{ name: '/dev/sdz', state: 'AVAIL', msg: '', leaf: 1 }] },
        ],
      },
      'tank',
    );
    expect(d.state).toBe('DEGRADED');
    expect(d.errors).toBe('No known data errors');
    expect(d.vdevs[0]!.children[0]!.children[1]).toEqual({ name: '1234567890123456789', state: 'UNAVAIL', read: 0, write: 0, cksum: 0, msg: 'was /dev/disk/by-id/ata-WDC2-part1', children: [] });
    expect(d.vdevs[1]).toEqual({ name: 'spares', children: [{ name: '/dev/sdz', state: 'AVAIL', children: [] }] });
  });
});

describe('disks & SMART', () => {
  const DISKS = [
    { devpath: '/dev/nvme0n1', size: 1000204886016, vendor: 'unknown', model: 'Samsung SSD 980 PRO 1TB', serial: 'S5GX', wwn: 'unknown', type: 'nvme', rpm: 0, gpt: 1, health: 'PASSED', wearout: 97, used: 'BIOS boot', by_id_link: '/dev/disk/by-id/nvme-Samsung', osdid: -1, 'osdid-list': null },
    { devpath: '/dev/sda', size: 1000204886016, vendor: 'ATA', model: 'Samsung_SSD_870_EVO_1TB', serial: 'S6PU', wwn: '0x5002538f4123abcd', type: 'ssd', rpm: 0, gpt: 1, health: 'PASSED', wearout: '98', used: 'ZFS' },
    { devpath: '/dev/sdb', size: 4000787030016, vendor: 'ATA', model: 'WDC_WD40EFRX', serial: 'WD-1', type: 'hdd', rpm: 5400, gpt: 1, health: 'FAILED!', wearout: 'N/A', used: 'ZFS' },
    { devpath: '/dev/sdc', size: 2000398934016, vendor: 'Seagate', model: 'Expansion_HDD', serial: 'NA', type: 'usb', rpm: 0, gpt: 1, health: 'UNKNOWN', wearout: 'N/A', used: 'ext4' },
    { devpath: '/dev/sdd', size: 480103981056, type: 'ssd', rpm: 0, gpt: 0, health: 'PASSED', wearout: 'N/A' },
    { devpath: '/dev/nvme1n1', size: 1, type: 'nvme', health: 'PASSED', wearout: -12 }, // Percentage Used 112%
    { devpath: '/dev/sde', size: 1, type: 'unknown', rpm: -1, health: 'OK', wearout: 'N/A' }, // SAS
  ];

  it('maps disks/list: wearout (remaining) → wearUsedPercent, health classes, unknown placeholders', () => {
    const d = mapDisks(DISKS);
    const by = (p: string) => d.find((x) => x.devpath === p)!;
    expect(by('/dev/nvme0n1')).toEqual({
      devpath: '/dev/nvme0n1', type: 'nvme', size: 1000204886016, health: 'PASSED', healthStatus: 'ok', model: 'Samsung SSD 980 PRO 1TB',
      serial: 'S5GX', wearUsedPercent: 3, used: 'BIOS boot', byIdLink: '/dev/disk/by-id/nvme-Samsung', gpt: true,
    });
    expect(by('/dev/sda').wearUsedPercent).toBe(2); // numeric string accepted
    expect(by('/dev/sda').wwn).toBe('0x5002538f4123abcd');
    expect(by('/dev/sdb')).toMatchObject({ healthStatus: 'failed', rpm: 5400 });
    expect(by('/dev/sdb').wearUsedPercent).toBeUndefined();
    expect(by('/dev/sdc').healthStatus).toBe('unknown');
    expect(by('/dev/sdd').used).toBeUndefined(); // unused disk
    expect(by('/dev/nvme1n1').wearUsedPercent).toBe(112); // can exceed 100
    expect(by('/dev/sde')).toMatchObject({ healthStatus: 'ok', type: 'unknown' });
    expect(by('/dev/sde').rpm).toBeUndefined();
    expect(d.map((x) => x.devpath)).toEqual(['/dev/nvme0n1', '/dev/nvme1n1', '/dev/sda', '/dev/sdb', '/dev/sdc', '/dev/sdd', '/dev/sde']);
  });

  it('classifies health verdicts', () => {
    expect(healthStatus('PASSED')).toBe('ok');
    expect(healthStatus('OK')).toBe('ok');
    expect(healthStatus('FAILED!')).toBe('failed');
    expect(healthStatus('UNKNOWN!')).toBe('unknown');
    expect(healthStatus('SMART Disabled')).toBe('unknown');
    expect(healthStatus('FIRMWARE IMPENDING FAILURE [asc=5d, ascq=0]')).toBe('failed');
  });

  it('maps ATA SMART: trims padded ids, extracts temperature and power-on hours', () => {
    const r = mapSmart('/dev/sda', {
      type: 'ata', health: 'PASSED',
      attributes: [
        { id: '  5', name: 'Reallocated_Sector_Ct', flags: 'PO--CK', value: 100, normalized: 100, worst: 100, threshold: 10, fail: '-', raw: '0' },
        { id: '  9', name: 'Power_On_Hours', flags: '-O--CK', value: 95, normalized: 95, worst: 95, threshold: 0, fail: '-', raw: '21345' },
        { id: '190', name: 'Airflow_Temperature_Cel', flags: '-O--CK', value: 69, normalized: 69, worst: 52, threshold: 0, fail: '-', raw: '31' },
        { id: '194', name: 'Temperature_Celsius', flags: '-O---K', value: 66, normalized: 66, worst: 55, threshold: 0, fail: '-', raw: '34 (Min/Max 20/45)' },
      ],
    });
    expect(r.type).toBe('ata');
    expect(r.healthStatus).toBe('ok');
    expect(r.attributes[0]).toEqual({ id: '5', name: 'Reallocated_Sector_Ct', value: 100, normalized: 100, worst: 100, threshold: 10, flags: 'PO--CK', fail: '-', raw: '0' });
    expect(r.temperatureC).toBe(34); // 194 preferred over 190
    expect(r.powerOnHours).toBe(21345);
    expect(r.text).toBeUndefined();
  });

  it('maps NVMe text SMART (pve-storage nvme_smart fixture)', () => {
    const r = mapSmart('/dev/nvme0n1', {
      type: 'text', health: 'PASSED', wearout: 69,
      text: '\nSMART/Health Information (NVMe Log 0x02, NSID 0xffffffff)\nCritical Warning:                   0x00\nTemperature:                        32 Celsius\nAvailable Spare:                    100%\nPercentage Used:                    31%\nPower Cycles:                       98\nPower On Hours:                     1,687\nUnsafe Shutdowns:                   21\n',
    });
    expect(r.type).toBe('text');
    expect(r.attributes).toEqual([]);
    expect(r.temperatureC).toBe(32);
    expect(r.powerOnHours).toBe(1687);
  });

  it('maps the PVE 9 failure shape {health:"UNKNOWN"}', () => {
    expect(mapSmart('/dev/sdz', { health: 'UNKNOWN' })).toEqual({ devpath: '/dev/sdz', health: 'UNKNOWN', healthStatus: 'unknown', type: 'unknown', attributes: [] });
  });
});

describe('tasks', () => {
  const TASKS = [
    { upid: 'UPID:pve1:0010A2B1:09F3E1C2:68E322A3:vzdump::root@pam:', node: 'pve1', pid: 1090225, pstart: 166977986, starttime: 1759716003, type: 'vzdump', id: '', user: 'root@pam', endtime: 1759718000, status: 'job errors' },
    { upid: 'UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam:', node: 'pve1', pid: 1234567, pstart: 169552957, starttime: 1759802403, type: 'vzdump', id: '', user: 'root@pam', status: 'RUNNING', saved: '0' },
    { upid: 'UPID:pve1:000F4240:09A1B2C3:68E322AC:qmstart:100:root@pam!dash:', node: 'pve1', pid: 1000000, pstart: 161592003, starttime: 1759716012, type: 'qmstart', id: '100', user: 'root@pam', tokenid: 'dash', endtime: 1759716014, status: 'OK' },
    { upid: 'UPID:pve1:0012D600:09A00000:68E1D123:vzdump:105:root@pam:', node: 'pve1', pid: 1234432, pstart: 161480704, starttime: 1759629603, type: 'vzdump', id: '105', user: 'root@pam', endtime: 1759629975, status: 'WARNINGS: 1' },
  ];

  it('maps task list: running first, token user, severity, ms timestamps', () => {
    const t = mapTasks(TASKS);
    expect(t.map((x) => x.severity)).toEqual(['running', 'ok', 'error', 'warning']);
    expect(t[0]).toEqual({ upid: TASKS[1]!.upid, node: 'pve1', type: 'vzdump', user: 'root@pam', startTime: 1759802403000, status: 'RUNNING', severity: 'running' });
    expect(t[1]).toMatchObject({ user: 'root@pam!dash', id: '100', endTime: 1759716014000, status: 'OK' });
    expect(t[2]!.id).toBeUndefined(); // multi-guest vzdump has an empty id
    expect(t[2]!.status).toBe('job errors');
  });

  it('classifies statuses', () => {
    expect(taskSeverity('OK', true)).toBe('ok');
    expect(taskSeverity('WARNINGS: 12', true)).toBe('warning');
    expect(taskSeverity('RUNNING', false)).toBe('running');
    expect(taskSeverity(undefined, false)).toBe('running');
    expect(taskSeverity('interrupted by signal', true)).toBe('error');
    expect(taskSeverity('unexpected status', true)).toBe('error');
  });

  it('parses UPIDs (8 or 9 hex pstart, empty id) and rejects junk', () => {
    expect(parseUpid('UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam:')).toEqual({ node: 'pve1', type: 'vzdump', id: '', user: 'root@pam', startTime: 0x68e47423 * 1000 });
    expect(parseUpid('UPID:pve1:0012D687:10A1B2C3D:68E47423:qmstart:100:root@pam!tok:')?.id).toBe('100');
    expect(parseUpid('UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam')).toBeUndefined(); // no trailing colon
    expect(parseUpid('../../etc/passwd')).toBeUndefined();
  });

  it('maps a task log page', () => {
    expect(mapTaskLog('U', [{ n: 2, t: 'INFO: b' }, { n: 1, t: 'INFO: a' }], 57)).toEqual({ upid: 'U', lines: ['INFO: a', 'INFO: b'], total: 57 });
  });
});

describe('backups', () => {
  const NOW = Date.UTC(2025, 9, 6, 12, 0, 0);
  const CONTENT_DIR = [
    { volid: 'local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst', content: 'backup', format: 'tar.zst', size: 734003200, ctime: 1759629841, subtype: 'lxc', vmid: 101, notes: 'pihole' },
    { volid: 'local:backup/vzdump-qemu-100-2025_10_05-02_00_03.vma.zst', content: 'backup', format: 'vma.zst', size: 2309737472, ctime: 1759629603, subtype: 'qemu', vmid: 100, notes: 'homeassistant', protected: 1 },
  ];
  const CONTENT_PBS = [
    { volid: 'pbs-main:backup/ct/101/2025-10-06T02:04:01Z', content: 'backup', format: 'pbs-ct', size: 1567285248, ctime: 1759716241, vmid: 101, subtype: 'lxc', notes: 'pihole', verification: { state: 'ok', upid: 'UPID:pbs:...' } },
    { volid: 'pbs-main:backup/vm/100/2025-10-05T02:00:03Z', content: 'backup', format: 'pbs-vm', size: 34359738368, ctime: 1759629603, vmid: 100, subtype: 'qemu', encrypted: '3f:9a:6c' },
  ];

  it('maps full content listings (dir + PBS)', () => {
    const dir = mapBackupContent(CONTENT_DIR, 'local');
    expect(dir[1]).toEqual({ volid: CONTENT_DIR[1]!.volid, storage: 'local', vmid: 100, ctime: 1759629603000, protected: true, guestType: 'qemu', size: 2309737472, format: 'vma.zst', notes: 'homeassistant' });
    const pbs = mapBackupContent(CONTENT_PBS, 'pbs-main');
    expect(pbs[0]).toMatchObject({ guestType: 'lxc', verification: 'ok', protected: false, format: 'pbs-ct' });
    expect(pbs[1]).toMatchObject({ guestType: 'qemu', encrypted: true });
  });

  it('maps the read-only prunebackups fallback (string vmid on PBS, no size)', () => {
    const items = mapPruneBackups(
      [
        { volid: 'local:backup/vzdump-qemu-100-2025_10_05-02_00_03.vma.zst', ctime: 1759629603, type: 'qemu', vmid: 100, mark: 'protected' },
        { volid: 'pbs-main:backup/ct/101/2025-10-06T02:04:01Z', ctime: 1759716241, type: 'lxc', vmid: '101', mark: 'keep' },
        { volid: 'local:backup/odd-name.vma', ctime: 1, type: 'unknown', mark: 'renamed' }, // no vmid → skipped
      ],
      'local',
    );
    expect(items).toEqual([
      { volid: 'local:backup/vzdump-qemu-100-2025_10_05-02_00_03.vma.zst', storage: 'local', vmid: 100, ctime: 1759629603000, protected: true, guestType: 'qemu' },
      { volid: 'pbs-main:backup/ct/101/2025-10-06T02:04:01Z', storage: 'local', vmid: 101, ctime: 1759716241000, protected: false, guestType: 'lxc' },
    ]);
  });

  it('computes coverage: newest per guest, staleness, not-in-any-job, templates skipped', () => {
    const items = sortBackups([...mapBackupContent(CONTENT_DIR, 'local'), ...mapBackupContent(CONTENT_PBS, 'pbs-main')]);
    const guests = [
      { vmid: 100, name: 'haos', type: 'qemu' as const },
      { vmid: 101, name: 'pihole', type: 'lxc' as const },
      { vmid: 102, name: 'never', type: 'lxc' as const },
      { vmid: 9000, name: 'tpl', type: 'qemu' as const, template: true },
      { vmid: 103, name: 'reused-id', type: 'qemu' as const },
    ];
    // a backup of a deleted *container* 103 must not count for the VM 103
    items.push({ volid: 'local:backup/vzdump-lxc-103-x.tar.zst', storage: 'local', vmid: 103, ctime: NOW - 1000, protected: false, guestType: 'lxc' });
    const cov = computeCoverage({ guests, items, notBackedUp: mapNotBackedUp([{ vmid: 102, type: 'lxc', name: 'never' }]), staleDays: 1, now: NOW });
    expect(cov.map((c) => c.vmid)).toEqual([100, 101, 102, 103]);
    expect(cov[0]).toEqual({ vmid: 100, name: 'haos', type: 'qemu', notInAnyJob: false, stale: true, staleAfterDays: 1, lastBackup: 1759629603000, lastBackupStorage: 'local', ageDays: 1.42 });
    expect(cov[1]).toMatchObject({ lastBackupStorage: 'pbs-main', stale: false, ageDays: 0.41 });
    expect(cov[2]).toEqual({ vmid: 102, name: 'never', type: 'lxc', notInAnyJob: true, stale: true, staleAfterDays: 1 });
    expect(cov[3]!.lastBackup).toBeUndefined();

    const lb = lastBackups(items, guests);
    expect(lb.get(101)).toEqual({ time: 1759716241000, storage: 'pbs-main', volid: CONTENT_PBS[0]!.volid, size: 1567285248, verification: 'ok' });
    expect(lb.get(100)).toMatchObject({ storage: 'local', protected: true });
  });

  it('applies per-guest thresholds and reports failures only while no newer good backup exists', () => {
    const items = sortBackups(mapBackupContent(CONTENT_DIR, 'local'));
    const guests = [
      { vmid: 100, name: 'haos', type: 'qemu' as const },
      { vmid: 101, name: 'pihole', type: 'lxc' as const },
    ];
    const lastOf100 = 1759629603000; // 1.42 days before NOW
    const cov = computeCoverage({
      guests,
      items,
      staleDays: 1,
      now: NOW,
      thresholds: new Map([[100, 8]]), // weekly job
      failures: new Map([
        [100, { time: lastOf100 + 3_600_000, upid: 'UPID:pve1:1:1:1:vzdump::root@pam:', message: 'backup connect failed' }],
        [101, { time: lastOf100 - 86_400_000, upid: 'UPID:pve1:2:2:2:vzdump::root@pam:' }], // older than its last backup
      ]),
    });
    expect(cov[0]).toMatchObject({ vmid: 100, staleAfterDays: 8, stale: false, lastFailure: { message: 'backup connect failed' } });
    expect(cov[1]).toMatchObject({ vmid: 101, staleAfterDays: 1, stale: true });
    expect(cov[1]!.lastFailure).toBeUndefined();
  });

  it('maps backup jobs with next-run and selection text', () => {
    const jobs = mapBackupJobs([
      { id: 'backup-5f2c1a3e-7d1b', type: 'vzdump', schedule: '02:00', enabled: 1, 'next-run': 1759802400, storage: 'pbs-main', mode: 'snapshot', all: 1, exclude: '999,998', node: 'pve1', comment: 'nightly to PBS' },
      { id: 'backup-9a8b', type: 'vzdump', schedule: 'sun 04:15', enabled: 0, 'next-run': 1760242500, storage: 'local', mode: 'stop', vmid: '100,101' },
      { id: 'backup-pool', type: 'vzdump', schedule: 'sat 01:00', pool: 'prod' },
    ]);
    expect(jobs[0]).toEqual({ id: 'backup-5f2c1a3e-7d1b', enabled: true, selection: 'All guests except 999, 998 (node pve1)', schedule: '02:00', storage: 'pbs-main', mode: 'snapshot', nextRun: 1759802400000, comment: 'nightly to PBS' });
    // PVE computes next-run for disabled jobs too, but they never run: no "next run" for them
    expect(jobs[1]).toMatchObject({ enabled: false, selection: '100, 101', schedule: 'sun 04:15' });
    expect(jobs[1]!.nextRun).toBeUndefined();
    expect(jobs[2]).toMatchObject({ enabled: true, selection: 'Pool: prod' });
    expect(describeSelection({})).toBe('No guests');
  });
});

describe('host info', () => {
  it('maps network config (active absent = down, sorted by priority)', () => {
    const n = mapNetwork([
      { iface: 'vmbr0', type: 'bridge', priority: 4, families: ['inet'], method: 'static', method6: 'manual', autostart: 1, active: 1, address: '192.168.1.10', netmask: '24', cidr: '192.168.1.10/24', gateway: '192.168.1.1', bridge_ports: 'enp3s0', bridge_stp: 'off', bridge_fd: '0', bridge_vlan_aware: 1, comments: 'LAN bridge\n' },
      { iface: 'enp3s0', type: 'eth', priority: 3, families: ['inet'], method: 'manual', method6: 'manual', exists: 1, active: 1 },
      { iface: 'enp4s0', type: 'eth', priority: 5, method: 'manual', exists: 1 },
      { iface: 'vmbr0.20', type: 'vlan', priority: 6, method: 'manual', 'vlan-id': '20', 'vlan-raw-device': 'vmbr0', mtu: '1500' },
      { iface: 'bond0', type: 'bond', priority: 7, slaves: 'enp5s0 enp6s0', bond_mode: '802.3ad', bridge_ports: '' },
    ]);
    expect(n.map((x) => x.iface)).toEqual(['enp3s0', 'vmbr0', 'enp4s0', 'vmbr0.20', 'bond0']);
    expect(n[1]).toEqual({ iface: 'vmbr0', type: 'bridge', active: true, autostart: true, method: 'static', cidr: '192.168.1.10/24', address: '192.168.1.10', gateway: '192.168.1.1', bridgePorts: ['enp3s0'], bridgeVlanAware: true, comments: 'LAN bridge' });
    expect(n[2]!.active).toBe(false);
    expect(n[3]).toMatchObject({ vlanId: 20, vlanRawDevice: 'vmbr0', mtu: 1500 });
    expect(n[4]).toMatchObject({ bondSlaves: ['enp5s0', 'enp6s0'], bondMode: '802.3ad', bridgePorts: [] });
  });

  it('maps pkgupdates (helper) and apt/versions (pending only)', () => {
    expect(mapPkgUpdates([{ Package: 'pve-manager', Title: 'PVE', Version: '9.1.5', OldVersion: '9.1.4', Origin: 'Proxmox', Section: 'admin', Priority: 'optional', Arch: 'all' }, { Package: 'newdep', Version: '1.0' }])).toEqual([
      { name: 'newdep', newVersion: '1.0' },
      { name: 'pve-manager', newVersion: '9.1.5', oldVersion: '9.1.4', origin: 'Proxmox', priority: 'optional', section: 'admin', title: 'PVE' },
    ]);
    const av = mapAptVersions([
      { Package: 'proxmox-ve', Version: '9.1.0', OldVersion: '9.1.0', CurrentState: 'Installed', RunningKernel: '6.14.11-4-pve' },
      { Package: 'pve-manager', Version: '9.1.5', OldVersion: '9.1.4', CurrentState: 'Installed', ManagerVersion: '9.1.4' },
      { Package: 'ceph', Version: '19.2', CurrentState: 'NotInstalled' },
    ]);
    expect(av).toEqual([{ name: 'pve-manager', newVersion: '9.1.5', oldVersion: '9.1.4' }]);
  });

  it('finds installed kernels in apt/versions and compares kernel releases', () => {
    const raw = [
      { Package: 'proxmox-ve', Version: '9.1.0', OldVersion: '9.1.0', CurrentState: 'Installed', RunningKernel: '6.14.11-4-pve' },
      { Package: 'proxmox-kernel-6.14', Version: '6.14.11-5', OldVersion: '6.14.11-5', CurrentState: 'Installed' },
      { Package: 'proxmox-kernel-6.14.11-4-pve-signed', Version: '6.14.11-4', OldVersion: '6.14.11-4', CurrentState: 'Installed' },
      { Package: 'proxmox-kernel-6.14.11-5-pve-signed', Version: '6.14.11-5', OldVersion: '6.14.11-5', CurrentState: 'Installed' },
      { Package: 'proxmox-kernel-6.8.12-9-pve', Version: '6.8.12-9', OldVersion: '6.8.12-9', CurrentState: 'Installed' },
      { Package: 'pve-kernel-5.15.158-2-pve', Version: '5.15.158-2', OldVersion: '5.15.158-2' },
      { Package: 'proxmox-kernel-6.14.8-2-bpo12-pve-signed', Version: '6.14.8-2', OldVersion: '6.14.8-2', CurrentState: 'Installed' },
      { Package: 'proxmox-kernel-6.11.0-1-pve-signed', Version: '6.11.0-1', CurrentState: 'ConfigFiles', OldVersion: '6.11.0-1' },
      { Package: 'proxmox-kernel-helper', Version: '9.0.4', OldVersion: '9.0.4', CurrentState: 'Installed' },
    ];
    expect(installedKernels(raw).sort()).toEqual(['5.15.158-2-pve', '6.14.11-4-pve', '6.14.11-5-pve', '6.14.8-2-bpo12-pve', '6.8.12-9-pve']);
    expect(newestKernel(installedKernels(raw))).toBe('6.14.11-5-pve');
    expect(compareKernels('6.8.12-10-pve', '6.8.12-9-pve')).toBeGreaterThan(0);
    expect(compareKernels('6.8.12-9-pve', '6.14.0-1-pve')).toBeLessThan(0);
    expect(compareKernels('6.8.12-9-pve', '6.8.12-9-pve')).toBe(0);
    expect(newestKernel([undefined, '6.8.12-1-pve', undefined])).toBe('6.8.12-1-pve');
    expect(newestKernel([])).toBeUndefined();
  });

  it('maps version, subscription (no key), certificate pick and services', () => {
    expect(mapVersion({ version: '9.1.4', release: '9.1', repoid: '5ac30304265fbd8e', console: 'xtermjs' })).toEqual({ version: '9.1.4', release: '9.1', repoid: '5ac30304265fbd8e', console: 'xtermjs' });
    const sub = mapSubscription({ status: 'active', level: 'c', productname: 'Proxmox VE Community', key: 'pve1c-0123456789', serverid: 'X' });
    expect(sub).toEqual({ status: 'active', level: 'c', productName: 'Proxmox VE Community' });
    expect(mapSubscription({ status: 'notfound', message: 'There is no subscription key' })).toEqual({ status: 'notfound' });

    const certs = [
      { filename: 'pve-root-ca.pem', fingerprint: '5B:E1', notafter: 2015360000 },
      { filename: 'pve-ssl.pem', fingerprint: '3A:B4', subject: '/CN=pve1.lan', issuer: '/CN=Proxmox Virtual Environment', notbefore: 1700000000, notafter: 1763072000, san: ['127.0.0.1', 'pve1'] },
    ];
    expect(pickCertificate(certs)).toEqual({ subject: '/CN=pve1.lan', issuer: '/CN=Proxmox Virtual Environment', notAfter: 1763072000000, fingerprint: '3A:B4', filename: 'pve-ssl.pem', san: ['127.0.0.1', 'pve1'] });
    expect(pickCertificate([...certs, { filename: 'pveproxy-ssl.pem', fingerprint: 'AC:ME', notafter: 1 }])?.filename).toBe('pveproxy-ssl.pem');

    expect(mapHostServices([
      { service: 'pveproxy', name: 'pveproxy', desc: 'PVE API Proxy Server', state: 'running', 'active-state': 'active', 'unit-state': 'enabled' },
      { service: 'corosync', name: 'corosync', desc: 'Corosync Cluster Engine', state: 'dead', 'active-state': 'inactive', 'unit-state': 'enabled' },
      { service: 'broken', state: 'unknown' },
    ])).toEqual([
      { service: 'broken', state: 'unknown' },
      { service: 'corosync', name: 'corosync', desc: 'Corosync Cluster Engine', state: 'dead', activeState: 'inactive', unitState: 'enabled' },
      { service: 'pveproxy', name: 'pveproxy', desc: 'PVE API Proxy Server', state: 'running', activeState: 'active', unitState: 'enabled' },
    ]);
  });
});
