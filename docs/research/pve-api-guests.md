# Proxmox VE REST API: guest endpoints (QEMU VMs and LXC containers), PVE 8.x and 9.x

Reference for the `pve1-dash` backend client and its mock server. Every fact below was checked against Proxmox Perl, JS or C source on the GitHub mirrors (`raw.githubusercontent.com/proxmox/...`), unless it is marked **UNVERIFIED**. Line numbers refer to the branch heads fetched on 2026-10-10. Short source tags such as `[QS9:2370]` are expanded in the Sources section at the end.

Source versions used:

| | PVE 8 ("bookworm") | PVE 9 ("trixie") |
|---|---|---|
| qemu-server | 8.4.10 (`stable-bookworm`) | 9.2.11 (`master`) |
| pve-container | 5.3.6 (`stable-bookworm`) | 6.1.14 (`master`) |
| pve-manager | 8.4.22 (`stable-8`) | 9.2.21 (`master`) |
| pve-cluster (RRD) | `stable-bookworm` | `master` |
| pve-ha-manager | `stable-4` (4.x = PVE 8) | `master` (5.x) |

Earlier 8.x point releases can lack features that appeared later in 8.x. Those cases are called out where they matter.

---

## 0. General conventions (affect every endpoint)

- **Envelope.** On success the body is `{"data": <payload>}`. On error the HTTP status is non-2xx and the body is `{"data": null, "message": "<text>\n"}`. The message usually keeps a trailing `\n`. Parameter-validation errors (400) also carry `"errors": {param: msg}`. A plain `die "..."` inside a handler becomes **HTTP 500**, and the reason phrase is the first line of the message. [HTTPServer.pm:221-230], [Formatter/Standard.pm:14-51], [AnyEvent.pm:304-313, 1062]
- **Permission failure.** HTTP 403 with message `Permission check failed (<path>, <privs>)`. [pve-common Exception.pm raise_perm_exc]
- **JSON typing quirks.** Config values are parsed by `check_type` [QS9:1799-1836]:
  - `integer` values become JSON numbers.
  - `boolean` values become JSON numbers **`0`/`1`**, never `true`/`false`.
  - `string` values, including every property string (`net0`, `scsi0`, `agent`, QEMU `memory`), are JSON strings.
  - `number` values (for example `cpulimit`) are returned unchanged. They probably serialize as JSON strings, such as `"1.5"`. **UNVERIFIED** on a live system.
  - Make the client tolerant: accept `number | string` for numeric fields and `0 | 1 | boolean` for flags.
