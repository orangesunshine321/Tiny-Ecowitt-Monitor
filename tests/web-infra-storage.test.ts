import { describe, expect, it } from 'vitest';
import type { PhysicalDisk, StoragePool, ZfsVdev } from '../shared/types';
import {
  attrName,
  contentLabels,
  diskForVdev,
  diskTypeLabel,
  flattenVdevs,
  known,
  poolProblems,
  poolStatus,
  prettyModel,
  shortVdevName,
  smartAttrState,
  storageThresholds,
  storageTypeLabel,
  tidy,
  vdevStatus,
  wearFraction,
  wearTone,
} from '../web/src/pages/storage/storageModel';

const T = storageThresholds({ storageWarnPercent: 85, storageCritPercent: 95 });

const pool = (over: Partial<StoragePool>): StoragePool => ({
  id: 'local',
  type: 'dir',
  content: ['backup'],
  active: true,
  enabled: true,
  shared: false,
  total: 100,
  used: 10,
  avail: 90,
  usedFraction: 0.1,
  ...over,
});

describe('storage pools', () => {
  it('labels PVE storage types and content', () => {
    expect(storageTypeLabel('zfspool')).toBe('ZFS');
    expect(storageTypeLabel('pbs')).toBe('Proxmox Backup Server');
    expect(storageTypeLabel('lvmthin')).toBe('LVM-Thin');
    expect(storageTypeLabel('cifs')).toBe('SMB/CIFS');
    expect(storageTypeLabel('my-plugin')).toBe('my-plugin');
    // content is unordered in the API; labels come out in a stable order and "none" is dropped
    expect(contentLabels(['vztmpl', 'iso', 'backup', 'snippets'])).toEqual(['CT templates', 'ISO images', 'Backups', 'Snippets']);
    expect(contentLabels(['rootdir', 'images'])).toEqual(['Disk images', 'Containers']);
    expect(contentLabels(['none'])).toEqual([]);
    expect(contentLabels(['import', 'zzz'])).toEqual(['Import', 'zzz']);
  });

  it('converts percent thresholds to fractions', () => {
    expect(T).toEqual({ warn: 0.85, crit: 0.95 });
  });

  it('flags disabled, unavailable and filling pools', () => {
    expect(poolStatus(pool({}), T)).toBeUndefined();
    expect(poolStatus(pool({ enabled: false, active: false, total: 0 }), T)).toEqual({ tone: 'off', label: 'Disabled' });
    // enabled but not active = unreachable (e.g. NFS down): totals are all 0
    expect(poolStatus(pool({ active: false, total: 0, used: 0, usedFraction: 0 }), T)).toEqual({ tone: 'warn', label: 'Unavailable' });
    expect(poolStatus(pool({ usedFraction: 0.86 }), T)).toEqual({ tone: 'warn', label: 'Filling up' });
    expect(poolStatus(pool({ usedFraction: 0.96 }), T)).toEqual({ tone: 'crit', label: 'Almost full' });
    expect(poolProblems([pool({}), pool({ usedFraction: 0.96 }), pool({ enabled: false, active: false })], T)).toBe(1);
  });
});

describe('disks', () => {
  it('labels types and models', () => {
    expect(diskTypeLabel({ type: 'nvme', rpm: 0 })).toBe('NVMe');
    expect(diskTypeLabel({ type: 'hdd', rpm: 5400 })).toMatch(/^HDD · 5.?400 rpm$/);
    expect(diskTypeLabel({ type: 'unknown', rpm: -1 })).toBe('Unknown');
    expect(prettyModel('WDC_WD40EFRX-68N32N0')).toBe('WDC WD40EFRX-68N32N0');
    expect(prettyModel('unknown')).toBeUndefined();
    expect(known('unknown')).toBeUndefined();
    expect(known('0x5002538f4123abcd')).toBe('0x5002538f4123abcd');
  });

  it('colours wear (percent USED) and clamps the meter', () => {
    expect(wearTone(3, 80)).toBe('ok');
    expect(wearTone(80, 80)).toBe('warn');
    expect(wearTone(100, 80)).toBe('crit');
    expect(wearTone(112, 80)).toBe('crit'); // worn NVMe: Percentage Used above 100
    expect(wearTone(undefined, 80)).toBeUndefined(); // HDDs report "N/A"
    expect(wearFraction(31)).toBeCloseTo(0.31);
    expect(wearFraction(112)).toBe(1);
    expect(wearFraction(-4)).toBe(0);
    expect(wearFraction(undefined)).toBeUndefined();
  });

  it('flags SMART attributes that fail now, failed in the past or are under threshold', () => {
    expect(smartAttrState({ fail: '-', value: 100, threshold: 10 })).toBeUndefined();
    expect(smartAttrState({ fail: 'NOW', value: 138, threshold: 140 })).toEqual({ tone: 'crit', label: 'Failing now' });
    expect(smartAttrState({ fail: 'FAILING_NOW' })).toEqual({ tone: 'crit', label: 'Failing now' });
    expect(smartAttrState({ fail: 'Past' })).toEqual({ tone: 'warn', label: 'Failed in the past' });
    expect(smartAttrState({ fail: 'In_the_past' })).toEqual({ tone: 'warn', label: 'Failed in the past' });
    expect(smartAttrState({ fail: '-', normalized: 5, value: 5, threshold: 10 })).toEqual({ tone: 'crit', label: 'Below threshold' });
    // threshold 0 ("---") never trips
    expect(smartAttrState({ fail: '-', value: 0, threshold: 0 })).toBeUndefined();
    expect(attrName('Reallocated_Sector_Ct')).toBe('Reallocated Sector Ct');
  });
});

