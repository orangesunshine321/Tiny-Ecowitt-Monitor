# Proxmox VE REST API reference: storage, disks/SMART/ZFS/LVM, backups, tasks

Scope: what a read-only dashboard client needs, and enough detail to build a mock server that behaves like the real one. Covers PVE 8.x and 9.x.

How this was verified: I read the Perl/JS source on the official Proxmox GitHub mirrors (raw.githubusercontent.com, fetched 2026-10-10).
- **PVE 9** = `master` branches: libpve-storage-perl 9.1.13, pve-manager 9.2.21, libpve-common-perl 9.2.3, libpve-guest-common-perl 6.0.5.
- **PVE 8** = `stable-8` (pve-storage 8.3.9, pve-manager 8.4.22) and `stable-bookworm` (pve-common 8.3.8, proxmox-widget-toolkit).
- I diffed the PVE 8 and 9 files for every endpoint below. Where they differ, the text says so.
- If your PVE 8 node is older than those branch heads, small differences are possible.
- Line numbers ("L123") refer to the files listed in **Sources**. "UNVERIFIED" means I could not confirm it from source.

---

## 0. General conventions (apply to every endpoint)

- **Envelope.** Responses look like `{"data": ...}`. When a handler sets a `total` attribute, it appears next to `data` as `{"data": [...], "total": N}`, but **only when N is truthy**. A total of 0 is omitted.
  - Errors return `{"data": null, "message": "..."}`, or `"errors": {param: msg}` for parameter errors, with an HTTP 4xx/5xx status.
  - Source: pve-http-server `Formatter/Standard.pm` L14-52 (`if ($success && $res->{total})`).
- **Booleans are integers.** Perl code returns `1`/`0`, so the JSON has `1`/`0`, not `true`/`false`.
  - Values read straight from config files (storage.cfg, jobs.cfg, property strings) can be strings such as `"1"` or `"7"`. Coerce defensively.
- **Ordering.**
  - `/nodes/{node}/storage` and `/storage` come back in Perl hash order, i.e. unordered (`hash_to_array`, `storage_ids` use `keys %`).
  - The `content` string inside a storage entry is also unordered, e.g. `"iso,backup,vztmpl"`. Split on `,`.
  - Storage content listings are sorted by `lc(volid)`.
- **Units.**
  - Sizes are **bytes**.
  - Times are **Unix epoch seconds**.
  - `used_fraction` is a **fraction 0..1**.
  - ZFS `frag` is an **integer percent**. ZFS `dedup` is a **ratio**.
- **`protected => 1`** in the Perl source means the call is proxied to pvedaemon, which runs as root. It is not a permission. **`proxyto => 'node'`** means the call is forwarded to the named node.

### Permissions: critical for a read-only token

| Endpoint | Privilege required (source) |
|---|---|
| `GET /nodes/{node}/storage` | Lists only storages where you have `Datastore.Audit` **or** `Datastore.AllocateSpace` on `/storage/<id>` (Status.pm L72-76, L244-245) |
| `GET /storage` | Same filter (Config.pm L126-130, L162-163) |
| `GET /nodes/{node}/storage/{s}/content` | Endpoint: `Datastore.Audit` or `Datastore.AllocateSpace` on `/storage/{s}`. **Then each item is filtered by `check_volume_access`** (see below) |
| `GET /nodes/{node}/storage/{s}/prunebackups` (dry-run list) | `Datastore.Audit` **or** `Datastore.AllocateSpace` on `/storage/{s}`. No per-item filter (PruneBackups.pm L22-29) |
| `GET /nodes/{node}/disks/list` | `Sys.Audit` on `/` **or** on `/nodes/{node}` (Disks.pm L88-90) |
| `GET /nodes/{node}/disks/smart` | `Sys.Audit` on **`/`** (Disks.pm L186-188) |
| `GET /nodes/{node}/disks/zfs`, `zfs/{name}`, `lvm`, `lvmthin` | `Sys.Audit` on **`/`** (ZFS.pm L62-64, L135-137; LVM.pm L23-25; LVMThin.pm L24-26) |
| `GET /nodes/{node}/tasks` | Everyone. With `Sys.Audit` on `/nodes/{node}` you see all tasks; otherwise only your own (Tasks.pm L43-47, L184-190) |
| `GET /nodes/{node}/tasks/{upid}/status` and `/log` | Owner of the task, or `Sys.Audit` on `/nodes/{node}` (Tasks.pm L338-341, L405-407, L457-460, L527-529) |
| `GET /cluster/backup` | `Sys.Audit` on `/` (Backup.pm L187-189) |
| `GET /cluster/backup-info/not-backed-up` | `Sys.Audit` on `/`. Results are also filtered to VMIDs where you have `VM.Audit` (BackupInfo.pm L71-73, L109-110) |

**Backup volumes are invisible to a PVEAuditor token.** `GET .../content` runs `PVE::Storage::check_volume_access` on every item and silently drops the ones that fail (Content.pm L170-176). For a `backup` volume, the token passes only if it has one of:
- `Datastore.Allocate` on the storage, or
- `Datastore.AllocateSpace` on `/storage/<sid>` **and** `VM.Backup` on `/vms/<vmid>`.

A backup with no owner VMID always fails (Storage.pm L619-662, specifically L641-643). The built-in **PVEAuditor** role has none of these privileges (AccessControl.pm L1055-1200: audit privileges only). So a pure read-only token gets `[]` from the content endpoint for backups.

The privileges that would make backups visible (`Datastore.AllocateSpace` + `VM.Backup`) also allow **deleting** those backups (Content.pm delete handler, L456-506) and running vzdump. They are not read-only.

**Read-only alternative: the prune dry-run.** `GET /nodes/{node}/storage/{storage}/prunebackups?prune-backups=keep-all=1` needs only `Datastore.Audit`. It returns every backup on the storage as `{volid, ctime, type, vmid, mark}`, but without size, notes, verification or encryption. Details in §2b.

---

## 1. Storage status and configuration

### 1a. `GET /nodes/{node}/storage`: per-node storage status

Parameters (all optional):

| Parameter | Type | Meaning |
|---|---|---|
| `storage` | id | Only this storage. Unknown id → 400 "No such storage." |
| `content` | comma list | Only storages that support at least one of these content types **and are enabled** |
| `enabled` | bool, default 0 | Hide storages with `disable` set in the config |
| `target` | node | Only shared storages reachable from both nodes |
| `format` | bool, default 0 | Add format info: `format` (deprecated tuple), `formats`, and `select_existing` (PVE 9 only) |

Each item is built in `PVE::Storage::storage_info` (Storage.pm L1447-1531):

| Field | Type | Notes |
|---|---|---|
| `storage` | string | Storage id |
| `type` | string | One of `dir`, `lvm`, `lvmthin`, `nfs`, `cifs`, `iscsi`, `iscsidirect`, `rbd`, `cephfs`, `zfspool`, `zfs` (ZFS over iSCSI), `pbs`, `btrfs`, `esxi`, plus third-party plugin types (Storage.pm L53-66) |
| `content` | string | Comma list, **unordered**. Values: `images`, `rootdir`, `vztmpl`, `iso`, `backup`, `snippets`, `import`, or `none` |
| `enabled` | 0/1 | Always present. `0` if `disable` is set **or** the storage's `nodes` list excludes this node (`storage_check_enabled` → `storage_check_node`) |
| `active` | 0/1 | Always present. `1` only if activation and the plugin `status()` call both succeeded. Disabled storages are never activated, so they are `0` |
| `shared` | 0/1 | Always present (`? 1 : 0`, L1478). Forced to 1 for types `iscsi`, `nfs`, `cifs`, `rbd`, `cephfs`, `iscsidirect`, `zfs`, `drbd`, `pbs` (Plugin.pm L44-46, L606-617). Otherwise taken from the config |
| `total`, `used`, `avail` | int bytes | Always present. **All 0** when not active. `int()`-ed (L1527-1529). On dir/ext4, `used + avail` can be less than `total` (filesystem reserve) |
| `used_fraction` | number 0..1 | `used/total`. **Only present if `total` is non-zero** (Status.pm L261-266) |

PVE 8 vs 9: the logic is the same. PVE 9 adds `formats`/`select_existing` (only with `format=1`) and the `identity` and `oci-registry-pull` sub-directories.

UNVERIFIED: on PVE 8, the code comment in PVE 9 (Status.pm L262) says the old `($data->{used}//0)/$data->{total}` expression "converts used and total to floating points". On PVE 8, `total`/`used` may therefore be serialised as JSON floats. For realistic sizes they are still integral values below 1e15. Parse them as numbers either way.