- **Optional keys.** Optional fields are often **absent** rather than null. For example, `template`, `lock` and `tags` appear only when set.
- **List ordering.** Lists come from Perl hash iteration, so they are **unordered**. `/cluster/resources` sorts VM IDs as **strings** (`sort keys`, so `"1000"` sorts before `"101"`). Sort client-side.
- **Units.** Memory, disk and network counters in status, list and cluster/resources responses are **bytes**. Config `memory`, `balloon` and `swap` are **MiB**. `cpu` is a **fraction** (0..1 of the guest's CPUs). `uptime` is **seconds**. RRD `time` is **unix epoch seconds**.

---

## 1. `GET /nodes/{node}/qemu` and `GET /nodes/{node}/lxc` (guest lists)

| | QEMU | LXC |
|---|---|---|
| Source | [QAPI9:1093-1141] | [LAPI9:95-138] |
| Permission | lists only guests where caller has `VM.Audit` on `/vms/<vmid>` | same |
| Params | `full` (bool, optional): "Determine the full status of active VMs" (runs the slow QMP queries) | none besides `node` |
| Item schema | `$PVE::QemuServer::vmstatus_return_properties` [QS9:2370] | `$PVE::LXC::vmstatus_return_properties` [LXC9:126] |
| Implementation | `PVE::QemuServer::vmstatus(undef, $full)` [QS9:2534] | `PVE::LXC::vmstatus()` [LXC9:261] |

Each list item is the same per-guest object that `status/current` returns (section 2), minus the extra keys that `status/current` adds (`ha`, `agent`, `spice`, `clipboard`). For QEMU without `full=1` the following are **missing**: `qmpstatus`, `diskread`, `diskwrite`, `blockstat`, `nics`, `ballooninfo`, `balloon`, `freemem`, `running-machine`, `running-qemu` and `proxmox-support`. Without `full`, `mem` is the cheap estimate (see 2.1).

LXC items include `"type": "lxc"`, which comes from `config_list` [LXC9:65-79]. QEMU items have **no** `type` key.

Example: `GET /api2/json/nodes/pve1/qemu` (PVE 9, no `full`):
```json
{"data":[
  {"vmid":100,"name":"haos","status":"running","pid":2345,"uptime":864000,
   "cpus":2,"cpu":0.0312,"maxmem":4294967296,"mem":2147483648,"memhost":2147483648,
   "maxdisk":34359738368,"disk":0,"netin":9876543210,"netout":1234567890,
   "balloon_min":2147483648,"shares":1000,"tags":"home;prod",
   "pressurecpusome":0,"pressurecpufull":0,"pressureiosome":0.12,"pressureiofull":0.1,
   "pressurememorysome":0,"pressurememoryfull":0},
  {"vmid":9000,"name":"debian12-tpl","status":"stopped","uptime":0,"cpus":2,"cpu":0,
   "maxmem":2147483648,"mem":0,"memhost":0,"maxdisk":10737418240,"disk":0,
   "netin":0,"netout":0,"template":1}
]}
```

Example: `GET /api2/json/nodes/pve1/lxc` (PVE 9):
```json
{"data":[
  {"vmid":101,"type":"lxc","name":"pihole","status":"running","pid":4567,"uptime":123456,
   "cpus":1,"cpu":0.0071,"mem":104857600,"swap":0,"maxmem":536870912,"maxswap":536870912,
   "disk":1503238553,"maxdisk":8350298112,"netin":734003200,"netout":104857600,
   "diskread":52428800,"diskwrite":209715200,"tags":"dns;infra",
   "pressurecpusome":"0.00","pressurecpufull":"0.00","pressureiosome":"0.00",
   "pressureiofull":"0.00","pressurememorysome":"0.00","pressurememoryfull":"0.00"},
  {"vmid":105,"type":"lxc","name":"CT105","status":"stopped","uptime":0,"cpus":4,"cpu":0,
   "mem":0,"swap":0,"maxmem":536870912,"maxswap":0,"disk":0,"maxdisk":4294967296,
   "netin":0,"netout":0,"diskread":0,"diskwrite":0}
]}
```
The LXC `pressure*` values are shown as strings on purpose. In LXC the values are assigned straight from a regex capture with no numeric coercion [LXC9:361-367], while QEMU multiplies them by `* 1` [QS9:2640-2646]. It is therefore likely that LXC pressure fields serialize as JSON strings. **UNVERIFIED** on a live host: parse with `Number(x)`.

---

## 2. `GET /nodes/{node}/qemu/{vmid}/status/current` and `GET /nodes/{node}/lxc/{vmid}/status/current`

- QEMU: [QAPI9:3455-3519]. Requires `VM.Audit`, `proxyto => node` and `protected => 1`. It calls `vmstatus($vmid, 1)`, so this is always the **full** status.
- LXC: [LSTAT9:77-117]. Requires `VM.Audit` and calls `PVE::LXC::vmstatus($vmid)`. This code is identical in PVE 8.

### 2.1 QEMU fields

Sources: schema [QS9:2370-2530], code [QS9:2534-2800]. PVE 8 is the same except where noted [QS8:2839-3190].

| field | type | unit / meaning | presence |
|---|---|---|---|
| `vmid` | int | | always |
| `status` | `"running"`\|`"stopped"` | process state only (pid exists). A paused VM is still `"running"`. | always |
| `qmpstatus` | string | QMP `query-status` RunState (see section 9). Falls back to `status` when QMP fails. | full only (status/current is always full) |
| `name` | string | config `name`, or `"VM <vmid>"` | always |
| `pid` | int | QEMU process ID | running only |
| `uptime` | int | seconds (from `/proc/<pid>/stat` starttime); 0 when stopped | always |
| `cpu` | number | fraction of the guest's `cpus`. Computed from the delta between calls, and is 0 on the first sample (see note). | always |
| `cpus` | number | `sockets*cores` (defaults 1×1), capped at host CPU count; `vcpus` overrides | always |
| `maxmem` | int | bytes. Config `memory` (MiB) × 1024². In full mode with balloon info it is replaced by QMP `max_mem`. | always |
| `mem` | int | bytes. **PVE 9:** cgroup memory of `qemu.slice/<vmid>.scope` (same as `memhost`), overridden by `total_mem - free_mem` from the balloon driver when available. **PVE 8:** `rss/vsize*maxmem` estimate, overridden the same way. | always (0 when stopped) |
| `memhost` | int | bytes, host view of memory (cgroup). **PVE 9 only** (qemu-server ≥ 9.0.11; PSS before 9.1.4, cgroup from 9.1.4). | always in PVE 9 |
| `maxdisk` | int | bytes, size of **first boot disk** from its `size=` (`bootdisk_size`) [Drive9:954-971]; 0 if none | always |
| `disk` | int | **always 0** ("no info available") [QS9:2561] | always |
| `netin` / `netout` | int | bytes, **cumulative**. Sum over host `tap<vmid>i<N>` devices of /proc/net/dev: `netin` = tap *transmit* (traffic to guest), `netout` = tap *receive*. The schema says "since it was started". | always (0 stopped) |
| `nics` | object | `{"tap100i0": {"netin": int, "netout": int}, ...}` bytes, cumulative | full + running |
| `diskread` / `diskwrite` | int | bytes, **cumulative** since start: sum of QMP `query-blockstats` `rd_bytes` / `wr_bytes` | full + running |
| `blockstat` | object | `{ "<drive id e.g. scsi0>": <QEMU BlockDeviceStats> }`. Keys of the stats object: `rd_bytes, wr_bytes, rd_operations, wr_operations, flush_operations, unmap_bytes, unmap_operations, rd_total_time_ns, wr_total_time_ns, flush_total_time_ns, unmap_total_time_ns, wr_highest_offset, rd_merged, wr_merged, unmap_merged, idle_time_ns?, failed_*_operations, invalid_*_operations, account_invalid, account_failed, timed_stats[], zone_append_*` [qemu block-core.json BlockDeviceStats] | full + running |
| `balloon` | int | bytes, QMP balloon `actual` | full + running + balloon device |
| `freemem` | int | bytes, guest-reported free memory | if guest balloon driver reports stats |
| `ballooninfo` | object | raw QMP `query-balloon` result (Proxmox-patched): `actual`, `max_mem`, `total_mem?`, `free_mem?`, `last_update?`, `mem_swapped_in?`, `mem_swapped_out?`, `major_page_faults?`, `minor_page_faults?` (bytes, except page and fault counters) [pve-qemu patch 0011] | full + running + balloon |
| `balloon_min` | int | bytes = config `balloon` MiB × 1024² | only if config `balloon` > 0 |
| `shares` | int | config `shares` or default 1000 | only if config `balloon` > 0 |
| `running-machine` | string | e.g. `"pc-q35-9.2+pve1"`, built as machine name + `"+"` + `pve-version` [Machine9:215-233] | full + running |
| `running-qemu` | string | `"major.minor.micro"`, e.g. `"9.2.0"`, or `"unknown"` | full + running |
| `proxmox-support` | object | QMP `query-proxmox-support`: booleans such as `pbs-dirty-bitmap`, `query-bitmap-info`, `pbs-dirty-bitmap-savevm`, `pbs-masterkey`, `backup-max-workers`, `pbs-dirty-bitmap-migration`, `backup-fleecing`, `backup-access-api`, plus the string `pbs-library-version`. The set varies by pve-qemu version, so treat it as opaque. | full + running |
| `lock` | string | config lock (section 9) | if set |
| `tags` | string | raw config `tags` (`;`-separated, see 3.3) | if set |
| `template` | int `1` | | only if template |
| `serial` | int `1` | a `serialN` port is configured (needed for xterm.js on QEMU) | only if true |
| `pressurecpusome`, `pressurecpufull`, `pressureiosome`, `pressureiofull`, `pressurememorysome`, `pressurememoryfull` | number | **percent** (0..100), PSI `avg10` of the VM cgroup [kernel psi.rst]. **PVE 9 only.** | running only |
| `ha` | object | PVE 9: `{"managed":0}` or `{"managed":1,"state":"started"}`. PVE 8 adds `"group":"<name>"` when managed [HA9 Config.pm:482-497], [HA8 Config.pm:243-259] | always (status/current only) |
| `agent` | int `1` | the `agent` config has `enabled=1` (this does not mean the agent is running) | only if enabled (status/current only) |
| `spice` | int `1` | VGA is `qxl*` or `virtio*` (SPICE capable) | if true (status/current only) |
| `clipboard` | `"vnc"` or **null** | set whenever config has `vga`, so it is `null` when `vga` exists without `clipboard=` (derived from code) | only if config has `vga` |

**CPU sampling note (derived from code).** `cpu` is the CPU time used since the *previous* `vmstatus` call **in the same worker process**. The calculation is `(Δused/Δtime × hostCPUs)/cpus` [QS9:2648-2670]. API calls are served by pvedaemon workers, each with its own cache, so a fresh worker returns `0` and later calls return the average since that worker's last sample. The value can slightly exceed 1.0 because it includes emulator threads. For dashboards, `/cluster/resources` (sampled by pvestatd about every 10 s) is steadier.

Example: `GET /api2/json/nodes/pve1/qemu/100/status/current` (PVE 9, running, agent enabled):
```json
{"data":{
  "vmid":100,"name":"haos","status":"running","qmpstatus":"running","pid":2345,
  "uptime":864000,"cpus":2,"cpu":0.0287,
  "maxmem":4294967296,"mem":1932735283,"memhost":2254857830,"freemem":2362232013,
  "balloon":4294967296,"balloon_min":2147483648,"shares":1000,
  "ballooninfo":{"actual":4294967296,"max_mem":4294967296,"total_mem":4294967296,
    "free_mem":2362232013,"last_update":1760072400,"mem_swapped_in":0,"mem_swapped_out":0,
    "major_page_faults":1201,"minor_page_faults":5530123},
  "maxdisk":34359738368,"disk":0,
  "netin":9876543210,"netout":1234567890,
  "nics":{"tap100i0":{"netin":9876543210,"netout":1234567890}},
  "diskread":5368709120,"diskwrite":2147483648,
  "blockstat":{"scsi0":{"rd_bytes":5368709120,"wr_bytes":2147483648,"rd_operations":120034,
    "wr_operations":80211,"flush_operations":5011,"rd_total_time_ns":91234567890,
    "wr_total_time_ns":61234567890,"flush_total_time_ns":1234567890,"wr_highest_offset":34358689792,
    "rd_merged":0,"wr_merged":0,"unmap_bytes":0,"unmap_operations":0,"unmap_merged":0,
    "unmap_total_time_ns":0,"idle_time_ns":1532000000,"failed_rd_operations":0,
    "failed_wr_operations":0,"failed_flush_operations":0,"failed_unmap_operations":0,
    "invalid_rd_operations":0,"invalid_wr_operations":0,"invalid_flush_operations":0,
    "invalid_unmap_operations":0,"account_invalid":true,"account_failed":true,"timed_stats":[]}},
  "running-machine":"pc-q35-9.2+pve1","running-qemu":"9.2.0",
  "proxmox-support":{"pbs-dirty-bitmap":true,"query-bitmap-info":true,"pbs-dirty-bitmap-savevm":true,
    "pbs-masterkey":true,"pbs-library-version":"1.5.2 (UNKNOWN)","backup-max-workers":true,
    "pbs-dirty-bitmap-migration":true,"backup-fleecing":true,"backup-access-api":true},
  "tags":"home;prod","agent":1,"ha":{"managed":0},
  "pressurecpusome":0.31,"pressurecpufull":0.12,"pressureiosome":0,"pressureiofull":0,
  "pressurememorysome":0,"pressurememoryfull":0
}}
```
Stopped QEMU VM: `{"vmid":100,"name":"haos","status":"stopped","qmpstatus":"stopped","uptime":0,"cpu":0,"cpus":2,"mem":0,"memhost":0,"maxmem":4294967296,"maxdisk":34359738368,"disk":0,"netin":0,"netout":0,"ha":{"managed":0},"agent":1,"tags":"home;prod"}`. In PVE 8 `memhost` is absent. The `blockstat` example values are illustrative. The `pbs-library-version` value is **UNVERIFIED**.

### 2.2 LXC fields

Sources: schema [LXC9:126-259], code [LXC9:261-415]. Same in PVE 8 except the `pressure*` fields [LXC8].

| field | type | unit / meaning | presence |
|---|---|---|---|
| `vmid` | int | | always |
| `type` | `"lxc"` | not in schema, but always set by code | always |
| `status` | `"running"`\|`"stopped"` | | always |
| `name` | string | config `hostname` with whitespace removed, or `"CT<vmid>"` | always |
| `pid` | int | init PID | running |
| `uptime` | int | seconds | always (0 stopped) |
| `cpu` | number | fraction of `cpus` (cgroup CPU delta, same per-worker caveat as QEMU) | always |
| `cpus` | number | config `cores`, else `cpulimit`, else host CPU count | always |
| `mem` | int | bytes. cgroup v2 `memory.current - memory.stat:file` (page cache excluded) [CGroup.pm:334-369] | always (0 stopped) |
| `swap` | int | bytes, `memory.swap.current` (not in schema) | always |
| `maxmem` | int | bytes = config `memory` MiB (default 512) × 1024² | always |
| `maxswap` | int | bytes = config `swap` MiB × 1024² (missing `swap` gives 0) | always |
| `disk` | int | bytes **used** on rootfs (`df` of `/proc/<pid>/root/`) when running; 0 when stopped | always |
| `maxdisk` | int | bytes. Running: `df` total. Stopped: rootfs `size=`, or 4 GiB | always |
| `netin` / `netout` | int | bytes, cumulative. Sum of host `veth<vmid>i<N>` counters (netin = veth transmit) | always |
| `diskread` / `diskwrite` | int | bytes, cumulative cgroup `io.stat` rbytes/wbytes (since container start) | always (0 stopped) |
| `lock`, `tags`, `template` | | as QEMU | if set |
| `pressure*` (6 fields) | likely strings (see 1) | PSI avg10 percent of `lxc/<vmid>` cgroup. **PVE 9 only.** `pressurecpufull` is returned but missing from the schema. | running |
| `ha` | object | as QEMU, with sid `ct:<vmid>` | status/current only |

LXC has **no** `qmpstatus`, `agent`, `nics`, `blockstat` or `memhost`.

Example: `GET /api2/json/nodes/pve1/lxc/101/status/current`:
```json
{"data":{"vmid":101,"type":"lxc","name":"pihole","status":"running","pid":4567,"uptime":123456,
 "cpus":1,"cpu":0.0071,"mem":104857600,"swap":0,"maxmem":536870912,"maxswap":536870912,
 "disk":1503238553,"maxdisk":8350298112,"netin":734003200,"netout":104857600,
 "diskread":52428800,"diskwrite":209715200,"tags":"dns;infra","ha":{"managed":0},
 "pressurecpusome":"0.00","pressurecpufull":"0.00","pressureiosome":"0.00","pressureiofull":"0.00",
 "pressurememorysome":"0.00","pressurememoryfull":"0.00"}}
```

---

## 3. `GET /nodes/{node}/qemu/{vmid}/config` and `GET /nodes/{node}/lxc/{vmid}/config`

- QEMU: [QAPI9:1807-1873]. Requires `VM.Audit`. Params: `current` (bool, default 0; by default **pending changes are applied**) and `snapshot` (name). The response is the parsed config plus `digest`. `snapshots`, `pending` and `special-sections` are removed [AbstractConfig.pm:230-253], [QemuConfig.pm:575-579]. `cipassword` is masked as `"**********"`.
- LXC: [LCFG9:25-101]. Same params. Also returns `lxc` as `[[key,value],...]` for raw `lxc.*` lines, and hides `env` unless the caller has `VM.Config.Options`.
- `digest`: SHA1 hex (40 chars) of the config file.

### 3.1 Value formats

- **Property strings** are `key=value` pairs separated by `,`. A "default key" may appear first without `key=`. When PVE writes them it orders them as: the default key, then required keys sorted, then the remaining keys **sorted alphabetically** [JSONSchema.pm:2781-2878]. Drive strings are **re-printed canonically on every config read** [QS9:2055-2065]. Other keys (such as `net0`) are returned exactly as stored, so hand-edited configs may use a different order. **Always parse generically, never positionally.**
- **Disk sizes** (`size=`) are printed by `format_size`: an integer followed by `K`, `M`, `G` or `T`, all binary (1G = 1024³), choosing the largest unit that divides exactly, otherwise a bare byte count [JSONSchema.pm:1041-1059]. `parse_size` also accepts `KiB`, `MiB`, `GiB`, `TiB` and decimals [JSONSchema.pm:1022-1039]. Valid examples: `32G`, `4M`, `528K`, `1T`, `34359738368`.
- **`description`** is stored as `#`-comment lines (URL-encoded) at the top of the file. The API returns it decoded (UTF-8) with each comment line followed by `\n`, so there is normally a **trailing newline** [QS9:2021-2030]. The maximum length is 8 KiB. The web UI renders it as **Markdown** (`Proxmox.Markdown.parse`) [pwt NotesView.js:90].

### 3.2 QEMU keys useful for a dashboard

Source: `$confdesc` [QS9:240-743], plus the net/drive/agent/machine/cpu formats.

| key | JSON type | meaning / format |
|---|---|---|
| `name` | string | DNS-name style VM name |
| `ostype` | string | `other wxp w2k w2k3 w2k8 wvista win7 win8 win10 win11 l24 l26 solaris` (same list in PVE 8 and 9) |
| `cores`, `sockets` | int | defaults 1/1 when absent |
| `vcpus` | int | hotplugged vCPUs (optional) |
| `memory` | **string** | property string with default key `current` (MiB). In practice plain digits such as `"4096"`. Default 512 when absent [Memory9:78-88] |
| `balloon` | int | MiB target. `0` disables ballooning. Absent means enabled with target = memory |
| `cpu` | string | `[cputype=]<type>[,flags=...]`. Default type `kvm64` if unset [CPUConfig9:294-303, 1152-1162]; e.g. `"x86-64-v2-AES"`, `"host"` |
| `bios` | string | `seabios` (default) or `ovmf` |
| `machine` | string | `[type=]<pc\|q35\|pc-i440fx-X.Y[+pveN]\|pc-q35-X.Y[+pveN]\|virt...>[,viommu=intel\|virtio][,enable-s3=..]` [Machine9:55-98]; e.g. `"q35"`, `"pc-q35-9.2+pve1"` |
| `agent` | string | `[enabled=]<0\|1>[,fstrim_cloned_disks=<0\|1>][,freeze-fs=<0\|1>][,type=virtio\|isa]`; e.g. `"1"`, `"enabled=1,fstrim_cloned_disks=1"`. PVE 8 names the freeze option `freeze-fs-on-backup`; PVE 9 uses `freeze-fs`, with `freeze-fs-on-backup` kept as an alias [Agent9:23-62], [QS8:165-190] |
| `net0..netN` | string | `<model>=<MAC>,bridge=<br>[,firewall=1][,link_down=1][,mtu=N][,queues=N][,rate=<MB/s>][,tag=<vlan>][,trunks=a;b]` [Net9:48-139]. Models: `e1000 e1000-82540em e1000-82544gc e1000-82545em e1000e i82551 i82557b i82559er ne2k_isa ne2k_pci pcnet rtl8139 virtio vmxnet3`. Printed by PVE with `model=MAC` first, then keys sorted |
| `scsiN` (0-30), `virtioN` (0-15), `sataN` (0-5), `ideN` (0-3) | string | `<storage>:<volume>[,key=val...]`; `media=cdrom` marks CD drives; `size=` informational [Drive9:155-200] |
| `efidisk0`, `tpmstate0` | string | e.g. `local-lvm:vm-100-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M` and `local-lvm:vm-100-disk-2,size=4M,version=v2.0` |
| `unusedN` | string | detached volume ID |
| `boot` | string | e.g. `"order=scsi0;ide2;net0"` |
| `onboot` | int 0/1 | default 0 |
| `startup` | string | `[[order=]N][,up=SECONDS][,down=SECONDS]`, e.g. `"order=1,up=30,down=60"` [JSONSchema.pm:905-939] |
| `tags` | string | see 3.3 |
| `description` | string | notes (Markdown in UI) |
| `template` | int 0/1 | |
| `lock` | string | section 9 |
| `protection` | int 0/1 | |
| `meta` | string | `creation-qemu=<ver>,ctime=<epoch>` (read-only info) [MetaInfo9] |
| `vga` | string | `[type=]<std\|qxl\|virtio\|serial0\|none...>[,memory=MiB][,clipboard=vnc]` |
| `serialN` | string | e.g. `"socket"` (enables xterm.js console for QEMU) |
| `hotplug`, `numa`, `scsihw`, `smbios1`, `vmgenid`, `affinity`, `allow-ksm` (PVE 9) | | misc |
| `digest` | string | 40-hex SHA1 |

Realistic QEMU example:
```json
{"data":{
 "agent":"enabled=1,fstrim_cloned_disks=1","balloon":2048,"bios":"ovmf",
 "boot":"order=scsi0;ide2;net0","cores":2,"cpu":"x86-64-v2-AES",
 "description":"Home Assistant OS\n\n**URL:** http://haos.lan:8123\n",
 "digest":"9b2c1e0f4d3a5b6c7d8e9f00112233445566778899",
 "efidisk0":"local-lvm:vm-100-disk-0,efitype=4m,pre-enrolled-keys=1,size=4M",
 "ide2":"none,media=cdrom","machine":"q35","memory":"4096",
 "meta":"creation-qemu=9.0.2,ctime=1726000000","name":"haos",
 "net0":"virtio=BC:24:11:3A:5F:01,bridge=vmbr0,firewall=1,tag=20",
 "numa":0,"onboot":1,"ostype":"l26",
 "scsi0":"local-lvm:vm-100-disk-1,discard=on,iothread=1,size=32G,ssd=1",
 "scsihw":"virtio-scsi-single","smbios1":"uuid=6f1c1a0e-2b6c-4b7e-9d0a-1c2b3c4d5e6f",
 "sockets":1,"startup":"order=1,up=30","tags":"home;prod",
 "vmgenid":"0b8c5e2a-7d1f-4c3b-9a6e-5f4d3c2b1a09"}}
```
The digest shown is illustrative; a real digest is exactly 40 hex characters. Other drive examples: `"virtio0":"local-zfs:vm-102-disk-0,size=64G"` and `"ide2":"local:iso/debian-12.7.0-amd64-netinst.iso,media=cdrom,size=631M"`.

### 3.3 Tags

- The format `pve-tag-list` splits on **`,`, `;` or whitespace** (`split_list`: `s/[,;]/ /g` then split on whitespace) [ParseUtils.pm:49-58]. Each tag must match `/^[a-z0-9_][a-z0-9_\-\+\.]*$/i` [JSONSchema.pm:890-903].
- On API writes, PVE normalizes tags with `get_unique_tags`: the result is **joined with `;`**, lowercased (unless datacenter `tag-style` `case-sensitive`), de-duplicated and sorted (unless `tag-style` `ordering=config`) [GuestHelpers.pm:349-378]. Write paths: [QAPI9:1560, 2527], [LCONF9:1363].
- The web UI splits with `/[,; ]/` [Utils9:2101]. Clients should do the same. Do not assume `;` only, because hand edits can contain `,` or spaces.

### 3.4 LXC keys useful for a dashboard

Source: `$confdesc` [LCONF9:512-725], net [LCONF9:853-962], rootfs and mp [LCONF9:346-420, 1002-1028].

| key | JSON type | meaning / format |
|---|---|---|
| `hostname` | string | |
| `ostype` | string | `debian devuan ubuntu centos fedora opensuse archlinux alpine gentoo nixos unmanaged` |
| `arch` | string | `amd64` (default) `i386 arm64 armhf riscv32 riscv64` |
| `cores` | int | optional; absent means all host cores usable |
| `cpulimit` | number | 0 = unlimited |
| `memory` | **int** | MiB (default 512). Note this is an int for LXC and a string for QEMU |
| `swap` | int | MiB (default 512) |
| `rootfs` | string | `<volume>[,size=8G][,acl=..][,mountoptions=..][,quota=..][,ro=..][,replicate=..][,shared=..]`, e.g. `"local-lvm:vm-101-disk-0,size=8G"` |
| `mp0..mpN` | string | `<volume>,mp=<path>[,backup=1][,size=..]...`, e.g. `"local-lvm:vm-101-disk-1,mp=/mnt/data,backup=1,size=32G"`; bind mount: `"/tank/media,mp=/media"` |
| `net0..net31` | string | `name=<ifname>[,bridge=..][,firewall=1][,gw=..][,gw6=..][,hwaddr=..][,ip=<CIDR\|dhcp\|manual>][,ip6=<CIDR\|auto\|dhcp\|manual>][,link_down=1][,mtu=N][,rate=..][,tag=N][,trunks=..][,type=veth][,host-managed=1]`. `name` is required, so PVE prints it first, then the rest sorted. Example: `"name=eth0,bridge=vmbr0,firewall=1,hwaddr=BC:24:11:5E:7A:01,ip=dhcp,ip6=auto,type=veth"`. `host-managed` is PVE 9 only: it was added in pve-container 6.0.15 [pve-container changelog L273] and is absent from stable-bookworm |
| `onboot` | int 0/1 | |
| `startup` | string | same format as QEMU |
| `unprivileged` | int 0/1 | schema default 0 (UI creates with 1) |
| `features` | string | `nesting=1,keyctl=1,fuse=1,mknod=1,mount=nfs;cifs,force_rw_sys=1` |
| `tags`, `description`, `template`, `lock`, `protection` | | as QEMU |
| `nameserver`, `searchdomain`, `timezone`, `cmode`, `console`, `tty`, `entrypoint`, `env` (restricted), `hookscript` | | misc |
| `lxc` | `[[k,v],...]` | raw `lxc.*` lines |
| `digest` | string | |

Realistic LXC example:
```json
{"data":{
 "arch":"amd64","cores":1,"description":"Pi-hole DNS sinkhole\n",
 "digest":"4e1d2c3b4a5f60718293a4b5c6d7e8f901234567",
 "features":"keyctl=1,nesting=1","hostname":"pihole","memory":512,
 "net0":"name=eth0,bridge=vmbr0,firewall=1,gw=192.168.20.1,hwaddr=BC:24:11:5E:7A:01,ip=192.168.20.53/24,tag=20,type=veth",
 "onboot":1,"ostype":"debian","rootfs":"local-lvm:vm-101-disk-0,size=8G",
 "startup":"order=2","swap":512,"tags":"dns;infra","unprivileged":1}}
```

---

## 4. `GET /nodes/{node}/lxc/{vmid}/interfaces`

- Source: [LAPI9:2992-3076]; implementation `PVE::LXC::get_interfaces` [LXC9:1285-1325].
- Permission: **`VM.Audit`** on `/vms/{vmid}`. `protected => 1`, `proxyto => node`.
- Availability: added in pve-container **5.0.6** (Nov 2023, PVE 8.1) [pve-container changelog]. The `proxyto` fix (#5674) came in 5.2.0. `hardware-address` and `ip-addresses` were added in **5.2.6** (Apr 2025, PVE 8.4) ("api: return all active IP addresses of an interface"). Older 8.x returns only `name`, `hwaddr`, `inet` and `inet6`, which matches the older TS model `nodesLxcInterfacesIp`. PVE 8.0 has no such endpoint.
- Implementation: runs `nsenter -t <pid> --net -- ip --json a` inside the container's network namespace. The list includes **`lo`**.

| field | type | notes |
|---|---|---|
| `name` | string | ifname |
| `hwaddr` | string | MAC (lowercase from iproute2); marked "deprecate on next major release" |
| `hardware-address` | string | same value (5.2.6+) |
| `inet` | string | **one** IPv4 as `addr/prefix`. The last address of that family wins (deprecated) |
| `inet6` | string | **one** IPv6 as `addr/prefix` (deprecated) |
| `ip-addresses` | array | `[{ "ip-address": "192.168.20.53", "ip-address-type": "inet", "prefix": 24 }]` (5.2.6+). **`ip-address-type` is `"inet"` or `"inet6"` (iproute2 family), NOT `ipv4`/`ipv6` as in the QEMU agent.** |

When the container is stopped, `find_lxc_pid` dies and `get_interfaces` does `return if $@`. Reading the code, the response is then most likely HTTP 200 with `{"data": null}`. **UNVERIFIED** on a live host, so handle both `null` and an error.

Example (running CT, PVE 8.4+/9):
```json
{"data":[
 {"name":"lo","hwaddr":"00:00:00:00:00:00","hardware-address":"00:00:00:00:00:00",
  "inet":"127.0.0.1/8","inet6":"::1/128",
  "ip-addresses":[{"ip-address-type":"inet","ip-address":"127.0.0.1","prefix":8},
                  {"ip-address-type":"inet6","ip-address":"::1","prefix":128}]},
 {"name":"eth0","hwaddr":"bc:24:11:5e:7a:01","hardware-address":"bc:24:11:5e:7a:01",
  "inet":"192.168.20.53/24","inet6":"fe80::be24:11ff:fe5e:7a01/64",
  "ip-addresses":[{"ip-address-type":"inet","ip-address":"192.168.20.53","prefix":24},
                  {"ip-address-type":"inet6","ip-address":"fe80::be24:11ff:fe5e:7a01","prefix":64}]}
]}
```

---

## 5. QEMU guest agent endpoints `/nodes/{node}/qemu/{vmid}/agent/...`

Source: [AgentAPI9:26-250], [AgentAPI8:21-215].

- Every command is registered as its own endpoint, and the response is **`{"data": {"result": <raw QGA return>}}`**. GET commands are `get-time`, `info`, `network-get-interfaces`, `get-vcpus`, `get-fsinfo`, `get-memory-blocks`, `get-memory-block-info`, `get-host-name`, `get-osinfo`, `get-users` and `get-timezone`. POST commands include `ping`, `fsfreeze-*`, `fstrim`, `shutdown` and `suspend-*`. `GET .../agent` lists `[{name}]`.
- **Permissions (big 8 vs 9 difference):**
  - **PVE 8:** every command requires **`VM.Monitor`** (default in `register_command`) [AgentAPI8:136-147]. `VM.Monitor` is in the *admin* privilege group, so **PVEAuditor does NOT have it** [AccessControl8:1070]. `VM.Monitor` also allows `POST .../monitor` with `info *` HMP commands; non-read-only commands additionally require `Sys.Modify` [QAPI8:5651-5681].
  - **PVE 9:** `VM.Monitor` was **removed** (libpve-access-control 9.0.2: "drop VM.Monitor in favor of more granular VM.GuestAgent.* privileges"). Read commands require **`VM.GuestAgent.Audit`** or `VM.GuestAgent.Unrestricted` [AgentAPI9:26-120, 171-188]. `VM.GuestAgent.Audit` is in the *audit* group, so **PVEAuditor includes it** [AccessControl9:1056-1197].
- **Precondition errors** are plain `die`, which gives **HTTP 500**. The message is in the reason phrase and in `message` [Agent9:109-113], [Agent8:39-54]:
  - config has no `agent` line: `"No QEMU guest agent configured\n"`. The check is `defined($conf->{agent})`, so `agent: 0` passes this check and fails a later one.
  - VM not running: `"VM <vmid> is not running\n"`
  - agent not responding to `guest-ping` (3 s timeout): `"QEMU guest agent is not running\n"`
  - a QGA command error or timeout (default 5 s): `"VM <vmid> qga command 'guest-<cmd>' failed - <desc>"` [QMPClient9:116-190]
  - missing privilege: HTTP 403 `"Permission check failed (/vms/100, VM.GuestAgent.Audit|...)"`; the exact suffix is **UNVERIFIED**.

  Example error body: `{"data":null,"message":"QEMU guest agent is not running\n"}` with status line `HTTP/1.1 500 QEMU guest agent is not running`.

Result shapes come from the QEMU QGA schema [qga/qapi-schema.json]:

**`GET .../agent/network-get-interfaces`**: `result: GuestNetworkInterface[]`
- `name`: string
- `hardware-address?`: string, lowercase `%02x:` on POSIX
- `ip-addresses?`: array of `{ "ip-address": string, "ip-address-type": "ipv4"|"ipv6", "prefix": int }`
- `statistics?`: `{ rx-bytes, rx-packets, rx-errs, rx-dropped, tx-bytes, tx-packets, tx-errs, tx-dropped }`, all uint64

Includes `lo`, docker/veth interfaces and so on. Interfaces without addresses may omit `ip-addresses`.
```json
{"data":{"result":[
 {"name":"lo","hardware-address":"00:00:00:00:00:00",
  "ip-addresses":[{"ip-address-type":"ipv4","ip-address":"127.0.0.1","prefix":8},
                  {"ip-address-type":"ipv6","ip-address":"::1","prefix":128}],
  "statistics":{"rx-bytes":51234,"rx-packets":612,"rx-errs":0,"rx-dropped":0,
                "tx-bytes":51234,"tx-packets":612,"tx-errs":0,"tx-dropped":0}},
 {"name":"enp0s18","hardware-address":"bc:24:11:3a:5f:01",
  "ip-addresses":[{"ip-address-type":"ipv4","ip-address":"192.168.20.10","prefix":24},
                  {"ip-address-type":"ipv6","ip-address":"fe80::be24:11ff:fe3a:5f01","prefix":64}],
  "statistics":{"rx-bytes":9876543210,"rx-packets":7345123,"rx-errs":0,"rx-dropped":12,
                "tx-bytes":1234567890,"tx-packets":2345123,"tx-errs":0,"tx-dropped":0}}
]}}
```

**`GET .../agent/get-osinfo`**: `result: GuestOSInfo`. All fields are optional: `kernel-release`, `kernel-version`, `machine`, `id`, `name`, `pretty-name`, `version`, `version-id`, `variant`, `variant-id`. On POSIX they come from os-release(5) plus uname. On Windows, `id` is `"mswindows"`, `name` is `"Microsoft Windows"` and `variant` is `server` or `client`.
```json
{"data":{"result":{"id":"debian","name":"Debian GNU/Linux","pretty-name":"Debian GNU/Linux 12 (bookworm)",
 "version":"12 (bookworm)","version-id":"12","kernel-release":"6.1.0-25-amd64",
 "kernel-version":"#1 SMP PREEMPT_DYNAMIC Debian 6.1.106-3 (2024-08-26)","machine":"x86_64"}}}
```

**`GET .../agent/info`**: `result: { "version": string, "supported_commands": [ { "name": string, "enabled": bool, "success-response": bool } ] }`. Note `supported_commands` uses an underscore.
```json
{"data":{"result":{"version":"7.2.11","supported_commands":[
 {"name":"guest-get-osinfo","enabled":true,"success-response":true},
 {"name":"guest-network-get-interfaces","enabled":true,"success-response":true}]}}}
```

**`GET .../agent/get-host-name`**: `result: { "host-name": string }`, e.g. `{"data":{"result":{"host-name":"haos"}}}`.

Example payload values (versions, kernel strings) are illustrative. The field names are verified.

Recommended dashboard flow:
1. Read `status/current` and check that `agent == 1 && status == "running"`.
2. Only then call `agent/*`.
3. Treat HTTP 500 as "agent unavailable", and cache that result for a while, because each failing call waits up to the 3 s ping timeout.

---

## 6. `GET /nodes/{node}/{qemu|lxc}/{vmid}/rrddata?timeframe=..&cf=..`

- Source: [QAPI9:1764-1806], [LAPI9:766-808]. Requires `VM.Audit`. `timeframe` is required: `hour|day|week|month|year`. The **guest** endpoints do **not** accept `decade`, although node rrddata does in PVE 9 [Nodes9:810]. `cf` is `AVERAGE` (default) or `MAX`.
- Returns an array of objects `{time, <ds>...}`. `time` is unix epoch seconds, stepping by the resolution. **Data sources that are unknown for a bucket (NaN) are omitted** from that object, for example `cpu` and `mem` while the guest is stopped [RRD9:10-34].
- RRD file: PVE 8 reads `pve2-vm/<vmid>`, PVE 9 reads `pve-vm-9.0/<vmid>`. The PVE 9 reader transparently prepends data from the old `pve2-vm` file (or `.old`) for older ranges [RRD9:49-130].

Data sources [pmxcfs status.c]:

| DS | RRD type | unit in rrddata | PVE 8 | PVE 9 |
|---|---|---|---|---|
| `maxcpu` | GAUGE | number of vCPUs | yes | yes |
| `cpu` | GAUGE | fraction 0..1 of maxcpu | yes | yes |
| `maxmem`, `mem` | GAUGE | bytes | yes | yes |
| `maxdisk`, `disk` | GAUGE | bytes (QEMU `disk` always 0) | yes | yes |
| `netin`, `netout` | **DERIVE** | **bytes per second** (rate) | yes | yes |
| `diskread`, `diskwrite` | **DERIVE** | **bytes per second** | yes | yes |
| `memhost` | GAUGE | bytes. QEMU only; LXC writes `U`, so the key is absent | no | yes |
| `pressurecpusome`, `pressurecpufull`, `pressureiosome`, `pressureiofull`, `pressurememorysome`, `pressurememoryfull` | GAUGE | percent (PSI avg10) | no | yes |

Sources: PVE 8 DS list [status.c8:1127-1151]; PVE 9 DS list [status.c9:1147-1180]; pvestatd column order [pvestatd9:328-395, 621-680].

Resolution and point counts:

| timeframe | PVE 8 (`pve2`) | PVE 9 (`pve-vm-9.0`) |
|---|---|---|
| hour | 60 s × 70 | 60 s × 60 |
| day | 30 min × 70 | **60 s × 1440** |
| week | 3 h × 70 | 30 min × 336 |
| month | 12 h × 70 | 30 min × 1440 |
| year | 7 d × 70 | 6 h × 1440 |

Sources: [RRD8 create_rrd_data:10-30], [RRD9:55-71]. PVE 9 also drops a final bucket that contains only `time` [RRD9:124-128]. Payloads in PVE 9 are much larger, so downsample client-side for sparklines.

Example (PVE 9, `timeframe=hour`, running QEMU VM, two points):
```json
{"data":[
 {"time":1760072340,"maxcpu":2,"cpu":0.0291,"maxmem":4294967296,"mem":1931000000,"memhost":2254857830,
  "maxdisk":34359738368,"disk":0,"netin":1520.4,"netout":830.2,"diskread":0,"diskwrite":40960.7,
  "pressurecpusome":0.3,"pressurecpufull":0.1,"pressureiosome":0,"pressureiofull":0,
  "pressurememorysome":0,"pressurememoryfull":0},
 {"time":1760072400,"maxcpu":2,"cpu":0.0287,"maxmem":4294967296,"mem":1932735283,"memhost":2254857830,
  "maxdisk":34359738368,"disk":0,"netin":1498.9,"netout":812.5,"diskread":0,"diskwrite":38211.0,
  "pressurecpusome":0.31,"pressurecpufull":0.12,"pressureiosome":0,"pressureiofull":0,
  "pressurememorysome":0,"pressurememoryfull":0}
]}
```
A stopped-guest bucket keeps only `time`, `maxcpu`, `maxmem`, `maxdisk` and `disk`; the others are `U` and omitted. Values are floats, including the averaged byte gauges.

---

## 7. `/cluster/resources` entries of type `qemu` and `lxc`

Sources: [Cluster9:263-560], `extract_vm_stats` [API2Tools9:81-119] / [API2Tools8:104-138], pvestatd [pvestatd9:328-395, 621-680].

- Query: `GET /cluster/resources?type=vm` returns both qemu and lxc (the filter enum is `vm|storage|node|sdn`). Each entry's `type` is `"qemu"` or `"lxc"`, and `id` is `"qemu/100"` or `"lxc/101"`.
- Data comes from the last pvestatd broadcast (about every 10 s), which is the RRD "live" columns. The fields are:
  - `id`, `vmid`, `node`, `type`, `status`, `name`, `uptime`, `template` (0/1, always present here), `maxcpu`, `cpu`, `maxmem`, `mem`, `maxdisk`, `disk`, `netin`, `netout`, `diskread`, `diskwrite`
  - `memhost`: PVE 9 only. Present on **both** qemu and lxc entries, but always `0` for LXC, because pvestatd writes `U` and the code does `('U'||0)+0` (derived from code).
  - `tags` and `lock`: from config, if set
  - `pool`: if the guest is in a pool and the caller has `Pool.Audit`
  - `hastate`: if HA-managed. Either a CRM state (`started stopped request_stop request_start request_start_balance fence recovery migrate relocate freeze error`) or a resource config state (`started stopped enabled disabled ignored`) [HAManager9:421-433], [HAResources9:19-24]
- **`status` for qemu entries is pvestatd's `qmpstatus || status || 'stopped'`.** It can therefore be `running`, `paused`, `prelaunch`, `suspended`, `io-error`, `internal-error` and so on, not just running/stopped [pvestatd9:341]. LXC entries are `running` or `stopped`. If no RRD data exists for the guest (for example a node down or just booted), the entry is just `{id, vmid, node, type, status:"unknown"}` plus tags, lock, pool and hastate.
- **`netin`/`netout`/`diskread`/`diskwrite` are cumulative byte counters since guest start, not rates.** The schema says "since it was started" / "since the guest was started" [Cluster9]. The values are the cumulative tap/veth and blockstats or cgroup counters from `vmstatus` [QS9:2601-2614, 2698-2725], [LXC9:340-412]. They reset on guest restart, and per-NIC counters reset on NIC hot-unplug or replug. For QEMU, pvestatd calls `vmstatus(undef, 1)` (full), so `diskread`/`diskwrite` are populated. To get rates, diff two samples or use rrddata.
- `cpu` is a fraction 0..1 of `maxcpu` (`renderer => 'fraction_as_percentage'`).
- Permissions: entries are filtered by `VM.Audit` on `/vms/<vmid>`.

Example (PVE 9):
```json
{"data":[
 {"id":"qemu/100","type":"qemu","vmid":100,"node":"pve1","name":"haos","status":"running","template":0,
  "uptime":864000,"maxcpu":2,"cpu":0.0287,"maxmem":4294967296,"mem":1932735283,"memhost":2254857830,
  "maxdisk":34359738368,"disk":0,"netin":9876543210,"netout":1234567890,
  "diskread":5368709120,"diskwrite":2147483648,"tags":"home;prod","hastate":"started","pool":"prod"},
 {"id":"lxc/101","type":"lxc","vmid":101,"node":"pve1","name":"pihole","status":"running","template":0,
  "uptime":123456,"maxcpu":1,"cpu":0.0071,"maxmem":536870912,"mem":104857600,"memhost":0,
  "maxdisk":8350298112,"disk":1503238553,"netin":734003200,"netout":104857600,
  "diskread":52428800,"diskwrite":209715200,"tags":"dns;infra"},
 {"id":"qemu/102","type":"qemu","vmid":102,"node":"pve1","name":"win11","status":"paused","template":0,
  "uptime":3600,"maxcpu":4,"cpu":0,"maxmem":8589934592,"mem":8589934592,"memhost":8650000000,
  "maxdisk":68719476736,"disk":0,"netin":1000,"netout":2000,"diskread":0,"diskwrite":0,"lock":"suspending"}
]}
```
PVE 8 is the same except there is no `memhost`.

---

## 8. Web UI console deep links (open in a new tab on `https://pve1:8006`)

Sources: [Utils9:1438-1516], [pwt Utils.js:1091-1108], [ConsoleButton9], [qemu/Config.js 9:455-498], [pveproxy9:250-301], [pve-xtermjs main.js:22-44, 317-325]. The PVE 8 code is identical [Utils8:1398-1437].

- Builders:
  - **noVNC:** `PVE.Utils.openVNCViewer` builds `'?' + Ext.Object.toQueryString({console, novnc:1, vmid, vmname, node, resize, cmd})`. `resize` is the browser-local setting `novnc-scaling`: `off` (default), `scale` or `auto`.
  - **xterm.js:** `Proxmox.Utils.openXtermJsViewer` builds `'?' + toQueryString({console, xtermjs:1, vmid, vmname, node, cmd})`.
  - `toQueryString` emits **empty values as `key=`**, using `Ext.isEmpty(value) ? ''`. Verified in ExtJS 6.2.0 `packages/core/src/lang/Object.js:203-209`. PVE ships ExtJS 7, where the same behavior is assumed and **UNVERIFIED**. Values are `encodeURIComponent`-encoded.
  - `console` values: `kvm`, `lxc`, `shell`, `upgrade` or `cmd`.
- Server side: pveproxy serves the noVNC page if `console` is defined and `novnc` is truthy, and serves the xterm.js page if `console` is defined and `xtermjs` is truthy. Otherwise it serves the normal UI.
- **Default viewer.** `defaultViewer` = datacenter.cfg `console` option (`applet|vv|html5|xtermjs`) if set, otherwise `'vv'` (SPICE) for kvm and `'xtermjs'` for everything else. There are fallbacks:
  - **QEMU:** SPICE only if `status/current.spice`, otherwise xterm.js only if `status/current.serial`, otherwise **noVNC (`html5`)**. A typical VM with `std` VGA and no serial port therefore uses **noVNC**.
  - **LXC:** **xterm.js** (both xterm.js and SPICE are enabled on the CT button).
  - **Node shell** (`consoleType: 'shell'`): **xterm.js**.

URLs a dashboard can open (`vmname` is cosmetic, used for the window title):
```
QEMU noVNC  : https://pve1:8006/?console=kvm&novnc=1&vmid=100&vmname=haos&node=pve1&resize=off&cmd=
QEMU xterm  : https://pve1:8006/?console=kvm&xtermjs=1&vmid=100&vmname=haos&node=pve1&cmd=      (only works if VM has serialN)
LXC xterm   : https://pve1:8006/?console=lxc&xtermjs=1&vmid=101&vmname=pihole&node=pve1&cmd=
LXC noVNC   : https://pve1:8006/?console=lxc&novnc=1&vmid=101&vmname=pihole&node=pve1&resize=off&cmd=
Node shell  : https://pve1:8006/?console=shell&xtermjs=1&vmid=0&vmname=&node=pve1&cmd=
              (UI button sends vmid=0 because ConsoleButton default vmid is 0; the minimal form is ?console=shell&xtermjs=1&node=pve1)
```
The xterm.js client itself builds `?console=<type>&xtermjs=1&vmid=..&vmname=..&node=..` when following a migrated guest [pve-xtermjs main.js:323-325].

These pages authenticate with the **browser's PVE login cookie** at :8006, not with the dashboard's API token. The user must have `VM.Console` (guests) or `Sys.Console` (node shell). What happens when the user is not logged in (an error versus a login prompt) is **UNVERIFIED**.

---

## 9. Enumerations

- **QEMU `status`** (schema enum): `running | stopped` [QS9:2372-2375].
- **LXC `status`**: `running | stopped` [LXC9:128-131].
- **QEMU `qmpstatus`**: the QEMU `RunState` values `debug, inmigrate, internal-error, io-error, paused, postmigrate, prelaunch, finish-migrate, restore-vm, running, save-vm, shutdown, suspended, watchdog, guest-panicked, colo` [qemu qapi/run-state.json:57-61]. It is set to `status` (so `stopped`, or `running` if QMP timed out) when unavailable.
  - `prelaunch`: started with `-S`, not yet running.
  - `paused`: `qm suspend` without `--todisk` sends QMP `stop`.
  - `suspended`: ACPI S3 from inside the guest.
  - The UI treats `prelaunch`, `paused` and `suspended` as "resume-able" [qemu/Config.js 9:487].
- **`/cluster/resources` status**: qemu = any qmpstatus value, or `stopped`, or `unknown`. lxc = `running`, `stopped` or `unknown`.
- **QEMU `lock`**: `backup clone create migrate rollback snapshot snapshot-delete suspending suspended`. The list is identical in PVE 8 and 9 [QS9:270-276], [QS8:299-305]. `suspended` means hibernated to disk: the VM is `stopped` and has a `vmstate`.
- **LXC `lock`**: `backup create destroyed disk fstrim migrate mounted rollback snapshot snapshot-delete`, identical in PVE 8 and 9 [LCONF9:513-520], [LCONF8:488-495].
- **HA (`ha.state`, `hastate`)**: see section 7.

---

## 10. Privileges for a read-only dashboard token

| Need | PVE 8 | PVE 9 |
|---|---|---|
| lists, status/current, config, rrddata, `/cluster/resources`, LXC `interfaces` | `VM.Audit` (in PVEAuditor) | `VM.Audit` (in PVEAuditor) |
| QEMU agent reads (`network-get-interfaces`, `get-osinfo`, `info`, `get-host-name`) | `VM.Monitor`, **not** in PVEAuditor. It is admin-level and also grants `info` HMP access | `VM.GuestAgent.Audit` (**in PVEAuditor**) or `VM.GuestAgent.Unrestricted` |
| LXC config `env` key | `VM.Config.Options` | `VM.Config.Options` |
| pool name in `/cluster/resources` | `Pool.Audit` | `Pool.Audit` |

Practical consequence: on PVE 8 with a PVEAuditor-only token, agent calls return **403**. Detect this and degrade gracefully, falling back to config MACs and the LXC `/interfaces` endpoint.

---

## 11. Mock server checklist (gotchas)

1. QEMU `disk` is always `0`. Use `maxdisk` (boot disk size) only. LXC `disk` is real when running.
2. QEMU `status` stays `running` while paused. Use `qmpstatus` (status/current) or `/cluster/resources.status`.
3. Counters (`netin`, `netout`, `diskread`, `diskwrite`) are cumulative bytes in status, lists and cluster/resources, but bytes/second in rrddata.
4. Config `memory` is a **string** for QEMU and an **int** for LXC, both in MiB. Status `maxmem` is bytes.
5. Booleans are `0`/`1` numbers. Optional keys are absent, not null. Exception: QEMU `clipboard` can be `null`.
6. `memhost` and the `pressure*` fields exist only on PVE 9. Detect the version via `GET /version` rather than per-field.
7. QGA uses `ip-address-type: ipv4|ipv6`; LXC `/interfaces` uses `inet|inet6`. MACs are lowercase in both, but uppercase in config (`BC:24:11:...`). Compare case-insensitively.
8. Agent failures are HTTP **500** with a human message. Mock the three precondition texts exactly.
9. rrddata point counts and resolutions differ between PVE 8 and 9 (see the table in section 6). Guest rrddata has no `decade`.
10. Tags: split on `[,; ]+`. PVE writes them with `;`.

---

## Sources

All files fetched via `https://raw.githubusercontent.com/proxmox/<repo>/<branch>/<path>`. Local copies are in `/tmp/claude-0/-home-user-Tiny-Ecowitt-Monitor/be0b1d45-fd2d-5235-97b1-9a77a49ffc8c/scratchpad/src/` (PVE 8 copies under `src/b8/`).

| Tag | Repo / branch / path |
|---|---|
| QS9 | qemu-server/master/src/PVE/QemuServer.pm (vmstatus props L2370-2530, vmstatus L2534-2788, confdesc L240-743, check_type L1799, parse_vm_config L1990-2140) |
| QS8 | qemu-server/stable-bookworm/src/PVE/QemuServer.pm (vmstatus props L2839, vmstatus L2965, lock L299, agent_fmt L165) |
| QAPI9 / QAPI8 | qemu-server/{master,stable-bookworm}/src/PVE/API2/Qemu.pm (vmlist L1094, rrddata L1766 [9] / L1694 [8], vm_config L1809, vm_status L3457; monitor perms [8] L5651) |
| AgentAPI9 / AgentAPI8 | qemu-server/{master,stable-bookworm}/src/PVE/API2/Qemu/Agent.pm |
| Agent9 / Agent8 | qemu-server/{master,stable-bookworm}/src/PVE/QemuServer/Agent.pm (assert_agent_available L109 / agent_available L39) |
| QMPClient9, Monitor9 | qemu-server/master/src/PVE/QMPClient.pm (timeouts and error text L116-190), src/PVE/QemuServer/Monitor.pm |
| Net9, Drive9, Memory9, Machine9, CPUConfig9, MetaInfo9, QemuConfig.pm | qemu-server/master/src/PVE/QemuServer/{Network,Drive,Memory,Machine,CPUConfig,MetaInfo}.pm, src/PVE/QemuConfig.pm |
| LXC9 / LXC8 | pve-container/{master,stable-bookworm}/src/PVE/LXC.pm (props L126, vmstatus L261, get_interfaces L1285, find_lxc_pid L447) |
| LAPI9 | pve-container/master/src/PVE/API2/LXC.pm (vmlist L95, rrddata L768, interfaces L2993) |
| LSTAT9 | pve-container/master/src/PVE/API2/LXC/Status.pm L77-117 (identical on stable-bookworm) |
| LCFG9 | pve-container/master/src/PVE/API2/LXC/Config.pm L25-101 |
| LCONF9 / LCONF8 | pve-container/{master,stable-bookworm}/src/PVE/LXC/Config.pm |
| pve-container changelog | pve-container/master/debian/changelog (5.0.6 interfaces endpoint; 5.2.0 proxyto fix #5674; 5.2.6 "return all active IP addresses") |
| qemu-server changelog | qemu-server/master/debian/changelog (9.0.11 memhost and pressure; 9.1.4 cgroup memhost) |
| Cluster9 / Cluster8 | pve-manager/{master,stable-8}/PVE/API2/Cluster.pm (resources L263-560) |
| API2Tools9 / API2Tools8 | pve-manager/{master,stable-8}/PVE/API2Tools.pm (get_rrd_key L22, extract_vm_stats L81 / L104) |
| pvestatd9 / pvestatd8 | pve-manager/{master,stable-8}/PVE/Service/pvestatd.pm (update_qemu_status L328 / L274, update_lxc_status L621 / L510) |
| Nodes9 | pve-manager/master/PVE/API2/Nodes.pm L810 (node rrddata has decade) |
| Utils9 / Utils8 | pve-manager/{master,stable-8}/www/manager6/Utils.js (openConsoleWindow L1443, defaultViewer L1477, openVNCViewer L1497, renderTags L2098) |
| ConsoleButton9, qemu/Config.js 9, lxc/Config.js 9, node/Config.js 9, window/Settings.js | pve-manager/master/www/manager6/... |
| pveproxy9 | pve-manager/master/PVE/Service/pveproxy.pm L250-301 |
| HTTPServer.pm | pve-manager/master/PVE/HTTPServer.pm L221-230 |
| pwt Utils.js, pwt NotesView.js | proxmox-widget-toolkit/master/src/Utils.js L1091, src/panel/NotesView.js L90 |
| pve-xtermjs main.js | pve-xtermjs/master/xterm.js/src/main.js |
| AnyEvent.pm, Formatter/Standard.pm | pve-http-server/master/src/PVE/APIServer/AnyEvent.pm, .../Formatter/Standard.pm |
| RRD9 / RRD8 | pve-cluster/{master,stable-bookworm}/src/PVE/RRD.pm |
| status.c9 / status.c8 | pve-cluster/{master,stable-bookworm}/src/pmxcfs/status.c |
| JSONSchema.pm, ParseUtils.pm, ProcFSTools.pm, CGroup.pm, Exception.pm | pve-common/master/src/PVE/... |
| GuestHelpers.pm, AbstractConfig.pm | pve-guest-common/master/src/PVE/... |
| AccessControl9 / AccessControl8 | pve-access-control/{master,stable-bookworm}/src/PVE/AccessControl.pm; changelog 9.0.2 (drop VM.Monitor) |
| HA9 Config.pm, HAManager9, HAResources9 / HA8 Config.pm | pve-ha-manager/master/src/PVE/HA/{Config,Manager,Resources}.pm; pve-ha-manager/stable-4/src/PVE/HA/Config.pm |
| pve-qemu patches | pve-qemu/master/debian/patches/pve/0011-PVE-virtio-balloon-improve-query-balloon.patch, 0027/0031/0036/0042 (ProxmoxSupportStatus fields) |
| qemu QAPI | https://raw.githubusercontent.com/qemu/qemu/master/qga/qapi-schema.json (GuestNetworkInterface L703, GuestOSInfo L1464, GuestAgentInfo L190, GuestHostName L1335); qapi/run-state.json L57; qapi/block-core.json BlockDeviceStats; qga/commands-posix.c L1084 (MAC lowercase) |
| kernel psi.rst | https://raw.githubusercontent.com/torvalds/linux/master/Documentation/accounting/psi.rst ("The ratios (in %)") |
| ExtJS | npm `extjs-gpl@6.2.0` packages/core/src/lang/Object.js L203-209 |
| TS model (older, pre-PVE 8.4) | scratchpad/ref/proxmox-api/package/src/model.ts (`nodesLxcInterfacesIp` L5648 lacks hardware-address/ip-addresses) |