describe('ZFS', () => {
  // GET /nodes/{node}/disks/zfs/{name} as mapped by the server (research §5b): children[0] repeats the pool name,
  // leaves are full /dev/disk/by-id paths, logs/cache sections have no state.
  const vdevs: ZfsVdev[] = [
    {
      name: 'tank',
      state: 'DEGRADED',
      read: 0,
      write: 0,
      cksum: 0,
      children: [
        {
          name: 'mirror-0',
          state: 'DEGRADED',
          read: 0,
          write: 0,
          cksum: 0,
          children: [
            { name: '/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567-part1', state: 'ONLINE', read: 0, write: 0, cksum: 0, children: [] },
            { name: '1234567890123456789', state: 'UNAVAIL', read: 3, write: 0, cksum: 0, msg: 'was /dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K7654321-part1', children: [] },
          ],
        },
      ],
    },
    { name: 'spares', children: [{ name: '/dev/sdd', state: 'AVAIL', children: [] }] },
  ];

  it('flattens the tree with depth, sections and error flags', () => {
    const rows = flattenVdevs(vdevs);
    expect(rows.map((r) => [r.depth, r.display, r.section, r.leaf, r.hasErrors])).toEqual([
      [0, 'tank', false, false, false],
      [1, 'mirror-0', false, false, false],
      [2, 'ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567-part1', false, true, false],
      [2, '1234567890123456789', false, true, true],
      [0, 'spares', true, false, false],
      [1, 'sdd', false, true, false],
    ]);
    expect(rows[3]!.msg).toMatch(/^was /);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('maps vdev states including spares', () => {
    expect(vdevStatus('ONLINE')).toEqual({ tone: 'ok', label: 'Online' });
    expect(vdevStatus('AVAIL')).toEqual({ tone: 'ok', label: 'Available' });
    expect(vdevStatus('INUSE')).toEqual({ tone: 'info', label: 'In use' });
    expect(vdevStatus('DEGRADED')).toEqual({ tone: 'warn', label: 'Degraded' });
    expect(vdevStatus('UNAVAIL')).toEqual({ tone: 'crit', label: 'Unavail' });
    expect(vdevStatus('FAULTED')).toEqual({ tone: 'crit', label: 'Faulted' });
    expect(vdevStatus(undefined)).toBeUndefined();
  });

  it('matches leaves to physical disks by by-id link, serial or device path', () => {
    const disks = [
      { devpath: '/dev/sda', serial: 'WD-WCC7K1234567', byIdLink: '/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567' },
      { devpath: '/dev/sdb', serial: 'WD-WCC7K7654321' },
      { devpath: '/dev/nvme0n1', serial: 'S5GXNX0T123456A' },
    ] as PhysicalDisk[];
    expect(diskForVdev('/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567-part1', disks)?.devpath).toBe('/dev/sda');
    expect(diskForVdev('ata-WDC_WD40EFRX-68N32N0_WD-WCC7K7654321-part1', disks)?.devpath).toBe('/dev/sdb');
    expect(diskForVdev('/dev/nvme0n1p3', disks)?.devpath).toBe('/dev/nvme0n1');
    expect(diskForVdev('/dev/sdb1', disks)?.devpath).toBe('/dev/sdb');
    expect(diskForVdev('1234567890123456789', disks)).toBeUndefined();
    const nvme = [{ devpath: '/dev/nvme1n1', serial: 'unknown', wwn: 'eui.e8238fa6bf530001' }] as PhysicalDisk[];
    expect(diskForVdev('/dev/disk/by-id/nvme-eui.e8238fa6bf530001-part3', nvme)?.devpath).toBe('/dev/nvme1n1');
    expect(shortVdevName('/dev/disk/by-id/nvme-eui.0025385a11b2c3d4-part3')).toBe('nvme-eui.0025385a11b2c3d4-part3');
  });

  it('tidies zpool text', () => {
    expect(tidy('scrub repaired 0B in 08:30:12 with 0 errors on Sun Oct  4 08:54:13 2026')).toBe('scrub repaired 0B in 08:30:12 with 0 errors on Sun Oct 4 08:54:13 2026');
    expect(tidy('   ')).toBeUndefined();
  });
});