Example (PVE 9; PVE 8 looks the same):
```json
{"data":[
 {"storage":"local","type":"dir","content":"vztmpl,iso,backup","enabled":1,"active":1,"shared":0,
  "total":100861726720,"used":12352385024,"avail":83345887232,"used_fraction":0.122468506396794},
 {"storage":"local-zfs","type":"zfspool","content":"images,rootdir","enabled":1,"active":1,"shared":0,
  "total":421301059584,"used":48318382080,"avail":372982677504,"used_fraction":0.114688489337555},
 {"storage":"pbs-main","type":"pbs","content":"backup","enabled":1,"active":1,"shared":1,
  "total":3985729650688,"used":1288490188800,"avail":2697239461888,"used_fraction":0.323275862068966},
 {"storage":"nas-nfs","type":"nfs","content":"backup,iso","enabled":1,"active":0,"shared":1,
  "total":0,"used":0,"avail":0},
 {"storage":"old-usb","type":"dir","content":"backup","enabled":0,"active":0,"shared":0,
  "total":0,"used":0,"avail":0}
]}
```
`GET /nodes/{node}/storage/{storage}/status` returns the same object for one storage, without `storage` and without `used_fraction` (Status.pm L326-409).

### 1b. `GET /storage`: cluster storage configuration

- Optional parameter: `type` (storage type enum).
- Returns the raw `storage.cfg` sections (Config.pm L26-41, L122-172). Each item has:
  - `storage` and `type`
  - `digest`, the SHA1 of the whole file, identical on every item
  - `content` as a comma string (`none` if empty)
  - `nodes` as a comma string, only if restricted
  - every other configured key as stored: `path`, `server`, `export`, `datastore`, `username`, `fingerprint`, `namespace`, `pool`, `vgname`, `thinpool`, `sparse`, `disable`, `shared`, `prune-backups` (a property **string**, e.g. `"keep-all=1"`), `mkdir`, `is_mountpoint`, `nodes`, and so on.
- Passwords and encryption keys live in `/etc/pve/priv/storage/<id>.pw` / `.enc`, not in storage.cfg, so they are not returned (PBSPlugin.pm L90-130).
- **`shared` is injected as 1** for the shared types listed in §1a. For other types it is present only if configured.
- `local` is always present: it is auto-created as `dir` `/var/lib/vz` if missing (Plugin.pm L571-604).
- Keys that are not configured are absent. The `disable` flag is either absent or 1.

```json
{"data":[
 {"storage":"local","type":"dir","path":"/var/lib/vz","content":"iso,vztmpl,backup","prune-backups":"keep-all=1","digest":"5c1f0e..."},
 {"storage":"local-zfs","type":"zfspool","pool":"rpool/data","sparse":1,"content":"images,rootdir","digest":"5c1f0e..."},
 {"storage":"pbs-main","type":"pbs","server":"192.168.1.20","datastore":"main","username":"pve1@pbs!pve",
  "fingerprint":"aa:bb:...:ff","content":"backup","prune-backups":"keep-all=1","shared":1,"digest":"5c1f0e..."},
 {"storage":"old-usb","type":"dir","path":"/mnt/usb","content":"backup","disable":1,"is_mountpoint":"1","digest":"5c1f0e..."}
]}
```
(Scalar typing such as `"sparse":1` vs `"1"` follows SectionConfig parsing; treat it as loose.)

---

## 2. Backups on a storage

### 2a. `GET /nodes/{node}/storage/{storage}/content?content=backup`

- Parameters: `content` (one type, e.g. `backup`) and `vmid` (filter).
- If the storage config does not list the requested content type, the result is `[]` (`volume_list`, Storage.pm L1304-1322).
- Results are sorted by `lc(volid)` ascending.
- `size`, `used` and `vmid` are `int()`-ed (Content.pm L177-179).
- **Per-item permission filter**: see §0. A PVEAuditor token gets `[]`.

Schema fields (Content.pm L64-153):

| Field | Type | Notes |
|---|---|---|
| `volid` | string | Volume id |
| `vmid` | integer, optional | Owning guest |
| `parent` | string, optional | Linked clones only. **Never set for backups** |
| `format` | string | See below |
| `size` | int bytes, optional | |
| `approximate-size` | int, optional | PVE 9 only, LVM images. Never set for backups |
| `used` | int, optional | Never set for backups |
| `ctime` | epoch, optional | |
| `notes` | string, optional | **First line only** |
| `encrypted` | string, optional | PBS only: the key fingerprint, or `"1"` |
| `verification` | `{state, upid}`, optional | PBS only |
| `protected` | boolean, optional | |

Not in the schema but present in the data:
- **`content`**: always `"backup"` here.
- **`subtype`**: `"qemu"`, `"lxc"`, `"openvz"` or `"unknown"`.

**Directory-style storages** (`dir`, `nfs`, `cifs`, `cephfs`, `btrfs`). Source: Plugin.pm L1797-1868, `$get_subdir_files`:
- Matches files in the dump dir against `\.(tgz|(?:tar|vma)(?:\.(gz|lzo|zst|bz2))?)$` (Storage.pm L120; Plugin.pm L24-25).
- **`format`** is the extension **without the leading dot**: `vma.zst`, `tar.zst`, `vma.gz`, `vma.lzo`, `tar.gz`, `tar.lzo`, `tar.bz2`, `tgz`, `vma`, `tar`.
- `volid` is `"<sid>:backup/<filename>"`.
- `subtype` comes from `archive_info`: `qemu`/`lxc`/`openvz`, or `unknown` when the file name is not `vzdump-<type>-...`.
- **`ctime`** is parsed from the standard name `vzdump-<type>-<vmid>-YYYY_MM_DD-HH_MM_SS.<ext>` **as the node's local time** (`timelocal`, Storage.pm L1793-1826). For non-standard names it falls back to the file's `stat` ctime.
- `vmid` is parsed from `-<vmid>-` (3-9 digits).
- `notes` is the first line of `<file>.notes`.
- `protected: 1` is set only if `<file>.protected` exists (Storage.pm L1787-1791). The key is absent otherwise.
- `size` is the file size.
- No `encrypted` or `verification` fields.

```json
{"data":[
 {"volid":"local:backup/vzdump-lxc-101-2025_10_05-02_04_01.tar.zst","content":"backup","format":"tar.zst",
  "size":734003200,"ctime":1759629841,"subtype":"lxc","vmid":101,"notes":"pihole"},
 {"volid":"local:backup/vzdump-qemu-100-2025_10_05-02_00_03.vma.zst","content":"backup","format":"vma.zst",
  "size":2309737472,"ctime":1759629603,"subtype":"qemu","vmid":100,"notes":"homeassistant","protected":1}
]}
```
(The ctime values assume the node's timezone is UTC.)

**PBS storages** (PBSPlugin.pm L751-801). PVE calls PBS `GET /api2/json/admin/datastore/<ds>/snapshots` with a 120 s connect timeout. If PBS is unreachable, the whole call fails with HTTP 500 "error listing snapshots - ...".
- Only `vm` and `ct` snapshots with numeric IDs are listed. Host backups are skipped.
- `volid` is `"<sid>:backup/<vm|ct>/<vmid>/<ISO8601 UTC>Z"`, e.g. `pbs-main:backup/vm/100/2025-10-05T02:00:03Z` (`print_volid`, L226-232).
- `format` is **`pbs-vm`** or **`pbs-ct`**.
- `subtype` is `qemu` or `lxc`.
- `ctime` is the PBS `backup-time` (epoch, UTC).
- `vmid` is an int.
- `size` is the PBS `size`, "sum of all archive sizes": logical, not deduplicated. It **defaults to 1** if PBS omits it.
- `notes` is the PBS `comment`, which is the first line of the notes.
- `protected: 1` only if set.
- `verification` is passed through from PBS as `{"state": "ok"|"failed", "upid": "<PBS UPID>"}`. It is absent if the snapshot was never verified (pbs-api-types datastore.rs L453-481, `VerifyState` lowercase).
- `encrypted` is the key fingerprint as a colon-separated hex string of 32 bytes (PBS crypto.rs L60-80), or `"1"` if the files are encrypted but no fingerprint is known. Absent if not encrypted.
- A PBS UPID has an extra `task_id` field, which the widget-toolkit regex accepts (Utils.js L965-987):
  `UPID:node:pid:pstart:task_id:starttime:type:id:user:`.

```json
{"data":[
 {"volid":"pbs-main:backup/ct/101/2025-10-05T02:04:01Z","content":"backup","format":"pbs-ct","size":1567285248,
  "ctime":1759629841,"vmid":101,"subtype":"lxc","notes":"pihole",
  "verification":{"state":"ok","upid":"UPID:pbs:000004D2:00012F3A:0000001A:68E32A70:verificationjob:main\\x3av\\x2d3f2a1b9c\\x2d1e2d:root@pam:"}},
 {"volid":"pbs-main:backup/vm/100/2025-10-05T02:00:03Z","content":"backup","format":"pbs-vm","size":34359738368,
  "ctime":1759629603,"vmid":100,"subtype":"qemu","notes":"homeassistant","protected":1,
  "encrypted":"3f:9a:6c:1d:5b:e0:4a:7f:8c:21:d0:e9:b4:7a:5c:3e:9f:0d:1b:2a:6c:7e:8f:9a:0b:1c:2d:3e:4f:5a:6b:7c"}
]}
```
(The PBS UPID text inside `verification` is illustrative. Its exact `type`/`id` is UNVERIFIED.)

The GUI shows `verification.state === 'ok'` as OK, and anything else as "Failed". It flags verifications older than 30 days (pve-manager `www/manager6/Utils.js` L320-340).

### 2b. Read-only backup inventory: `GET /nodes/{node}/storage/{storage}/prunebackups` (dry run)

- Parameters:
  - `prune-backups`: property string. **Pass `keep-all=1`**, otherwise the call fails with "no prune-backups options configured" when the storage has no retention setting.
  - `type`: `qemu` or `lxc`.
  - `vmid`.
- Returns `[{volid, ctime, type, vmid?, mark}]` (PruneBackups.pm L67-99).
  - `mark` is one of `keep`, `remove`, `protected` (protected backups), or `renamed` (non-standard file name).
  - With `keep-all=1`, every standard backup is `keep`.
- **Dir storages** (Plugin.pm `prune_backups`):
  - Uses the same file listing as §2a.
  - `type` is `qemu`/`lxc`/`openvz`/`unknown`.
  - `ctime` comes from the file name.
  - `vmid` is an int.
- **PBS storages** (PBSPlugin.pm `prune_backups`):
  - Lists the backup groups, then runs `proxmox-backup-client prune <group> --dry-run` once per group. Slower: one client process per guest.
  - `vmid` is taken from PBS JSON `backup-id`, so it is probably a JSON **string** such as `"100"` (UNVERIFIED runtime typing; coerce it).
- Identical in PVE 8 and 9 (files diffed).

```json
{"data":[
 {"volid":"local:backup/vzdump-qemu-100-2025_10_05-02_00_03.vma.zst","ctime":1759629603,"type":"qemu","vmid":100,"mark":"protected"},
 {"volid":"local:backup/vzdump-qemu-100-2025_10_06-02_00_03.vma.zst","ctime":1759716003,"type":"qemu","vmid":100,"mark":"keep"}
]}
```

---

## 3. `GET /nodes/{node}/disks/list`

Parameters (Disks.pm L91-114):

| Parameter | Type | Meaning |
|---|---|---|
| `include-partitions` | bool, default 0 | Also list partitions |
| `skipsmart` | bool, default 0 | Skip smartctl. Then every disk has `health` `UNKNOWN` and `wearout` `"N/A"` |
| `type` | enum | **`unused`** or **`journal_disks`**. This is a usage filter, **not** a disk-type filter |

Notes:
- Results are sorted by kernel name (`sda`, `sdb`, ..., `nvme0n1`).
- The call runs smartctl on each disk. PVE 9 sets a 10 s timeout per disk (Diskmanage.pm L105); PVE 8 has no timeout. It can be slow, so poll it rarely or use `skipsmart=1`.
- Only `sd*`, `hd*`, `vd*`, `xvd*`, `nvme<N>n<M>` and `cciss!c<N>d<M>` devices are listed. iSCSI disks and CD-ROMs are excluded (L558-576, L360-361).

Disk entry, built in `get_disks` (Diskmanage.pm L517-768) with `get_udev_info` (L343-390) and `get_sysdir_info` (L402-418):

| Field | Type | Meaning / source |
|---|---|---|
| `devpath` | string | udev `DEVNAME`, e.g. `/dev/sda`, `/dev/nvme0n1`, `/dev/cciss/c0d0` |
| `size` | int **bytes** | `/sys/block/X/size × 512` |
| `vendor` | string | sysfs `device/vendor`, or `"unknown"`. SATA disks typically report `"ATA"`. NVMe has no such file, so it is `"unknown"` (test fixture nvme_smart) |
| `model` | string | udev `ID_MODEL` (SATA models usually have `_` instead of spaces), falling back to sysfs model or `"unknown"` |
| `serial` | string | udev `ID_SERIAL_SHORT`, or `"unknown"` |
| `wwn` | string | udev `ID_WWN` (e.g. `0x5002538f4123abcd`), or `"unknown"` |
| `type` | string | `ssd`, `nvme`, `hdd`, `usb`, `unknown`. Partitions are `partition`. See the rules below |
| `rpm` | int | `0` for ssd/nvme/usb; the udev `ID_ATA_ROTATION_RATE_RPM` value for hdd; **`-1`** for `unknown` |
| `gpt` | 0/1 | Has a GPT partition table |
| `health` | string | See §3.2 |
| `wearout` | **number, or the string `"N/A"`** | See §3.1 |
| `used` | string, **absent if unused** | See §3.3 |
| `mounted` | 1, **absent if not mounted** | Only when the whole-disk devpath itself is in /proc/mounts. The schema lists it, but the code only ever sets it to 1 |
| `by_id_link` | string, optional | First `/dev/disk/by-id/(ata|scsi|nvme)…` link, excluding `nvme-eui.*` |
| `osdid` | int | Ceph OSD id, or **`-1`** |
| `osdid-list` | array or **null** | Ceph; `null` if none |
| `bluestore`, `osdencrypted`, `journals`, `db`, `wal` | int | Ceph only |
| `parent` | string | Partitions only: devpath of the parent disk |

**`type` rules** (L581-594), based on `/sys/block/X/queue/rotational`:
- `0` → `ssd`, or `nvme` if the name matches `nvme\d+n\d+`. `rpm` is set to 0.
- `1` with a udev ATA rotation rate → `hdd`.
- `1` without a rate but with `ID_BUS=usb` → `usb`, `rpm` 0.
- Otherwise → **`unknown`**, `rpm` -1. This includes **SAS HDDs**, virtio disks and HW-RAID volumes (test fixtures sas and cciss expect `type:"unknown"`, `rpm:-1`).

#### 3.1 `wearout`: meaning verified from source

- It is **percent of life REMAINING**: 100 = new, 0 = worn out. It is **not** percent used.
  - NVMe and SAS: `wearout = 100 - <Percentage Used>`, parsed from the smartctl text `Percentage Used: N%` or `Percentage used endurance indicator: N%`. Decimals are allowed (Diskmanage.pm L152-157).
  - SATA SSD: `wearout` = the **normalized VALUE column** (not RAW) of the first matching SMART attribute (`get_wear_leveling_info`, L420-459).
- Attribute names are tried **in this priority order**, each as a regex match on the attribute name: `Media_Wearout_Indicator` (233), `SSD_Life_Left` (231), `Wear_Leveling_Count` (177), `Perc_Write/Erase_Ct_BC`, `Perc_Rated_Life_Remain`, `Remaining_Lifetime_Perc`, `Percent_Lifetime_Remain` (202 on Crucial), `Lifetime_Left`, `PCT_Life_Remaining`, `Lifetime_Remaining`, `Percent_Life_Remaining`, `Percent_Lifetime_Used`, `Perc_Rated_Life_Used`.
  - For the last two "…_Used" names PVE still uses the normalized value. Whether that equals "remaining" depends on the vendor (UNVERIFIED per drive).
- **Only computed for `type` `ssd` or `nvme`** (L596-605). For `hdd`, `usb`, `unknown`, for failed SMART reads, for `skipsmart=1`, and for SSDs with no matching attribute, it is the **string `"N/A"`**.
- The PVE web UI shows `100 - value` + `%` as "Wearout", i.e. percent *used* (proxmox-widget-toolkit DiskList.js L365-375; the same in stable-bookworm). For example, API `wearout: 97` is shown as "3%".
- Test fixtures confirm this:
  - ssd_smart: Samsung `Wear_Leveling_Count` 99 → `wearout` 99; Kingston `SSD_Life_Left` 91 → 91.
  - nvme_smart: `Percentage Used: 31%` → `wearout` 69.
- Edge cases:
  - NVMe `Percentage Used` can go above 100%, so **`wearout` can be negative**.
  - SMART normalized values range 0-253.
  - Clamp the value to 0..100 for display.
- JSON type: the code produces numbers (`$4 + 0`, `100 - $1`). Accept numeric strings too: the test fixtures write `"100"`.

#### 3.2 `health`

- Default `"UNKNOWN"` (L596). It stays UNKNOWN when smartctl fails (exit-code bits 0 or 1), when `skipsmart=1`, or when nothing matched.
- Otherwise it is the text after `Health Status: ` or `self-assessment test result: ` (L142-143). In practice:
  - ATA and NVMe: `"PASSED"` or **`"FAILED!"`** (with the exclamation mark). ATA can also produce **`"UNKNOWN!"`** (smartmontools ataprint.cpp L4060-4135, nvmeprint.cpp L448-451).
  - SAS/SCSI: `"OK"`, or `"<IE string> [asc=5d, ascq=0]"` on failure (scsiprint.cpp L385-403).
  - `"SMART Disabled"` (Diskmanage L158-159).
- smartctl exit-code bit 3 ("DISK FAILING") is **ignored**, so a failing disk still reports its `FAILED!` text (L166-169).
- Recommended classification: `PASSED`/`OK` → good; `UNKNOWN`/`SMART Disabled` → unknown; anything else → bad.
- HDD, USB and unknown disks are queried with `smartctl -H` only (health only). SSD and NVMe use `-H -A -f brief`.

#### 3.3 `used` values (`$determine_usage`, L641-665, L734-749)

Checked in this order:
- `LVM` (a PV, or LVM partition type GUID)
- `ZFS` (a vdev in `zpool list -HPLv`, or ZFS partition GUIDs)
- `BIOS boot`, `EFI`, `ZFS reserved` (by GPT partition type)
- the lsblk **fstype** verbatim, e.g. `ext4`, `xfs`, `vfat`, `swap`, `zfs_member`, `LVM2_member`, `linux_raid_member`, `ceph_bluestore`
- `mounted`
- partitions only: `Device Mapper` (has holders)

Whole-disk rules:
- Without `include-partitions`, a whole disk that matches none of the above takes the **`used` value of its first partition, sorted by name**. **A typical PVE boot disk therefore shows `"BIOS boot"`**, not "ZFS" or "LVM", because partition 1 is the BIOS boot partition.
- If that is still undefined, it becomes `partitions` if partitions exist, then `Device Mapper` if it has holders.
- With `include-partitions=1`, any disk that has partitions shows `"partitions"`.
- Unused disks have **no `used` key**. In contrast, partition entries always carry a `used` key, which may be `null`.

Partition entries (only with `include-partitions=1`) carry only: `devpath`, `parent`, `type:"partition"`, `size`, `gpt`, `used` (may be `null`), `mounted?`, `osdid` (-1), `osdid-list` (null), and Ceph flags. They have no health, wearout, model or serial (L686-731).

PVE 8 vs 9: identical apart from the SMART timeout and a Ceph LV-tag guard (diff: 12 lines).

```json
{"data":[
 {"devpath":"/dev/nvme0n1","size":1000204886016,"vendor":"unknown","model":"Samsung SSD 980 PRO 1TB",
  "serial":"S5GXNX0T123456A","wwn":"unknown","type":"nvme","rpm":0,"gpt":1,"health":"PASSED","wearout":97,
  "used":"BIOS boot","by_id_link":"/dev/disk/by-id/nvme-Samsung_SSD_980_PRO_1TB_S5GXNX0T123456A",
  "osdid":-1,"osdid-list":null},
 {"devpath":"/dev/sda","size":1000204886016,"vendor":"ATA","model":"Samsung_SSD_870_EVO_1TB",
  "serial":"S6PUNX0T123456A","wwn":"0x5002538f4123abcd","type":"ssd","rpm":0,"gpt":1,"health":"PASSED","wearout":98,
  "used":"ZFS","by_id_link":"/dev/disk/by-id/ata-Samsung_SSD_870_EVO_1TB_S6PUNX0T123456A","osdid":-1,"osdid-list":null},
 {"devpath":"/dev/sdb","size":4000787030016,"vendor":"ATA","model":"WDC_WD40EFRX-68N32N0","serial":"WD-WCC7K1234567",
  "wwn":"0x50014ee2b1234567","type":"hdd","rpm":5400,"gpt":1,"health":"PASSED","wearout":"N/A","used":"ZFS",
  "by_id_link":"/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567","osdid":-1,"osdid-list":null},
 {"devpath":"/dev/sdc","size":2000398934016,"vendor":"Seagate","model":"Expansion_HDD","serial":"NAABCDEF",
  "wwn":"unknown","type":"usb","rpm":0,"gpt":1,"health":"UNKNOWN","wearout":"N/A","used":"ext4",
  "osdid":-1,"osdid-list":null},
 {"devpath":"/dev/sdd","size":480103981056,"vendor":"ATA","model":"KINGSTON_SA400S37480G","serial":"50026B7784123456",
  "wwn":"0x50026b7784123456","type":"ssd","rpm":0,"gpt":0,"health":"PASSED","wearout":"N/A",
  "osdid":-1,"osdid-list":null}
]}
```
(The last disk is an SSD with no recognised wear attribute and no partitions: `wearout` is `"N/A"` and there is no `used` key, i.e. unused. The NVMe `wwn` format is UNVERIFIED and may be an `eui.…` string.)

---

## 4. `GET /nodes/{node}/disks/smart?disk=/dev/sda[&healthonly=1]`

- `disk` must match `^/dev/[a-zA-Z0-9\/]+$`.
- Returns `{health, type?, attributes?, text?, wearout?}` (Disks.pm L179-226; parser at Diskmanage.pm L90-174).
- `healthonly=1` returns `{health}` only.

- **`type: "ata"`**: SATA. Parsed from the `smartctl -H -A -f brief` table. There is **no `text` field** (it is deleted when the attribute table starts).
- `attributes[]` items:

  | Field | Type | Meaning |
  |---|---|---|
  | `id` | **string, space-padded to 3 characters** | e.g. `"  5"`, `" 12"`, `"177"` (`%3d` in smartctl). Trim and parse |
  | `name` | string | e.g. `Wear_Leveling_Count` |
  | `value` | number | Normalized value. Deprecated duplicate of `normalized` |
  | `normalized` | number | Normalized value |
  | `worst` | number | |
  | `threshold` | number | `---` becomes 0 |
  | `flags` | 6-char string | e.g. `"PO--CK"` |
  | `fail` | string | `"-"`, `"NOW"` or `"Past"` |
  | `raw` | **string** | e.g. `"21"`, `"35 (Min/Max 20/45)"` |

- Lines whose normalized value is `---`, or whose flag string has a 7th `+` character, fail PVE's regex and are silently dropped (regex L117-122 vs smartctl ataprint.cpp L1262-1321).
- **`type: "text"`**: NVMe and SAS. `text` holds the raw smartctl SMART-data section with the health line removed, newline-joined. **`wearout`** (number, remaining %) is included when "Percentage Used" was found.
- No `type` at all: smartctl printed no recognisable section.

Error behaviour (PVE 8 vs 9):
- **PVE 9** (libpve-storage-perl ≥ 9.0.16, changelog "api: smart: return unknown health instead of error message") wraps the call in `eval`. When smartctl fails it returns **HTTP 200 `{"health":"UNKNOWN"}`**.
- **PVE 8** propagates the error as an **HTTP 500** with the message `Error getting S.M.A.R.T. data: Exit code: N` (stable-8 Disks.pm L219).

ATA example:
```json
{"data":{"type":"ata","health":"PASSED","attributes":[
 {"id":"  5","name":"Reallocated_Sector_Ct","flags":"PO--CK","value":100,"normalized":100,"worst":100,"threshold":10,"fail":"-","raw":"0"},
 {"id":"  9","name":"Power_On_Hours","flags":"-O--CK","value":95,"normalized":95,"worst":95,"threshold":0,"fail":"-","raw":"21345"},
 {"id":"177","name":"Wear_Leveling_Count","flags":"PO--C-","value":98,"normalized":98,"worst":98,"threshold":0,"fail":"-","raw":"21"},
 {"id":"190","name":"Airflow_Temperature_Cel","flags":"-O--CK","value":69,"normalized":69,"worst":52,"threshold":0,"fail":"-","raw":"31"},
 {"id":"241","name":"Total_LBAs_Written","flags":"-O--CK","value":99,"normalized":99,"worst":99,"threshold":0,"fail":"-","raw":"48211823541"}
]}}
```
NVMe example (from pve-storage test fixture `nvme_smart/nvme0n1_smart_expected.json`):
```json
{"data":{"type":"text","health":"PASSED","wearout":69,
 "text":"\nSMART/Health Information (NVMe Log 0x02, NSID 0xffffffff)\nCritical Warning:                   0x00\nTemperature:                        32 Celsius\nAvailable Spare:                    100%\nAvailable Spare Threshold:          10%\nPercentage Used:                    31%\nData Units Read:                    1,299,288 [665 GB]\nData Units Written:                 5,592,478 [2.86 TB]\nPower Cycles:                       98\nPower On Hours:                     687\nUnsafe Shutdowns:                   21\nMedia and Data Integrity Errors:    0\nError Information Log Entries:      0\n"}}
```
(Some lines of the fixture are omitted here.) The SAS example in the fixtures has `"health":"OK"`, `"type":"text"` and `"wearout":100`, from `Percentage used endurance indicator: 0%`.

---

## 5. ZFS

### 5a. `GET /nodes/{node}/disks/zfs`: pool list

- Runs `zpool list -HpPLo name,size,alloc,free,frag,dedup,health`. Every field except `name` and `health` is converted with `+0` (ZFS.pm L21-54).
- If zfsutils is not installed → error "zfsutils-linux not installed".

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Pool name |
| `size`, `alloc`, `free` | int bytes | `-p` gives exact values |
| `frag` | int percent | `-p` prints no `%`. A `-` (not available) becomes **0** |
| `dedup` | number ratio | e.g. `1` or `1.35` |
| `health` | string | `ONLINE`, `DEGRADED`, `FAULTED`, `OFFLINE`, `UNAVAIL`, `REMOVED` or `SUSPENDED` (OpenZFS `zpool_get_state_str`) |

OpenZFS `-p` formatting verified in libzfs_pool.c L455-483.

```json
{"data":[
 {"name":"rpool","size":996432412672,"alloc":120259084288,"free":876173328384,"frag":4,"dedup":1,"health":"ONLINE"},
 {"name":"tank","size":3985729650688,"alloc":1288490188800,"free":2697239461888,"frag":11,"dedup":1,"health":"DEGRADED"}
]}
```

### 5b. `GET /nodes/{node}/disks/zfs/{name}`: pool detail

Parses `zpool status -P <name>` (ZFS.pm L129-293).

Top-level keys:
- `name` (renamed from `pool:`).
- `state`.
- `status`, `action`, `see`, `scan`: optional. They appear only when zpool prints them. Multi-line values are joined with single spaces.
- `errors`, e.g. `"No known data errors"`.
- Any other `key: value` header line zpool prints, e.g. `remove`, appears as an extra key.
- `leaf: 0`.
- `children`.

Each `children` node has:
- `name`: the vdev, section or device. Leaves are **full paths** because of `-P`, e.g. `/dev/disk/by-id/...-part3`.
- `state`: optional. Missing on section headers such as `logs`, `cache` and `spares`.
- `read`, `write`, `cksum`: numbers, optional (spares have only a state such as `AVAIL`).
- `msg`: string, always present, possibly `""`. E.g. `"too many errors"`, `"was /dev/sdc1"`.
- `leaf`: 0/1.
- `children`: present when not a leaf.

Nesting comes from indentation:
- The **first child is the pool's root vdev, which has the same name as the pool**.
- Below it are `mirror-0`/`raidz1-0`, then devices.
- `logs`, `cache`, `spares` and `special` appear as level-1 siblings of the root vdev.

```json
{"data":{"name":"tank","state":"DEGRADED",
 "status":"One or more devices could not be used because the label is missing or invalid. Sufficient replicas exist for the pool to continue functioning in a degraded state.",
 "action":"Replace the device using 'zpool replace'.","see":"https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-4J",
 "scan":"scrub repaired 0B in 03:12:44 with 0 errors on Sun Oct 12 03:36:45 2025",
 "errors":"No known data errors","leaf":0,
 "children":[{"name":"tank","state":"DEGRADED","read":0,"write":0,"cksum":0,"msg":"","leaf":0,"children":[
   {"name":"mirror-0","state":"DEGRADED","read":0,"write":0,"cksum":0,"msg":"","leaf":0,"children":[
     {"name":"/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567-part1","state":"ONLINE","read":0,"write":0,"cksum":0,"msg":"","leaf":1},
     {"name":"1234567890123456789","state":"UNAVAIL","read":0,"write":0,"cksum":0,"msg":"was /dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K7654321-part1","leaf":1}]}]}]}}
```
A healthy pool has no `status`, `action` or `see` keys. A scrub in progress shows as, e.g., `"scan":"scrub in progress since Sun Oct 12 00:24:01 2025 1.23T / 2.00T scanned at 1.2G/s, ... 40.00% done, 00:20:00 to go"`.

PVE 8 and 9 have identical ZFS.pm (diff: 0 lines). The zpool text itself can differ between OpenZFS 2.2 (PVE 8) and 2.3 (PVE 9). Parse defensively.

---

## 6. LVM and LVM-thin

**`GET /nodes/{node}/disks/lvm`** (LVM.pm L17-113, via `lvm_vgs(1)`, LVMPlugin.pm):
- Returns a tree object `{leaf:0, children:[VG...]}`.
- Each VG: `{name, size, free, lvcount, leaf:0, children:[PV...]}`. Sizes are bytes (`vgs --units b --nosuffix`). `lvcount` is not in the schema but is present.
- Each PV: `{name: "/dev/nvme0n1p3", size, free, leaf:1}`.
```json
{"data":{"leaf":0,"children":[{"name":"pve","size":999658553344,"free":16106127360,"lvcount":3,"leaf":0,
  "children":[{"name":"/dev/nvme0n1p3","size":999658553344,"free":16106127360,"leaf":1}]}]}}
```

**`GET /nodes/{node}/disks/lvmthin`** (LVMThin.pm L18-70, via `list_thinpools` + `lvm_list_volumes`):
- Returns an array of thin pools.

| Field | Type | Notes |
|---|---|---|
| `lv` | string | Thin pool name |
| `vg` | string | Volume group |
| `lv_size` | int bytes | |
| `used` | int bytes | `data_percent × lv_size / 100` |
| `metadata_size` | int bytes | |
| `metadata_used` | int bytes | `metadata_percent × metadata_size / 100` |
| `lv_state` | string | Extra, not in schema. e.g. `"a"` = active |
| `lv_type` | string | Extra. `"t"` |
| `ctime` | **string** epoch | Extra |
| `tags` | string, optional | Extra |

Identical in PVE 8 and 9.
```json
{"data":[{"lv":"data","vg":"pve","lv_size":857619677184,"used":120065754317,"metadata_size":8749318144,
  "metadata_used":227481272,"lv_state":"a","lv_type":"t","ctime":"1700000000"}]}
```

---

## 7. `GET /nodes/{node}/tasks`: task list

Parameters (Tasks.pm L50-115):

| Parameter | Type | Meaning |
|---|---|---|
| `start` | int, default 0 | Offset |
| `limit` | int, default **50** | `0` → returns `[]` but `total` is still computed |
| `userfilter` | string | Case-insensitive **substring** match on `user`. After the token split, `user` no longer contains `!token` |
| `typefilter` | string | **Exact** match on `type` |
| `vmid` | int | Exact match on `id`. **Multi-guest vzdump tasks have an empty `id`, so they never match** |
| `errors` | bool | Despite its description, this only drops `ok`. Warnings, errors and unknown are all returned. When `errors=1`, `statusfilter` is ignored |
| `source` | `archive` (default), `active`, `all` | See below |
| `since`, `until` | epoch | Compared with `starttime` |
| `statusfilter` | comma list | Of `ok`, `warning`, `error`, `unknown`, case-insensitive (JSONSchema.pm L963-973) |

Response: `{"data":[...], "total": N}`. `total` = **all matching tasks**, not just the returned page (Tasks.pm L202-255). It is omitted when 0.

Item fields: these come from `upid_decode` + the index line, after `$convert_token_task`:

| Field | Type | Meaning |
|---|---|---|
| `upid` | string | |
| `node` | string | |
| `pid` | int | Decoded from hex |
| `pstart` | int | Process start time in **clock ticks since boot**, not epoch |
| `starttime` | int epoch | |
| `type` | string | e.g. `vzdump`, `qmstart`, `vzstart`, `qmshutdown`, `aptupdate`, `imgdel`, `startall`, `zfscreate` |
| `id` | string | May be `""` |
| `user` | string | `user@realm`. **For API-token tasks the token is split off into a separate `tokenid` field** (Tasks.pm L19-25) |
| `tokenid` | string, optional | Not in schema |
| `endtime` | int epoch, optional | |
| `status` | string, optional | |
| `saved` | string `"0"` | Active-source items only. Not in schema |

`status` contents (finished tasks): the worker writes the last log line (RESTEnvironment.pm L640-666), and `PVE::UPID::read_status` parses it (UPID.pm L70-85; pve-common 8: Tools.pm `upid_read_status`):
- `TASK OK` → **`"OK"`**.
- `TASK WARNINGS: N` → **`"WARNINGS: N"`**, e.g. `"WARNINGS: 2"`. Every `log_warn` increments the count.
- `TASK ERROR: <msg>` → **`<msg>` verbatim** (newlines collapsed to spaces). E.g. **`"job errors"`** (vzdump with at least one failed guest, VZDump.pm L1491), `"command '...' failed: exit code 1"`, `"interrupted by signal"`.
- Anything else → `"unexpected status"`.
- I/O problems (rare):
  - PVE 9: `"unable to get last line from task log - ..."`.
  - PVE 8: `"unable to open file - ..."`, `"unable to extract last line"`, `"unable to read tail (got N bytes)"`.

To classify a status, use `normalize_status_type` (UPID.pm L93-106): `""`/undef → `unknown`; `OK` → `ok`; `^WARNINGS: \d+$` → `warning`; `"unexpected status"` → `unknown`; **anything else → `error`**. The GUI does the same (Utils.js L990-1005).

Running tasks:
- They are **not in the archive index**, so the default `source=archive` never returns them.
- With `source=active` or `all`, they come from `/var/log/pve/tasks/active` with **no `endtime`** and **`status: "RUNNING"`**, added by the API (Tasks.pm L228-238).
- Status filtering happens *before* that, so for filtering purposes running tasks count as `unknown` (`statusfilter=ok` hides them; `errors=1` shows them).
- Active entries also carry `saved:"0"` (INotify.pm L685-711).
- Rarely, a finished but not-yet-archived task shows up via `active` with `endtime` and `status` set.

Ordering and retention:
- Active items come first.
- Then `index` read **backwards**, newest archived first. This is roughly by end time, not start time.
- Then `index.1`.
- The index rotates at about 50 kB, roughly 1000 entries (RESTEnvironment.pm L381-384). The history is therefore about 1000-2000 tasks.

PVE 8 and 9: identical logic (diff: documentation only).

```json
{"data":[
 {"upid":"UPID:pve1:0012D687:0A1B2C3D:68E47423:vzdump::root@pam:","node":"pve1","pid":1234567,"pstart":169552957,
  "starttime":1759802403,"type":"vzdump","id":"","user":"root@pam","status":"RUNNING","saved":"0"},
 {"upid":"UPID:pve1:0010A2B1:09F3E1C2:68E322A3:vzdump::root@pam:","node":"pve1","pid":1090225,"pstart":166977986,
  "starttime":1759716003,"type":"vzdump","id":"","user":"root@pam","endtime":1759718000,"status":"job errors"},
 {"upid":"UPID:pve1:000F4240:09A1B2C3:68E322AC:qmstart:100:root@pam!dash:","node":"pve1","pid":1000000,"pstart":161592003,
  "starttime":1759716012,"type":"qmstart","id":"100","user":"root@pam","tokenid":"dash","endtime":1759716014,"status":"OK"},
 {"upid":"UPID:pve1:0012D600:09A00000:68E1D123:vzdump:105:root@pam:","node":"pve1","pid":1234432,"pstart":161480704,
  "starttime":1759629603,"type":"vzdump","id":"105","user":"root@pam","endtime":1759629975,"status":"WARNINGS: 1"}
],"total":4}
```
(The first item appears only with `source=all`. Real responses list 50 items by default.)

---

## 8. Task status and task log

### `GET /nodes/{node}/tasks/{upid}/status` (Tasks.pm L453-546)

- Returns the decoded UPID fields plus `upid`, `status` and `exitstatus`.
- **`status` is `"running"` or `"stopped"`** (lowercase). It is computed by comparing `/proc/<pid>` start time with `pstart`.
- **`exitstatus`** is present only when stopped. It uses the same strings as the task-list `status`: `"OK"`, `"WARNINGS: N"`, error text, or `"unexpected status"`.
- Token tasks also get `tokenid` split out of `user`.
- A malformed UPID → 400 "unable to parse worker upid". A missing log file → 400 "no such task".

```json
{"data":{"upid":"UPID:pve1:0010A2B1:09F3E1C2:68E322A3:vzdump::root@pam:","node":"pve1","pid":1090225,
 "pstart":166977986,"starttime":1759716003,"type":"vzdump","id":"","user":"root@pam","status":"stopped","exitstatus":"job errors"}}
```

### `GET /nodes/{node}/tasks/{upid}/log` (Tasks.pm L334-449; pve-common Tools.pm `dump_logfile_by_filehandle` L751-799)

- Parameters:
  - `start`: 0-based line offset, default 0.
  - `limit`: default 50. **`limit=0` means "until end of file"**.
  - `download=1`: streams the file (gzip if over 1 KiB). It cannot be combined with `start`/`limit`.
- Returns `[{n, t}]`.
  - `n` is the **1-based** line number, so the first returned `n` equals `start+1`.
  - `t` is the line text without the newline.
- **`total` is the line count of the whole file**, so you can tail it:
  1. Request `?start=0&limit=1` to learn `total`.
  2. Request `?start=max(0,total-50)&limit=50`.
- An empty log returns `[{"n":1,"t":"no content"}]` with total 1. An unreadable file returns `[{"n":1,"t":"unable to open file - ..."}]`.
- A running task's log can be read while it grows.
- The last line of a finished task is `TASK OK`, `TASK WARNINGS: N` or `TASK ERROR: ...`.

```json
{"data":[{"n":1,"t":"INFO: starting new backup job: vzdump --all 1 --mode snapshot --storage pbs-main --node pve1 --compress zstd"},
 {"n":2,"t":"INFO: Starting Backup of VM 100 (qemu)"}],"total":57}
```

---

## 9. UPID format and parsing

Encoding is `sprintf("UPID:%s:%08X:%08X:%08X:%s:%s:%s:", node, pid, pstart, starttime, type, id, user)` (pve-common UPID.pm L18-30; PVE 8: Tools.pm `upid_encode`). The parse regex, identical in PVE 8 and 9 (UPID.pm L35-36):
```
^UPID:([a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/]+):([^:\s/]*):([^:\s/]+):$
```

Rules:
- Exactly 8 colon-separated fields plus a **trailing colon**.
- `node` is a hostname.
- `pid` is 8 uppercase hex digits.
- `pstart` is **8 or 9** hex digits (it exceeds 32 bits after about 497 days of uptime). It is in clock ticks.
- `starttime` is 8 hex digits, epoch seconds.
- `type` is non-empty.
- **`id` may be empty** (`::`).
- `user` is `user@realm` or `user@realm!tokenname`.
- No field may contain `:`, `/` or whitespace.

Other details:
- The log file lives at `/var/log/pve/tasks/<last hex char of starttime>/<UPID>`.
- A PBS UPID has a 9th field (`task_id`) between `pstart` and `starttime`, and its `id` may be systemd-escaped (`\x3a`). The widget-toolkit regex handles both forms (Utils.js L965-987).

TypeScript:
```ts
const UPID_RE = /^UPID:([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?):([0-9A-Fa-f]{8}):([0-9A-Fa-f]{8,9}):([0-9A-Fa-f]{8}):([^:\s/]+):([^:\s/]*):([^:\s/]+):$/;
// m[1]=node m[2]=pid m[3]=pstart m[4]=starttime m[5]=type m[6]=id m[7]=user(@realm[!token])
```

---

## 10. Backup jobs

### 10a. `GET /cluster/backup` (pve-manager Backup.pm L182-242; PVE 8: stable-8 Backup.pm L130-183)

- Takes no parameters.
- Returns:
  - any legacy `vzdump.cron` jobs, with `schedule` synthesised from `dow` + `starttime`;
  - plus every `vzdump`-type section from `/etc/pve/jobs.cfg`, ordered by position in that file.
- Each job is the parsed config section with these changes:
  - **`type: "vzdump"`** is present, injected by SectionConfig.
  - `id` is forced to the section id.
  - `enabled` defaults to **1** when not in the config (Job/Registry.pm L76).
  - `comment` is decoded.
  - `prune-backups`, `fleecing` and `performance` are returned as **objects**, not property strings (JobBase.pm L40-48). Their inner values are mostly strings, e.g. `"keep-daily":"7"`; boolean keys are parsed to 0/1.

**`next-run`: YES, it is included, in both PVE 8 and 9.**
- Integer epoch, computed as `Proxmox::RS::CalendarEvent->new($schedule)->compute_next_event(time())` (Backup.pm L224-231; stable-8 L171).
- It is computed **even for disabled jobs**: the code does not check `enabled`.
- It is omitted if there is no schedule or no next event.
- In PVE 9.x, `next-run` and the other fields were added to the documented return schema (commit 0e85aec, 2026-03). Behaviour did not change.
- **There is no last-run or last-status field.**

Fields (from `PVE::VZDump::Common` `$confdesc`, guest-common master Common.pm L159-389, plus job keys):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Treat as opaque |
| `type` | `"vzdump"` | |
| `schedule` | string | systemd calendar subset, e.g. `"02:00"`, `"sat 03:30"`, `"*/6:00"` |
| `enabled` | 0/1 | |
| `next-run` | epoch | |
| `comment` | string | |
| `repeat-missed` | 0/1 | |
| `storage` | string | |
| `mode` | string | `snapshot` (default), `suspend`, `stop` |
| `compress` | string | `0`, `1`, `gzip`, `lzo`, `zstd` |
| `all` | 0/1 | |
| `vmid` | **string** | Comma list, e.g. `"100,101"` |
| `exclude` | string | Comma list; used with `all` |
| `pool` | string | |
| `node` | string | Job runs only on this node |
| `notes-template` | string | e.g. `"{{guestname}}"` |
| `protected` | 0/1 | |
| `mailto` | string | Deprecated |
| `mailnotification` | string | `always`/`failure`. Deprecated |
| `notification-mode` | string | `auto`, `legacy-sendmail`, `notification-system` |
| `prune-backups` | object | e.g. `{"keep-last":"3"}` or `{"keep-all":1}` |
| `fleecing` | object | `{enabled, storage?}` |
| `performance` | object | `{max-workers?, pbs-entries-max?}` |
| `bwlimit` | int KiB/s | |
| `ionice` | int 0-8 | |
| `zstd`, `pigz` | int | Thread counts |
| `lockwait`, `stopwait` | int minutes | |
| `stdexcludes`, `remove`, `quiet`, `stop` | 0/1 | |
| `exclude-path` | array | |
| `script`, `tmpdir`, `dumpdir` | string | |
| `pbs-change-detection-mode` | string | `legacy`, `data`, `metadata` |

Version-specific fields:
- **PVE 8 only**: `notification-policy`, `notification-target` (removed in guest-common 6.0.1) and `maxfiles` (dropped in later 6.0.x).
- Legacy `vzdump.cron` jobs may also carry `dow`/`starttime` on PVE 8. PVE 9 deletes them from the output.

```json
{"data":[
 {"id":"backup-5f2c1a3e-7d1b","type":"vzdump","schedule":"02:00","enabled":1,"next-run":1759802400,
  "storage":"pbs-main","mode":"snapshot","compress":"zstd","all":1,"exclude":"999","node":"pve1",
  "notes-template":"{{guestname}}","notification-mode":"auto","fleecing":{"enabled":0},
  "prune-backups":{"keep-daily":"7","keep-weekly":"4"},"comment":"nightly to PBS"},
 {"id":"backup-9a8b7c6d-1234","type":"vzdump","schedule":"sun 04:15","enabled":0,"next-run":1760242500,
  "storage":"local","mode":"stop","compress":"zstd","vmid":"100,101","protected":1}
]}
```
(The ID strings are illustrative. The server generates IDs for GUI-created jobs, and their exact format is UNVERIFIED.)

### 10b. `GET /cluster/backup-info/not-backed-up` (pve-manager Cluster/BackupInfo.pm L20-141; identical in PVE 8)

- Returns `[{vmid:int, type:"qemu"|"lxc", name?:string}]`, unordered.
  - `name` is the VM `name`, or the container `hostname`.
- Lists guests that **no vzdump job (legacy or jobs.cfg) selects**. A guest counts as selected through:
  - `vmid` lists,
  - `all` minus `exclude`,
  - `pool` membership,
  - each restricted by the job's `node`.
- **Disabled jobs still count as covering a guest**: `enabled` is not checked (`get_included_guests`, VZDump.pm).
- Templates are guests like any other.
- Filtered to VMIDs where the caller has `VM.Audit`.

```json
{"data":[{"vmid":104,"type":"lxc","name":"test-ct"},{"vmid":200,"type":"qemu","name":"win11-lab"}]}
```

---

## 11. vzdump tasks and log lines

- **Task type `vzdump`.** `id` is the **VMID when exactly one local guest is backed up**, otherwise **`""`** (API2/VZDump.pm L175-178; RESTEnvironment.pm L524).
  - A scheduled multi-guest job therefore produces one task per node per run, `UPID:pve1:…:vzdump::root@pam:`.
- Scheduled jobs run as **`root@pam`**, via pvescheduler → `PVE::Jobs::VZDump->run` → `PVE::API2::VZDump->vzdump`.
- Each node runs its own task for its local guests, and logs `INFO: skip external VMs: 102, 103` for guests on other nodes.
- Task status:
  - `OK` if all guests succeeded.
  - `WARNINGS: N` if any `WARN:` lines were logged.
  - **`job errors`** if at least one guest failed; the other guests continue.
  - Some other error text if the whole job aborted, e.g. lock timeout or storage error.

Task log lines are the worker's STDERR. They have **no timestamp prefix**. The prefixes are `INFO: `, `WARN: ` and `ERROR: ` (guest-common VZDump/Plugin.pm L16-45). The separate per-guest `.log` file next to a dir-storage archive *does* have `YYYY-MM-DD HH:MM:SS INFO: ...` prefixes.

Lines worth parsing, with exact format strings from VZDump.pm:
```
INFO: starting new backup job: <cmdline>                                  (L1396)
INFO: skip external VMs: <vmid>, <vmid>                                   (L1400)
INFO: Starting Backup of VM <vmid> (<qemu|lxc>)                           (L1060)
INFO: Backup started at YYYY-MM-DD HH:MM:SS                               (L1061, node local time)
INFO: backup mode: <snapshot|suspend|stop>                                (L1095)
INFO: creating <vzdump|Proxmox Backup Server> archive '<target>'          (L1199-1203)
INFO: archive file size: <human size>                                     (L1215, non-PBS only)
ERROR: Backup of VM <vmid> failed - <error text>                          (L1340)
INFO: Failed at YYYY-MM-DD HH:MM:SS                                       (L1341)
INFO: Finished Backup of VM <vmid> (HH:MM:SS)                             (L1357, duration)
INFO: Backup finished at YYYY-MM-DD HH:MM:SS                              (L1358)
ERROR: Backup job failed - <err>                                          (L1460)
INFO: Backup job finished with errors | INFO: Backup job finished successfully   (L1463/L1465)
TASK OK | TASK WARNINGS: N | TASK ERROR: job errors                       (written by RESTEnvironment)
```
QEMU-specific lines (qemu-server VZDump/QemuServer.pm), for example:
- `INFO: VM Name: <name>`
- `INFO: include disk 'scsi0' '<volid>' <size>`
- the progress line `INFO:  42% (13.4 GiB of 32.0 GiB) in 30s, read: …, write: …`
- `INFO: backup is sparse: …`
- `INFO: transferred <size> in <N> seconds (<rate>)`
- for PBS: `INFO: backup was done incrementally, reused …`

To get per-guest results from a multi-guest task:
1. Match `^INFO: Starting Backup of VM (\d+) \((qemu|lxc)\)$`.
2. Then match either `^INFO: Finished Backup of VM (\d+) \((\d\d:\d\d:\d\d)\)$` or `^ERROR: Backup of VM (\d+) failed - (.*)$`.

---

## 12. Mock-server checklist (behaviours that are easy to get wrong)

1. Booleans are `0`/`1`. `total` is a top-level sibling of `data` and is omitted when 0.
2. `/nodes/{node}/storage`: inactive and disabled storages have `total/used/avail = 0` and no `used_fraction`. Item order is random.
3. Disk `wearout` is a number meaning **remaining %**, or the string `"N/A"`. HDD, USB and unknown disks are always `"N/A"`. SAS HDDs have `type:"unknown"`, `rpm:-1`.
4. The SMART attribute `id` is a space-padded string. `raw` is a string. NVMe and SAS return `type:"text"` + `text` (+ `wearout`).
5. SMART failure: PVE 9 returns 200 `{"health":"UNKNOWN"}`; PVE 8 returns HTTP 500.
6. Boot disks report `used:"BIOS boot"`. Unused disks have no `used` key.
7. ZFS detail: the root `children[0]` repeats the pool name. Leaves use full `/dev/disk/by-id/...` paths. `msg` is always present.
8. Task list: running tasks only appear with `source=active|all`, with `status:"RUNNING"` and no `endtime`. Token tasks have `user` + `tokenid`. A failed vzdump is `"job errors"`.
9. Task status endpoint: `status` is `running|stopped`, with `exitstatus` only when stopped.
10. The backup content listing returns `[]` for an auditor-only token. The prunebackups dry-run returns `{volid, ctime, type, vmid, mark}`.
11. `/cluster/backup` includes `type:"vzdump"` and `next-run` (also for disabled jobs). `prune-backups` is an object with string values.

---

## Sources

All files were fetched 2026-10-10. "master" means PVE 9 and "stable-8"/"stable-bookworm" means PVE 8.

pve-storage (libpve-storage-perl):
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/Diskmanage.pm : get_smart_data L90-174; get_udev_info L343-390; get_sysdir_info L402-418; get_wear_leveling_info L420-459; get_disks L517-768
- https://raw.githubusercontent.com/proxmox/pve-storage/stable-8/src/PVE/Diskmanage.pm (diff vs master: timeout, error handling, Ceph tag guard only)
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Disks.pm : list L81-177; smart L179-226. stable-8 version: smart without eval at L219
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Disks/ZFS.pm L21-293 (identical on stable-8)
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Disks/LVM.pm L17-113; https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Disks/LVMThin.pm L18-70
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/Storage/LVMPlugin.pm (`lvm_vgs`, `lvm_list_volumes`); https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/Storage/LvmThinPlugin.pm (`list_thinpools`)
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Storage/Status.pm : index L67-273; status L326-409 (stable-8 diffed)
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Storage/Config.pm : api_storage_config L26-41; index L122-172
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Storage/Content.pm : index L22-185; delete permissions L456-506
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Storage/PruneBackups.pm L15-115 (identical on stable-8)
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/Storage.pm : BACKUP_EXT_RE_2 L120; check_volume_access L619-662; volume_list L1304-1322; storage_info L1447-1531; protection_file_path L1787; archive_info L1793-1826; prune_backups
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/Storage/Plugin.pm : SHARED_STORAGE L44-46; parse_config L571-620; get_subdir_files L1797-1868; list_volumes L1872-1922; prune_backups
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/Storage/PBSPlugin.pm : print_volid L226-232; parse_volname L607-630; list_volumes L751-801; prune_backups
- https://raw.githubusercontent.com/proxmox/pve-storage/master/debian/changelog (9.0.16: "api: smart: return unknown health instead of error message"; "fix #6224 … timeout")
- Test fixtures: https://raw.githubusercontent.com/proxmox/pve-storage/master/src/test/disk_tests/{ssd_smart,hdd_smart,nvme_smart,sas,sas_ssd,usages,cciss}/disklist_expected.json and *_smart_expected.json

pve-manager:
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Tasks.pm : node_tasks L39-259; log L334-449; status L453-546 (stable-8 diff: documentation only)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Backup.pm : return schema L123-180; index L182-242 (next-run L224-231). https://raw.githubusercontent.com/proxmox/pve-manager/stable-8/PVE/API2/Backup.pm : next-run L171
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Cluster/BackupInfo.pm L20-141 (identical on stable-8)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/VZDump.pm L100-178
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/VZDump.pm : exec_backup_task L1060-1358; exec_backup L1390-1495; get_included_guests
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/Jobs/VZDump.pm
- https://raw.githubusercontent.com/proxmox/pve-manager/master/www/manager6/Utils.js (verification renderer approximately L320-340; task description table L2164-2268)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/www/manager6/dc/Backup.js (Next Run column L913-918)
- GitHub commit search: proxmox/pve-manager 0e85aecd ("api: backup: add return schema for backup jobs") and 75424de1 ("drop starttime and dow from return schema")

pve-common:
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/UPID.pm L18-106; https://raw.githubusercontent.com/proxmox/pve-common/stable-bookworm/src/PVE/Tools.pm (`upid_encode`/`upid_decode`/`upid_read_status`/`upid_normalize_status_type`, PVE 8)
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/Tools.pm : dump_logfile_by_filehandle L751-799
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/RESTEnvironment.pm : active_workers L296-404; fork_worker L521-666; warn L761-770
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/INotify.pm : read_active_workers L685-711
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/JSONSchema.pm : pve-task-status-type L963-973; parse_property_string
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/Job/Registry.pm : parse_config L62-80
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/RESTHandler.pm : hash_to_array

Other Proxmox repositories:
- pve-guest-common: https://raw.githubusercontent.com/proxmox/pve-guest-common/master/src/PVE/VZDump/Common.pm L33-37, L159-389; https://raw.githubusercontent.com/proxmox/pve-guest-common/master/src/PVE/VZDump/JobBase.pm L40-58; https://raw.githubusercontent.com/proxmox/pve-guest-common/master/src/PVE/VZDump/Plugin.pm L16-45; https://raw.githubusercontent.com/proxmox/pve-guest-common/master/debian/changelog (6.0.1 removed notification-policy/target)
- pve-access-control: https://raw.githubusercontent.com/proxmox/pve-access-control/master/src/PVE/AccessControl.pm L1055-1203 (privilege groups, PVEAuditor)
- pve-http-server: https://raw.githubusercontent.com/proxmox/pve-http-server/master/src/PVE/APIServer/Formatter/Standard.pm L14-52
- proxmox-widget-toolkit: https://raw.githubusercontent.com/proxmox/proxmox-widget-toolkit/master/src/panel/DiskList.js L365-375 (and stable-bookworm L372); https://raw.githubusercontent.com/proxmox/proxmox-widget-toolkit/master/src/window/DiskSmart.js L151-182; https://raw.githubusercontent.com/proxmox/proxmox-widget-toolkit/master/src/Utils.js L965-1020
- qemu-server: https://raw.githubusercontent.com/proxmox/qemu-server/master/src/PVE/VZDump/QemuServer.pm (log lines)
- proxmox-backup: https://raw.githubusercontent.com/proxmox/proxmox-backup/master/pbs-api-types/src/datastore.rs L453-481, L1159-1182; https://raw.githubusercontent.com/proxmox/proxmox-backup/master/pbs-api-types/src/crypto.rs L60-80

External projects:
- smartmontools: https://raw.githubusercontent.com/smartmontools/smartmontools/master/smartmontools/ataprint.cpp L1255-1321, L3951, L4060-4135; https://raw.githubusercontent.com/smartmontools/smartmontools/master/smartmontools/nvmeprint.cpp L448-451, L509; https://raw.githubusercontent.com/smartmontools/smartmontools/master/smartmontools/scsiprint.cpp L385-403, L1760-1770
- OpenZFS: https://raw.githubusercontent.com/openzfs/zfs/master/lib/libzfs/libzfs_pool.c L455-487

Cross-check: the generated TS model `ref/proxmox-api/package/src/model.ts` (proxmox-api 1.1.1). Its interfaces `nodesDisksListList`, `nodesStorageContentIndex`, `nodesTasksNodeTasks`, `nodesTasksStatusReadTaskStatus`, `nodesDisksZfsIndex`/`Detail`, `nodesDisksLvmIndex`, `nodesDisksLvmthinIndex`, `clusterBackupIndex` and `clusterBackupInfoNotBackedUpGetGuestsNotInBackup` agree with the schemas above. It declares `mounted` as required, but the code only sets it when true.

UNVERIFIED items:
- The exact runtime JSON typing of values that come straight from config files or property strings, e.g. `"keep-daily":"7"`, and of `vmid` in the PBS prune dry-run.
- Whether PVE 8 storage `total`/`used` serialise as floats.
- The NVMe `wwn` format.
- The format of server-generated backup job IDs.
- Example values (serials, sizes, UPIDs, the PBS verify UPID) are illustrative.
- Vendor semantics of the normalized value for `Percent_Lifetime_Used` and `Perc_Rated_Life_Used`.
