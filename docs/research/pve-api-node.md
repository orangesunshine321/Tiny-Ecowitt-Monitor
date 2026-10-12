# Proxmox VE REST API: node and cluster endpoints (PVE 8.x and 9.x)

Reference for **pve1-dash** (read-only client and faithful mock server). Everything below was checked against
the Perl/C source of the Proxmox git mirrors on GitHub (`raw.githubusercontent.com/proxmox/...`), fetched on
2026-10-10. Line numbers refer to the files listed in **Sources**.

Source baselines:

| Repo | PVE 9 branch (`master`) | PVE 8 branch |
|---|---|---|
| pve-manager | `master`, debian/changelog head **9.2.21** (trixie) | `stable-8`, head **8.4.22** (bookworm) |
| pve-common (libpve-common-perl) | `master`, head **9.2.3** | `stable-bookworm`, head **8.3.8** |
| pve-cluster | `master`, head **9.1.6** | `stable-bookworm`, head **8.1.3** |

Tag legend: **[code]** = read directly from the source. **[inferred]** = derived from reading the code, not
observed on a live host. **UNVERIFIED** = could not be confirmed. The example JSON is **constructed from the code**
with plausible homelab values. It was not captured from a real host.

---

## 0. General conventions (all endpoints)

### 0.1 Envelope
`/api2/json/...` responses are built by `PVE::APIServer::Formatter::Standard::prepare_response_data`
(pve-http-server `src/PVE/APIServer/Formatter/Standard.pm` L14-50) [code]:

```json
{ "data": <payload> }                         // success
{ "data": <payload>, "total": N }              // only if handler set a total (not used by these endpoints)
{ "data": [...], "changes": "<diff text>" }    // GET /nodes/{n}/network with pending interfaces changes (Network.pm L414-418)
{ "data": null, "message": "...", "errors": {param: msg} }  // HTTP error; "errors" only for param errors
```

### 0.2 Auth header
`Authorization: PVEAPIToken=<user>@<realm>!<tokenid>=<uuid-secret>`. The default token prefix is
`PVEAPIToken` (pve-http-server `AnyEvent.pm` L2084) [code].

### 0.3 JSON typing caveats (Perl backend)
- **Booleans are integers `0`/`1`**, never `true`/`false`. Examples: `/cluster/status` sets `'local' => ($node eq $nodename) ? 1 : 0`
  (Cluster.pm L976), and pmxcfs emits `"online": %d` and `"quorate": %d` (pve-cluster `src/pmxcfs/status.c` L327-356). [code]
- **Some "numbers" are JSON strings.** These values are Perl regex captures that are never numified, so the encoder
  emits them as strings. Parse leniently (`Number(x)`):
  - `loadavg` items. The schema itself declares `items: string` (Nodes.pm L437-444). [code]
  - `cpuinfo.mhz`, `cpuinfo.family`, `cpuinfo.hvm`, and all `/nodes/{n}/netstat` values [inferred, UNVERIFIED on a live host].
  - Values parsed from `/etc/network/interfaces` (`mtu`, `bridge_fd`, `vlan-id`, `netmask`) [inferred].
- **Absent and null are different.** Optional fields are usually *omitted*, not `null`. RRD rows omit undefined
  columns (RRD.pm L23-30) [code].
- **Order is not guaranteed.** Example: storage `content` is built from Perl hash keys (pve-storage `Plugin.pm` L260-269). [code]

### 0.4 Privileges for a read-only token
`PVEAuditor` = every privilege group's `audit` list (pve-access-control `src/PVE/AccessControl.pm`,
`$privgroups` starting at L1057, `create_roles` L1194-1195) [code]:
`VM.Audit`, `VM.GuestAgent.Audit`, `Sys.Audit`, `Datastore.Audit`, `SDN.Audit`, `Pool.Audit`, `Mapping.Audit`.
It does **not** include `Sys.Modify` or `Sys.Syslog`.

| Endpoint | Permission check (source) | Works with PVEAuditor on `/`? |
|---|---|---|
| `GET /version` | `user => 'all'` (API2.pm L89) | yes |
| `GET /nodes` | `user => 'all'`. Stats only with `Sys.Audit` on `/nodes/{node}` (Nodes.pm L2909-2997) | yes |
| `GET /nodes/{n}/status` | `Sys.Audit` on `/nodes/{node}` (Nodes.pm L356-358) | yes |
| `GET /nodes/{n}/rrddata`, `/rrd` | `Sys.Audit` on `/nodes/{node}`. `protected => 1` (Nodes.pm L798-801, L845-848) | yes |
| `GET /nodes/{n}/netstat` | `Sys.Audit` on `/nodes/{node}` (Nodes.pm L556-558) | yes |
| `GET /nodes/{n}/network` | `user => 'all'`. Bridges are filtered by SDN permission (Network.pm L267, L470-482) | yes (SDN.Audit is included) |
| **`GET /nodes/{n}/apt/update`** | **`Sys.Modify` on `/nodes/{node}`** (APT.pm L255-257, the same on stable-8) | **NO, returns 403** |
| `GET /nodes/{n}/apt/versions` | `Sys.Audit` on `/nodes/{node}` (APT.pm L783-785) | yes |
| `GET /nodes/{n}/services` | `Sys.Audit` on `/nodes/{node}`. `protected => 1` (Services.pm L220-225) | yes |
| `GET /nodes/{n}/subscription` | `user => 'all'`. Full info only with `Sys.Audit` (Subscription.pm, `get`) | yes |
| `GET /nodes/{n}/certificates/info` | `user => 'all'` (Certificates.pm `info`) | yes |
| `GET /cluster/status` | `Sys.Audit` on `/`. `protected => 1` (Cluster.pm L871-874) | yes |
| `GET /cluster/resources` | `user => 'all'`, filtered per object (Cluster.pm L267, L538, L588, L622, L647, L673) | yes |
| `GET /nodes/{n}/disks/smart` | `Sys.Audit` on **`/`**. `protected => 1` (pve-storage `API2/Disks.pm` L180-188) | yes |

`protected => 1` means pveproxy forwards the call to pvedaemon. For API clients this is transparent.

---

## 1. `GET /api2/json/version`

Source: pve-manager `PVE/API2.pm` L85-137 (identical on stable-8) [code].

| Field | Type | Notes |
|---|---|---|
| `version` | string | Full pve-manager package version, e.g. `"9.1.4"`. Comes from `$(DEB_VERSION_UPSTREAM_REVISION)` (pve-manager `Makefile` L5). |
| `release` | string | `x.y` point release: the first two components of the upstream version (`Makefile` L4: `cut -d. -f1-2`). |
| `repoid` | string | Hex git short id. Schema pattern `[0-9a-fA-F]{8,64}`. Current builds use 16 chars (`git rev-parse --short=16`, `PVE/Makefile` L23). Builds before 8.0 used 8. |
| `console` | string, **optional** | One of `applet\|vv\|html5\|xtermjs`. Present only if set in `datacenter.cfg`. The code marks it "TODO remove with next major release", but it is still present on 9.x master. |

All three keys `version`, `release` and `repoid` are always set (L131-133). `GET /nodes/{node}/version` returns the same
three keys for one node (Nodes.pm L279-313).

```json
{ "data": { "version": "9.1.4", "release": "9.1", "repoid": "5ac30304265fbd8e", "console": "xtermjs" } }
```

---

## 2. `GET /api2/json/nodes`

Source: Nodes.pm (package `PVE::API2::Nodes`) L2908-2997. Uses `PVE::API2Tools::extract_node_stats`
(API2Tools.pm L38-79). Identical on stable-8 [code].

| Field | Type / unit | When present |
|---|---|---|
| `node` | string | always |
| `status` | `"online" \| "offline" \| "unknown"` | always. `unknown` = no RRD data for the node in the last 5 min (see 5.4). |
| `id` | string `"node/<name>"` | always (returned but not in the schema) |
| `type` | `"node"` | always (not in the schema) |
| `level` | string, subscription level code `""\|"c"\|"b"\|"s"\|"p"` | if RRD data exists (visible without Sys.Audit) |
| `cpu` | number, **fraction 0..1** of all host CPUs | online and Sys.Audit |
| `maxcpu` | integer, logical CPU count | RRD data and Sys.Audit |
| `mem` | integer **bytes** used (= `memtotal - MemAvailable`, see 3.3) | online and Sys.Audit |
| `maxmem` | integer **bytes** total RAM | RRD data and Sys.Audit |
| `disk` | integer **bytes** used on `/` (= blocks - bfree) | online and Sys.Audit (not in the schema) |
| `maxdisk` | integer **bytes** size of `/` | RRD data and Sys.Audit (not in the schema) |
| `uptime` | integer **seconds** | online and Sys.Audit |
| `ssl_fingerprint` | string `AA:BB:...` (SHA-256, 32 colon-separated bytes) | if readable |

Values come from the pvestatd broadcast (refreshed every 10 s, `pvestatd.pm` L885 `$updatetime = 10`). They do not
come from a live read.

```json
{ "data": [ {
  "id": "node/pve1", "node": "pve1", "type": "node", "status": "online", "level": "",
  "uptime": 864123, "cpu": 0.0397, "maxcpu": 6,
  "mem": 9123456000, "maxmem": 33498009600,
  "disk": 12345678848, "maxdisk": 100861726720,
  "ssl_fingerprint": "3A:91:5C:0D:7E:22:9B:41:F0:6C:11:AB:8E:7D:44:02:93:C5:61:0E:BF:72:18:4D:A6:39:E2:57:CC:08:1F:B4"
} ] }
```

---

## 3. `GET /api2/json/nodes/{node}/status`

Source: Nodes.pm L315-550 (PVE 9). Stable-8 is identical **except** that `memory.available` is missing
(diff of stable-8 vs master). The return schema declares `additionalProperties => 1` with
"TODO: document remaining ones". The field list below therefore comes from the `code` block (L493-549), not
from the schema. [code]

### 3.1 Fields

| Field | Type / unit | Source / notes |
|---|---|---|
| `uptime` | integer **seconds** | `int()` of `/proc/uptime` field 1 (ProcFSTools.pm L148-161) |
| `idle` | integer, **always `0`** | Set to 0 at L497-499 and never updated. The idle value read from `/proc/uptime` is discarded. Do not use it. |
| `loadavg` | array of 3 **strings** `["1m","5m","15m"]` | regex captures of `/proc/loadavg` (L197-206). Schema says string items. Falls back to `[0,0,0]` (numbers) if parsing fails. |
| `kversion` | string, e.g. `"Linux 6.14.11-4-pve #1 SMP PREEMPT_DYNAMIC PMX ..."` | `"$sysname $release $version"` from `uname` (L315-326). Legacy. |
| `current-kernel` | object `{sysname, release, version, machine}`, all strings | `POSIX::uname()`. `machine` e.g. `"x86_64"`. Added in pve-manager 8.1.0 (changelog L2697). |
| `boot-info` | object `{mode, secureboot?}` | `mode`: `"efi"` or `"legacy-bios"`. `secureboot`: integer `1`/`0`, **only present when EFI-booted and the SecureBoot efivar is readable** (L329-350). Added in 8.1.0, guarded in 8.1.4. |
| `cpuinfo` | object, see 3.2 | `read_cpuinfo()`, cached per process |
| `cpu` | number, **fraction 0..1** (all cores) | `read_proc_stat()->{cpu}`: (user+nice+system+irq+softirq+steal delta) / total delta (L248-332) |
| `wait` | number, **fraction 0..1** | iowait delta / total delta. **The field is `wait`. There is no `iowait` key here** (RRD uses `iowait`). |
| `memory` | object, **bytes** | `{total, used, free, available}`. **`available` is PVE 9 only** (pve-manager 9.0.0~20, changelog L1599). |
| `ksm` | object `{shared}` **bytes** | `pages_sharing * 4096` |
| `swap` | object `{total, used, free}` **bytes** | `used = total - free` |
| `pveversion` | string `"pve-manager/<version>/<repoid>"` | `package() . "/" . version_text()` (L537, `pvecfg.pm.in`) |
| `rootfs` | object `{total, used, avail, free}` **bytes** | `Filesys::Df::df('/', 1)`: `total=blocks`, `used=used` (blocks-bfree), `avail=bavail` (what non-root may use), `free=blocks-used` (= bfree, includes the root reserve) (L539-546) |

There is **no** temperature, PSI, ZFS ARC, network or fan data in this endpoint.

### 3.2 `cpuinfo` object (pve-common `ProcFSTools.pm` L74-146)
| Key | Type | Notes |
|---|---|---|
| `model` | string | `model name` line, or `"unknown"`. On arm64 (libpve-common-perl 9.2.x) it is derived from implementer/part. |
| `cpus` | integer | number of `processor` lines = logical threads |
| `sockets` | integer | distinct `physical id`, at least 1 |
| `cores` | integer | sum of `cpu cores` per socket = physical cores |
| `mhz` | string like `"2100.000"` (or number `0` if no `cpu MHz` line) | first core only [inferred string] |
| `user_hz` | integer | clock ticks (normally 100) |
| `flags` | string | space-separated CPU flags (long) |
| `hvm` | Perl boolean from a regex match. Likely `"1"`/`""` in JSON [inferred, UNVERIFIED] | VT-x/AMD-V present |
| `vendor` | string, e.g. `"GenuineIntel"`, `"AuthenticAMD"`, default `"unknown"` | **only libpve-common-perl ≥ 9.1.6** (changelog L237) |
| `family` | string (`cpu family` capture) or number `0` | **only libpve-common-perl ≥ 9.1.6** |

The schema text for `sockets` wrongly says "number of logical threads". The code counts physical ids.

### 3.3 Memory semantics (both 8.x and 9.x)
`memory.used = MemTotal - MemAvailable` (ProcFSTools.pm L407-413). This changed in **libpve-common-perl 8.3.1
(2025-04-07)**: "use the MemAvailable field ... to fix overestimation" (pve-common changelog L444-448). PVE 8
hosts running older pve-common use the older, higher formula (that formula is UNVERIFIED). `memory.free` is the raw
`MemFree`. **ZFS ARC counts as used**: ARC is not part of MemAvailable. The PVE 9 GUI subtracts the RRD `arcsize` to
show "Without ZFS ARC" (pve-manager `www/manager6/node/Summary.js` L214-231).

### 3.4 `cpu`/`wait` sampling caveat [inferred]
`read_proc_stat` keeps `$last_proc_stat` **per Perl process**. It recomputes only when
`elapsed * 100 * ncpus > 1000` ticks; otherwise it returns the previous value. The first call in a fresh process
returns `0` (ProcFSTools.pm L308-330). This endpoint is not `protected`, so it runs in whichever pveproxy worker handles the request.
Each worker has its own baseline. For a smooth CPU gauge, prefer `cluster/resources` (10 s pvestatd sample) or
`rrddata`.

```json
{ "data": {
  "uptime": 864123, "idle": 0,
  "loadavg": ["0.42", "0.51", "0.48"],
  "kversion": "Linux 6.14.11-4-pve #1 SMP PREEMPT_DYNAMIC PMX 6.14.11-4 (2025-10-10T08:04Z)",
  "current-kernel": { "sysname": "Linux", "release": "6.14.11-4-pve",
                      "version": "#1 SMP PREEMPT_DYNAMIC PMX 6.14.11-4 (2025-10-10T08:04Z)", "machine": "x86_64" },
  "boot-info": { "mode": "efi", "secureboot": 0 },
  "cpuinfo": { "user_hz": 100, "vendor": "GenuineIntel", "family": "6",
               "model": "Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz", "mhz": "2100.000",
               "cpus": 6, "sockets": 1, "cores": 6, "hvm": "1", "flags": "fpu vme de pse tsc msr ... vmx ..." },
  "cpu": 0.0423, "wait": 0.0012,
  "memory": { "total": 33498009600, "used": 9123456000, "free": 15003107328, "available": 24374553600 },
  "ksm": { "shared": 0 },
  "swap": { "total": 8589930496, "used": 0, "free": 8589930496 },
  "pveversion": "pve-manager/9.1.4/5ac30304265fbd8e",
  "rootfs": { "total": 100861726720, "used": 12345678848, "avail": 83346149376, "free": 88516047872 }
} }
```
PVE 8: drop `memory.available`, `cpuinfo.vendor` and `cpuinfo.family`.

---

## 4. `GET /api2/json/cluster/status`

Source: Cluster.pm L866-1010. Identical on stable-8 [code].

Clustered: one `type:"cluster"` entry (if `clinfo.cluster` exists) plus one `type:"node"` entry per corosync member.
Node entries come from Perl hash iteration, so their **order is random**.

| Field | Type | Applies to |
|---|---|---|
| `type` | `"cluster" \| "node"` | both |
| `id` | `"cluster"` or `"node/<name>"` | both |
| `name` | string: cluster name or node name | both |
| `nodes` | integer, node count incl. offline | cluster |
| `version` | integer, corosync config version | cluster |
| `quorate` | integer `0/1` | cluster |
| `nodeid` | integer, corosync node id | node |
| `local` | integer `0/1`: is this the responding node | node |
| `online` | integer `0/1` | node |
| `ip` | string, optional | node (only if pmxcfs knows it) |
| `level` | string subscription level, `""` if none | node (only if RRD data exists) |

**Standalone (non-clustered) node** (`$members` undefined, L991-1007): returns **exactly one** synthetic
entry and **no `cluster` entry**:
```json
{ "data": [ { "type": "node", "id": "node/pve1", "name": "pve1", "ip": "192.168.1.10",
              "local": 1, "nodeid": 0, "online": 1, "level": "" } ] }
```
Here `nodeid` is `0` and `ip` comes from `PVE::Cluster::remote_node_ip`. Use "is there a `type:cluster` entry"
as the clustered/standalone test.

Clustered example:
```json
{ "data": [
  { "type": "cluster", "id": "cluster", "name": "homelab", "nodes": 2, "version": 3, "quorate": 1 },
  { "type": "node", "id": "node/pve1", "name": "pve1", "nodeid": 1, "local": 1, "online": 1, "ip": "192.168.1.10", "level": "" },
  { "type": "node", "id": "node/pve2", "name": "pve2", "nodeid": 2, "local": 0, "online": 0, "ip": "192.168.1.11", "level": "" }
] }
```

---

## 5. `GET /api2/json/cluster/resources`

Source: Cluster.pm L262-728 (PVE 9) and stable-8 Cluster.pm L223+. Uses API2Tools.pm L21-145 [code].

### 5.1 Query parameter
`type` (optional) enum: **`vm | storage | node | sdn`** in both 8.x and 9.x (L271-276). The code also handles
`pool` and `network`, but those values are **not in the enum**, so `?type=pool` or `?type=network` should fail
parameter validation with HTTP 400 [inferred]. To get pools or network entries, call without `type` and filter
on the client.

Output order without a filter: pools, then guests (sorted by vmid string), nodes, storage (per storage, per node),
sdn, network. Do not rely on this order.

### 5.2 Common fields
`id` (string, always), `type` (always). The schema enum lists `node, storage, pool, qemu, lxc, openvz, sdn` plus
**`network` on PVE 9**.

### 5.3 Per type

**`type: "node"`**. Built by `extract_node_stats` (API2Tools.pm L38-79) plus L618-639.
| Field | Unit / notes |
|---|---|
| `id` `"node/<n>"`, `node`, `type` | |
| `status` | `online \| offline \| unknown` |
| `level` | subscription level code (`""`, `c`, `b`, `s`, `p`). Present when RRD data exists, even without Sys.Audit. |
| `cpu` | **fraction 0..1**. pvestatd `read_proc_stat` over the ~10 s cycle (pvestatd.pm L178, L234). |
| `maxcpu` | logical CPUs |
| `mem` / `maxmem` | **bytes**. `memused` / `memtotal` (pvestatd L236-237). |
| `disk` / `maxdisk` | **bytes**. Root FS used (`blocks - bfree`) / total (pvestatd L218-220). |
| `uptime` | **seconds** |
| `cgroup-mode` | integer (e.g. `2`), optional, from pmxcfs `static-info` |
| `hastate` | optional, only if the HA manager tracks the node: `online \| maintenance \| unknown \| fence \| gone` (pve-ha-manager `NodeStatus.pm` L25-31) |
| `host-arch` | optional, **PVE ≥ 9.1.10 and only on non-x86 hosts** (`aarch64`). pvestatd stores it only when the arch is not x86_64 (pvestatd.pm L161-162). The changelog calls it 'architecture', but the code key is `host-arch`. |

Stats (`cpu`, `mem`, `disk`, `uptime`, `max*`) are omitted without `Sys.Audit` on `/nodes/<n>`. **There is no `name` field on node entries.**

**`type: "qemu" | "lxc"`**. Built by `extract_vm_stats` (API2Tools.pm L81-119).
| Field | Unit / notes |
|---|---|
| `id` `"qemu/100"` / `"lxc/101"`, `vmid` (integer), `node`, `type` | |
| `status` | `"unknown"` if no RRD data. Otherwise QEMU uses `qmpstatus \|\| status` (e.g. `running`, `stopped`, `paused`) (pvestatd L341) and LXC uses `running`/`stopped`. |
| `name` | from RRD data. **Absent when status is `unknown`.** |
| `template` | integer 0/1 |
| `uptime` | seconds (0 when stopped) |
| `cpu` | **fraction 0..1 of the guest's own vCPUs**. QEMU: `(dutime/dtime * host_cpus) / guest_cpus` (qemu-server `QemuServer.pm` L2663). |
| `maxcpu` | guest vCPU count (may be fractional for cpulimit) |
| `mem`, `maxmem` | bytes |
| `memhost` | bytes, **qemu only, PVE 9 only** (only when the RRD key is `pve-vm-9.0/...`). Host-side PSS of the VM cgroup. |
| `disk`, `maxdisk` | bytes (disk usage is often 0 for VMs without guest-agent info) |
| `netin`, `netout` | **cumulative bytes since guest start** (counters, not rates) |
| `diskread`, `diskwrite` | **cumulative bytes since guest start** |
| `pool` | if the guest is in a pool and the user has Pool.Audit |
| `lock` | config lock string, optional |
| `tags` | string (`;`-separated in config) [format UNVERIFIED] |
| `hastate` | optional HA service state (`started`, `stopped`, ... ; pve-ha-manager `Manager.pm` L421-433 lists the CRM states) |

**`type: "storage"`**. Built by `extract_storage_stats` (API2Tools.pm L121-145). One entry **per storage per node**.
| Field | Notes |
|---|---|
| `id` `"storage/<node>/<storeid>"`, `storage`, `node`, `type` | |
| `plugintype` | e.g. `dir`, `lvmthin`, `zfspool`, `nfs`, `pbs`, `rbd` |
| `status` | `available` (RRD data present, meaning the storage was active in the last 5 min) or `unknown` |
| `shared` | integer 0/1. Returned on **both** 8 and 9. Added to the 9.x *schema* in 9.1.7. |
| `content` | comma-separated string, **unordered**, e.g. `"iso,vztmpl,backup"` |
| `disk`, `maxdisk` | **bytes** used / total. Only when `status == available`. |

**`type: "pool"`**. Cluster.pm L533-585: `{id: "/pool/<name>", pool, type: "pool"}`. When member guests are running
it also carries the aggregates `uptime` (max), `mem`, `maxmem`, `cpu` (maxcpu-weighted), `maxcpu`. Requires Pool.Audit.
Not reachable via `?type=`.

**`type: "sdn"`**:
- **PVE 8** (stable-8): always adds `{id:"sdn/<node>/localnetwork", sdn:"localnetwork", node, type:"sdn", status:"ok"}`
  per node (needs SDN.Audit on `/sdn/zones/localnetwork`), plus one entry per configured zone `{id:"sdn/<node>/<zone>", sdn, node, type, status}`.
- **PVE 9**: `localnetwork` **moved to `type:"network"`**. `sdn` entries are emitted only for nodes that do *not*
  publish the new `network` kv (L661-688), meaning mixed or old nodes. They gain `zone-type`. Zone `status` values
  come from pve-network `Zones.pm` `status()`: `available`, `pending`, `error`.

**`type: "network"`** (**PVE 9 only**, pve-manager 9.0.12, changelog L1372-1376). Cluster.pm L690-724.
- Always (with SDN.Audit on `/sdn/zones/localnetwork`): `{id:"network/<node>/zone/localnetwork", type:"network", "network-type":"zone", network:"localnetwork", node, status:"ok"}`.
- Per SDN zone or fabric that the node broadcasts (pvestatd.pm L780-800): `{id:"network/<node>/<network-type>/<network>", node, type:"network", "network-type":"zone"|"fabric", network, status, "zone-type"?, protocol?}`.

### 5.4 Data freshness and standalone behaviour
- All stats come from `PVE::Cluster::rrd_dump()` (pmxcfs in-memory "last value" table). pvestatd pushes every
  **10 s** (pvestatd.pm L885). pmxcfs **drops entries older than 5 min** (`status.c` L1436-1445). After that a
  node shows `status:"unknown"` and guests show `status:"unknown"` without `name`.
- **Standalone node:** `get_nodelist()` returns `[local nodename]` (pve-cluster `Cluster.pm` L309-319) and
  `get_members()` returns undef. A node with RRD data is reported `online` (`!$members` branch, API2Tools L50-52).
  Without a cluster the node can never be `offline`.

```json
{ "data": [
  { "id": "qemu/100", "type": "qemu", "vmid": 100, "node": "pve1", "name": "homeassistant", "status": "running",
    "template": 0, "uptime": 86012, "cpu": 0.0213, "maxcpu": 2, "mem": 2147483648, "maxmem": 4294967296,
    "memhost": 2368709120, "disk": 0, "maxdisk": 34359738368, "netin": 912345678, "netout": 123456789,
    "diskread": 2345678901, "diskwrite": 3456789012, "tags": "ha;iot" },
  { "id": "lxc/101", "type": "lxc", "vmid": 101, "node": "pve1", "name": "pve1-dash", "status": "running",
    "template": 0, "uptime": 86000, "cpu": 0.004, "maxcpu": 1, "mem": 104857600, "maxmem": 536870912,
    "disk": 1073741824, "maxdisk": 8589934592, "netin": 5234123, "netout": 8123456, "diskread": 0, "diskwrite": 0 },
  { "id": "node/pve1", "type": "node", "node": "pve1", "status": "online", "level": "", "cgroup-mode": 2,
    "uptime": 864123, "cpu": 0.0397, "maxcpu": 6, "mem": 9123456000, "maxmem": 33498009600,
    "disk": 12345678848, "maxdisk": 100861726720 },
  { "id": "storage/pve1/local", "type": "storage", "storage": "local", "node": "pve1", "plugintype": "dir",
    "status": "available", "shared": 0, "content": "iso,backup,vztmpl", "disk": 12345678848, "maxdisk": 100861726720 },
  { "id": "storage/pve1/local-lvm", "type": "storage", "storage": "local-lvm", "node": "pve1", "plugintype": "lvmthin",
    "status": "available", "shared": 0, "content": "rootdir,images", "disk": 40802189312, "maxdisk": 375809638400 },
  { "id": "network/pve1/zone/localnetwork", "type": "network", "network-type": "zone", "network": "localnetwork",
    "node": "pve1", "status": "ok" }
] }
```
For PVE 8, replace the last entry with `{"id":"sdn/pve1/localnetwork","sdn":"localnetwork","node":"pve1","type":"sdn","status":"ok"}` and drop `memhost`.

---

## 6. RRD: `GET /nodes/{node}/rrddata` and `GET /nodes/{node}/rrd`

Sources: Nodes.pm L795-881. pve-cluster `src/PVE/RRD.pm` (9.x full file; 8.x stable-bookworm). pmxcfs
`src/pmxcfs/status.c` L1099-1199 (9.x) and L1099-1167 (8.x). pvestatd.pm L172-294 [code].

### 6.1 Parameters
| Param | PVE 8 | PVE 9 |
|---|---|---|
| `timeframe` (required) | `hour\|day\|week\|month\|year` | `hour\|day\|week\|month\|year\|`**`decade`** |
| `cf` (optional, default `AVERAGE`) | `AVERAGE\|MAX` | `AVERAGE\|MAX` |
| `ds` (required, **`/rrd` only**) | comma list of DS names | same |

Sending `decade` to a PVE 8 node fails the enum check with 400 [inferred]. Feature-detect with `/version`.

### 6.2 RRD file, resolution and number of points returned
- PVE 8: file `/var/lib/rrdcached/db/pve2-node/<node>`. PVE 9: `pve-node-9.0/<node>`.
- Step is 60 s in both (comment in `status.c` L1100-1102).

| timeframe | PVE 8 (`RRD.pm` stable-bookworm `$setup`) | PVE 9 (`RRD.pm` master L65-72) |
|---|---|---|
| hour | 60 s × 70 | 60 s × 60 |
| day | 1800 s × 70 | **60 s × 1440** |
| week | 10800 s × 70 | 1800 s × 336 |
| month | 43200 s × 70 | 1800 s × 1440 |
| year | 604800 s × 70 | 21600 s × 1440 |
| decade | n/a | 604800 s × 570 |

- Query window: `start = floor(now/reso)*reso - reso*count`, `end = that - 1` (RRD.pm L83-117).
- PVE 9 since pve-cluster 9.0.7: the **last row is dropped if it contains only `time`** (fix #6615, L124-128).
  Earlier rows can still be time-only (all values unknown, e.g. while the host was down). Treat missing keys as gaps.
- PVE 9 since pve-cluster 9.0.7: if a pre-upgrade `pve2-node/<node>` file (or `.old`) still covers the start of the
  window, the older part is fetched **from the old file at the old resolution** and the rest from the new file
  (RRD.pm L87-111). **Point spacing can be non-uniform** in the first year after an 8→9 upgrade. Always plot by `time`.
- PVE 8 `create_rrd_data` dies with `"got wrong time resolution"` if RRD returns a different step.

### 6.3 Returned rows (node)
`data` is an array of objects. Each object has `time` plus one key per DS **that has a value**
(RRD.pm L17-33). Values are RRD floats.

| Key | Unit | PVE 8 | PVE 9 | Origin (pvestatd) |
|---|---|---|---|---|
| `time` | **unix epoch seconds** (bucket start) | ✓ | ✓ | |
| `loadavg` | 1-min load average (number) | ✓ | ✓ | `avg1` |
| `maxcpu` | logical CPU count | ✓ | ✓ | `cpuinfo.cpus` |
| `cpu` | **fraction 0..1** | ✓ | ✓ | GUI multiplies by 100 (`RRDModels.js` L1-37) |
| `iowait` | **fraction 0..1** | ✓ | ✓ | GUI ×100 |
| `memtotal` | bytes | ✓ | ✓ | |
| `memused` | bytes (= total − MemAvailable on current pve-common) | ✓ | ✓ | includes ZFS ARC |
| `swaptotal`, `swapused` | bytes | ✓ | ✓ | |
| `roottotal`, `rootused` | bytes (`blocks`, `blocks-bfree` of `/`) | ✓ | ✓ | |
| `netin`, `netout` | **bytes per second**. DS type `DERIVE` over the summed byte counters of *physical* NICs only (pvestatd L198-212). | ✓ | ✓ | |
| `memavailable` | bytes | – | ✓ | MemAvailable |
| `arcsize` | bytes (0 without ZFS) | – | ✓ | `/proc/spl/kstat/zfs/arcstats` `size` |
| `pressurecpusome` | **percent 0..100** (PSI avg10) | – | ✓ | `/proc/pressure/cpu` some |
| `pressureiosome`, `pressureiofull` | percent 0..100 | – | ✓ | `/proc/pressure/io` |
| `pressurememorysome`, `pressurememoryfull` | percent 0..100 | – | ✓ | `/proc/pressure/memory` |

Notes:
- The node RRD has **no `pressurecpufull`** (guest RRDs do). DS list: `status.c` L1107-1127.
- PSI unit: the kernel doc says "The ratios (in %)" (linux `Documentation/accounting/psi.rst` L60). The PVE GUI plots PSI
  with `unit: 'percent'` and no ×100 conversion (Summary.js L269-293, RRDModels.js L30-34).
- DERIVE stores a per-second rate: COUNTER "is stored as a per-second rate" and DERIVE "works exactly like COUNTER
  but without overflow checks" (rrdtool `doc/rrdcreate.pod` L153-182).
- PVE 9 maps a legacy `memfree` column to `memavailable` if one is present (RRD.pm L25-26, pve-cluster 9.0.6
  "cope with only partially renamed memavailable field").
- New columns appeared in pve-cluster 9.0.3 and pve-manager 9.0.0~15 (changelogs). PVE 9 RRAs:
  1 min×1440, 30 min×1440, 6 h×1440, 1 wk×570, each for AVERAGE and MAX (`status.c` L1129-1137).
  PVE 8 RRAs: 70 rows each at 1 min/30 min/3 h/12 h/7 d (`status.c` stable-bookworm L1113-1123).

```json
{ "data": [
  { "time": 1791590400, "loadavg": 0.45, "maxcpu": 6, "cpu": 0.0412, "iowait": 0.0011,
    "memtotal": 33498009600, "memused": 9123456000, "swaptotal": 8589930496, "swapused": 0,
    "roottotal": 100861726720, "rootused": 12345678848, "netin": 15234.5, "netout": 8812.3,
    "memavailable": 24374553600, "arcsize": 4294967296,
    "pressurecpusome": 0.12, "pressureiosome": 0.05, "pressureiofull": 0.03,
    "pressurememorysome": 0, "pressurememoryfull": 0 },
  { "time": 1791590460 }
] }
```
(PVE 8 rows contain only the first 13 keys.)

### 6.4 `/rrd` (PNG)
Returns `{filename, image}`. The PNG bytes are only usable via the **`/api2/png/...`** formatter, which writes
`image` with `Content-Type: image/png` (pve-http-server `Formatter/Standard.pm` L132-163). `ds` is required.
Recommendation: don't use it. Use `rrddata` and draw client-side.

---

## 7. `GET /nodes/{node}/network`

Sources: pve-manager Network.pm L42-489 (9.x). Parser: pve-common `src/PVE/Network/Interfaces.pm` L155-497 (9.x),
`INotify.pm` (8.x, same logic, e.g. L1175-1189) [code].

**Params:** `type` (optional) = one of the interface types below, or `any_bridge`, `any_local_bridge`. PVE 9 adds
`include_sdn` and `fabric`. PVE 8 enum = `bridge, bond, eth, alias, vlan, OVSBridge, OVSBond, OVSPort, OVSIntPort, vnet`
plus `any_bridge, any_local_bridge`.

**Filtering:** `lo` is always removed (L424). **Bridges (`bridge`, `OVSBridge`) are hidden unless the user has
`SDN.Audit` or `SDN.Use` on the localnetwork bridge** (`check_sdn_bridge(..., "localnetwork", <bridge>, ...)`,
L470-482; root@pam bypasses this). PVEAuditor on `/` has SDN.Audit, so bridges are visible.

**Item fields** (`hash_to_array($ifaces, 'iface')`). All optional except `iface`, `type`, `method`, `method6`, `families`, `priority`:
| Field | Type / notes |
|---|---|
| `iface` | interface name |
| `type` | `eth, bridge, bond, vlan, alias, OVSBridge, OVSBond, OVSPort, OVSIntPort, vnet, fabric, unknown`. The parser can also emit `vxlan`, `dummy`, `loopback` (Interfaces.pm L356-456). |
| `active` | integer `1` if the kernel IFF_UP flag is set. **Key is absent (not 0) when down** (L341-345, ProcFSTools L621-646). |
| `exists` | `1` for physical NICs present in `ip link`. `0`/absent otherwise. Alias/VLAN copy it from their parent. |
| `autostart` | `1` if `auto`/`allow-hotplug`. Absent otherwise. |
| `priority` | integer, order in the file |
| `families` | array of `"inet"`, `"inet6"`. Default `["inet"]`. |
| `method`, `method6` | `static\|dhcp\|manual\|loopback\|auto`. Default `manual`. |
| `address`, `netmask`, `cidr`, `gateway` | IPv4. **`netmask` is the prefix length as a string, e.g. `"24"`**, even if the config used dotted notation. `cidr` = `"a.b.c.d/nn"`. |
| `address6`, `netmask6`, `cidr6`, `gateway6` | IPv6 |
| `bridge_ports` | space-separated, **sorted** string. `""` for `bridge-ports none`. |
| `bridge_stp` | `"on"`/`"off"`. `bridge_fd` is a string, or the number `0` (default when STP is off). `bridge_vlan_aware`: `1`. `bridge_vids`: string. |
| `slaves`, `bond_mode`, `bond_xmit_hash_policy`, `bond-primary`, `bond_miimon` | bonds |
| `vlan-raw-device`, `vlan-id`, `vlan-protocol` | VLANs |
| `ovs_type`, `ovs_bridge`, `ovs_ports`, `ovs_bonds`, `ovs_options`, `ovs_tag` | OVS |
| `mtu` | value from the file (string) [inferred type] |
| `comments` | string, may contain `\n`. IPv6 comments are appended. |
| `options`, `options6` | arrays of unparsed `key value` lines |
| `altnames` | array of alternative interface names. **PVE 9 only**, not in the schema (Network.pm L478-485). |
| `link-type`, `uplink-id`, `bridge-access`, `bridge-learning`, `bridge-arp-nd-suppress`, `bridge-unicast-flood`, `bridge-multicast-flood`, `vxlan-*` | passthrough simple options |

There are **no traffic counters or link speed** in this endpoint.

```json
{ "data": [
  { "iface": "enp3s0", "type": "eth", "priority": 3, "families": ["inet"], "method": "manual", "method6": "manual",
    "exists": 1, "active": 1 },
  { "iface": "vmbr0", "type": "bridge", "priority": 4, "families": ["inet"], "method": "static", "method6": "manual",
    "autostart": 1, "active": 1, "address": "192.168.1.10", "netmask": "24", "cidr": "192.168.1.10/24",
    "gateway": "192.168.1.1", "bridge_ports": "enp3s0", "bridge_stp": "off", "bridge_fd": "0",
    "comments": "LAN bridge\n" }
] }
```

---

## 8. `GET /nodes/{node}/apt/update` (and `/apt/versions`)

Source: pve-manager APT.pm L95-291 (9.x). Same permission and fields on stable-8 [code].

- **Requires `Sys.Modify`**, so a PVEAuditor token gets 403. To show this data you would need a role with
  `Sys.Modify` on `/nodes/pve1`. That privilege also allows changing node settings, so it is a write privilege.
- The endpoint **does not run `apt update`**. It returns the cached `/var/lib/pve-manager/pkgupdates` if that is newer
  than the apt and dpkg caches (L276-285). Otherwise it recomputes from the local apt cache. The cache is refreshed
  daily by `pve-daily-update.timer` (`OnCalendar=*-*-* 1:00`, `RandomizedDelaySec=5h`) running `pveupdate`, which
  calls `update_database` (`bin/pveupdate` L75).

**Item fields** (`$assemble_pkginfo` L95-122, schema L204-248):
| Field | Type | Notes |
|---|---|---|
| `Package` | string | |
| `Title` | string | short description |
| `Description` | string | long description |
| `Version` | string | candidate (new) version |
| `OldVersion` | string, optional | installed version. **Absent for packages newly pulled in as dependencies.** |
| `Origin` | string | e.g. `Proxmox`, `Debian`, or `unknown` |
| `Section`, `Priority`, `Arch` | string | `Arch` ∈ `amd64, arm64, all, ...` |
| `NotifyStatus` | string, optional | version already notified about |

```json
{ "data": [
  { "Package": "pve-manager", "Title": "Proxmox Virtual Environment management tools",
    "Description": "This package contains the Proxmox Virtual Environment management tools.",
    "Version": "9.1.5", "OldVersion": "9.1.4", "Origin": "Proxmox",
    "Section": "admin", "Priority": "optional", "Arch": "all" }
] }
```

**Read-only alternative:** `GET /nodes/{node}/apt/versions` needs only `Sys.Audit` (APT.pm L777-953). It returns the
same fields **plus** `CurrentState` (`Installed`, `NotInstalled`, ...), `RunningKernel` (on `proxmox-ve`) and
`ManagerVersion` (on `pve-manager`), but **only for the curated list of Proxmox-relevant packages**
(proxmox-ve, pve-manager, kernels, qemu, lxc, ...). For installed packages, `OldVersion` = installed and
`Version` = candidate (L923-929), so `Version != OldVersion` means an upgrade is pending for that package
[inferred]. This does not cover plain Debian packages.

---

## 9. `GET /nodes/{node}/services`

Source: Services.pm L19-259 (9.x). stable-8 Services.pm L19-~160 [code]. Each call runs `systemctl show` per service.

**Service ids:**
- PVE 8 (19): `chrony corosync cron ksmtuned postfix pve-cluster pve-firewall pve-ha-crm pve-ha-lrm pvedaemon pvefw-logger pveproxy pvescheduler pvestatd spiceproxy sshd syslog systemd-journald systemd-timesyncd`
- PVE 9 adds (23 total): **`lxcfs`, `proxmox-firewall`, `pve-lxc-syscalld`, `qmeventd`**.

Services whose unit has no `Description` are omitted (L84). On PVE 8, `postfix` is queried as the unit `postfix@-`.
The list is cached per process.

| Field | Values |
|---|---|
| `service` | id (as above) |
| `name` | **same as `service`** (L85) |
| `desc` | systemd `Description` |
| `state` | systemd **SubState** (`running`, `dead`, `exited`, `failed`, `auto-restart`, ...). For a `oneshot` unit in `dead` it is replaced by systemd `Result` (e.g. `success`) (L123-128). Errors give `unknown`. |
| `active-state` | systemd ActiveState: `active\|inactive\|failed\|activating\|deactivating\|maintenance\|reloading\|refreshing\|unknown` |
| `unit-state` | systemd UnitFileState (`enabled`, `disabled`, `static`, `masked`, ...), or `not-found` if `LoadState=not-found` |

If `systemctl show` fails, the item contains only `state:"unknown"` (no `active-state`/`unit-state`). This is a
quirk of L117-122.

```json
{ "data": [
  { "service": "corosync", "name": "corosync", "desc": "Corosync Cluster Engine",
    "state": "dead", "active-state": "inactive", "unit-state": "enabled" },
  { "service": "pveproxy", "name": "pveproxy", "desc": "PVE API Proxy Server",
    "state": "running", "active-state": "active", "unit-state": "enabled" }
] }
```
(`desc` strings are illustrative. On a standalone node corosync is typically not running because no `corosync.conf` exists [inferred].)

---

## 10. `GET /nodes/{node}/subscription`

Source: Subscription.pm L30-125 and `get` at L128-253 (9.x). stable-8 only differs in how `serverid` is picked [code].

| Field | Type | Notes |
|---|---|---|
| `status` | enum **`new \| notfound \| active \| invalid \| expired \| suspended`** | lowercase |
| `message` | string, optional | e.g. `"There is no subscription key"` |
| `url` | string | `https://www.proxmox.com/en/proxmox-virtual-environment/pricing` |
| `serverid` | string, optional | only with Sys.Audit |
| `key` | string, optional | `pve<1|2|4|8><c|b|s|p>-[arm-]<10 hex>` (L33). **Sensitive: do not display.** |
| `level` | string, optional | `c`=Community, `b`=Basic, `s`=Standard, `p`=Premium (key pattern). Only set when `status == active`. |
| `productname`, `regdate`, `nextduedate` | string, optional | date string formats UNVERIFIED |
| `checktime` | integer, optional | unix epoch of the last check |
| `sockets` | integer | host sockets (with Sys.Audit) |
| `signature` | string, optional | offline keys |

Without Sys.Audit: only `{status, message, url}`.

```json
{ "data": { "status": "notfound", "message": "There is no subscription key",
            "url": "https://www.proxmox.com/en/proxmox-virtual-environment/pricing",
            "serverid": "8E1A0C2F5D3B4A6978E1F0D2C3B4A596" } }
```
(The `serverid` format is illustrative.) `level` in `/nodes`, `/cluster/status` and `/cluster/resources` uses
the same letter codes, or `""` when there is no subscription.

---

## 11. `GET /nodes/{node}/certificates/info`

Source: Certificates.pm `info` (identical on 8 and 9). pve-common `src/PVE/Certificate.pm` L44-104 (schema) and
L263-329 (implementation) [code].

Reads, in this order and skipping unreadable ones: `/etc/pve/pve-root-ca.pem`,
`/etc/pve/nodes/<node>/pve-ssl.pem`, `/etc/pve/nodes/<node>/pveproxy-ssl.pem`. The last one exists only with a
custom or ACME certificate.

| Field | Type | Notes |
|---|---|---|
| `filename` | string | **basename only**: `pve-root-ca.pem`, `pve-ssl.pem`, `pveproxy-ssl.pem` |
| `fingerprint` | string | SHA-256, pattern `([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}` |
| `subject`, `issuer` | string | OpenSSL `X509_NAME_oneline` format: `"/CN=.../O=..."` |
| `notbefore`, `notafter` | integer | **unix epoch seconds** |
| `san` | array of string | DNS names and IPs. IPv6 is rendered as 8 uncompressed 4-hex groups (`0000:0000:...:0001`). |
| `pem` | string | full PEM |
| `public-key-type` | string | OpenSSL short name, e.g. `rsaEncryption`, `id-ecPublicKey` |
| `public-key-bits` | integer | |

The schema marks every field optional. For dashboard expiry, use the entry whose `filename` is
`pveproxy-ssl.pem` if present, otherwise `pve-ssl.pem`. That is the certificate pveproxy serves [inferred].

```json
{ "data": [
  { "filename": "pve-root-ca.pem", "fingerprint": "5B:...:E1", "subject": "/CN=Proxmox Virtual Environment/OU=0f3c.../O=PVE Cluster Manager CA",
    "issuer": "/CN=Proxmox Virtual Environment/OU=0f3c.../O=PVE Cluster Manager CA",
    "notbefore": 1700000000, "notafter": 2015360000, "san": [], "pem": "-----BEGIN CERTIFICATE-----\n...",
    "public-key-type": "rsaEncryption", "public-key-bits": 4096 },
  { "filename": "pve-ssl.pem", "fingerprint": "3A:...:B4", "subject": "/OU=PVE Cluster Node/O=Proxmox Virtual Environment/CN=pve1.lan",
    "issuer": "/CN=Proxmox Virtual Environment/OU=0f3c.../O=PVE Cluster Manager CA",
    "notbefore": 1700000000, "notafter": 1763072000,
    "san": ["127.0.0.1", "0000:0000:0000:0000:0000:0000:0000:0001", "localhost", "pve1", "pve1.lan", "192.168.1.10"],
    "pem": "-----BEGIN CERTIFICATE-----\n...", "public-key-type": "rsaEncryption", "public-key-bits": 2048 }
] }
```

---

## 12. `GET /nodes/{node}/netstat`

Source: Nodes.pm L552-595 (identical on 8 and 9). Return schema is empty: `properties => {}` [code].

The endpoint lists **only guest tap/veth devices** matching `^(?:tap|veth)([1-9]\d*)i(\d+)$`, i.e. `tap100i0`
(QEMU) and `veth101i0` (LXC). Host NICs and bridges are **not** included.

| Field | Notes |
|---|---|
| `vmid` | guest id (regex capture, likely a JSON **string**) [inferred] |
| `dev` | `"net<N>"` |
| `in` | **cumulative bytes received by the guest** = the host-side device's *transmit* counter |
| `out` | **cumulative bytes sent by the guest** = the host-side device's *receive* counter |

Counters come from `/proc/net/dev` (ProcFSTools L459-478) and reset when the tap/veth is recreated (guest restart).
Compute rates client-side.

```json
{ "data": [ { "vmid": "100", "dev": "net0", "in": "912345678", "out": "123456789" },
            { "vmid": "101", "dev": "net0", "in": "5234123",   "out": "8123456" } ] }
```

---

## 13. Hardware sensors and temperatures

- **There is no stock sensors or temperature endpoint in PVE 8 or 9.**
  - `GET /nodes/{node}/hardware` lists only `pci` and `usb`, in both 9.2.21 master and 8.4.22 stable-8
    (`PVE/API2/Hardware.pm` L14-55) [code].
  - No `PVE/SensorInfo.pm` or `PVE/API2/Hardware/Sensors.pm` exists in pve-manager, pve-common or pve-container
    master (404). The words "sensor" and "temperature" do not appear in the pve-manager (master and stable-8),
    pve-common or pve-container changelogs [code, grep].
  - `/nodes/{node}/status` and the RRD schemas contain no temperature columns (sections 3 and 6).
- **The 2025 patch series did not land.** In October 2025, Davide Guerri posted to pve-devel an RFC
  ("[sensors] Patch proposal", around 2025-10-07) and then `[PATCH container 0/1]` / `[PATCH container 1/1]`
  (2025-10-14). These add a `PVE::SensorInfo` module reading `/sys/class/hwmon` (CPU, disk via NVMe/drivetemp,
  fans) and a read-only endpoint tree under **`/nodes/{node}/hardware/sensors/`** (temperature: cpu/disk/other;
  fan). Readings are reportedly in °C with optional thresholds and fans in RPM. These details come from search-engine
  snippets of the list archive; the archive itself was unreachable from this container, so the exact paths and fields
  are UNVERIFIED. **As of the source heads checked (pve-manager 9.2.21 / 8.4.22), nothing from that series is
  merged**, so no released 8.x or 9.x version up to those builds has it.
- **Stock workaround (disks only):** `GET /nodes/{node}/disks/smart?disk=/dev/sdX` (Sys.Audit on `/`, `protected`)
  returns `{health, type: "ata"|"text", attributes?, text?, wearout?}` (pve-storage `Diskmanage.pm` L90-173).
  ATA disks: find `attributes[]` entries with `name == "Temperature_Celsius"` (id 194) or `"Airflow_Temperature_Cel"`
  (id 190) and parse `raw` (a string, e.g. `"34 (Min/Max 20/45)"`). NVMe/SAS: parse `"Temperature: 35 Celsius"`
  out of the free-form `text` [inferred from the smartctl output format, UNVERIFIED wording]. Each call shells out to
  `smartctl` (10 s timeout), so poll it rarely.
- CPU, board and fan temperatures need an out-of-band collector, e.g. a small agent on the host exposing
  `/sys/class/hwmon` or `sensors -j`. Whether `/sys/class/hwmon` is readable from inside an unprivileged LXC is
  UNVERIFIED; test it on pve1.

---

## 14. PVE 8 → 9 differences that matter for this dashboard

| Area | PVE 8.x (stable-8 8.4.22) | PVE 9.x (master 9.2.21) | Since |
|---|---|---|---|
| node status `memory.available` | absent | present (bytes) | pve-manager 9.0.0~20 |
| node status `cpuinfo.vendor`, `.family` | absent | present | libpve-common-perl 9.1.6 |
| node `memused` semantics | `total - MemAvailable` from libpve-common-perl 8.3.1 (Apr 2025). Older: higher value. | `total - MemAvailable` | |
| rrddata `timeframe=decade` | rejected | accepted | 9.0 |
| node RRD columns | 12 + time | 19 + time (adds memavailable, arcsize, 5× pressure*) | pve-cluster 9.0.3 |
| rrddata points/resolution | 70 points per timeframe | see 6.2 (e.g. day = 1440 × 1 min) | pve-cluster 9.0.7 fixed month/year |
| cluster/resources `memhost` (qemu) | absent | present | 9.0 |
| cluster/resources localnetwork | `type:"sdn"`, id `sdn/<node>/localnetwork` | `type:"network"`, id `network/<node>/zone/localnetwork` | pve-manager 9.0.12 |
| cluster/resources `host-arch` | absent | non-x86 nodes only | 9.1.10 |
| services list | 19 ids | 23 ids (+lxcfs, proxmox-firewall, pve-lxc-syscalld, qmeventd) | 9.0 |
| network `altnames`, `type=include_sdn\|fabric` | absent | present | 9.0 |
| `/version`, `/cluster/status`, `/nodes`, certificates/info, netstat, apt/update | identical | identical | |

---

## 15. Mock-server checklist
1. Wrap every payload as `{"data": ...}`. On errors return the HTTP status with `{"data": null, "message": "..."}`.
2. Emit booleans as `0`/`1`. Emit `loadavg`, `cpuinfo.mhz` and netstat counters as strings.
3. Return 403 for `apt/update` when emulating a PVEAuditor token.
4. Standalone: `/cluster/status` returns a single node entry with `nodeid:0`, `local:1`, `online:1` and no cluster entry.
5. Provide `PVE_MAJOR=8|9` switches covering the table in section 14.
6. rrddata: emit `time` at multiples of the resolution. Occasionally omit keys (gaps). Drop the last empty row on 9.x.
7. Keep `cluster/resources` values about 10 s stale. Mark a node `unknown` if no update arrived for more than 5 min.

---

## Sources

All `raw.githubusercontent.com` files were fetched 2026-10-10. Line numbers refer to those snapshots.

**pve-manager (PVE 9 = `master`, PVE 8 = `stable-8`)**
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2.pm: `/version` L85-137 (identical on stable-8)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Nodes.pm: node `version` L279-313, kernel/boot info L315-350, `status` L352-550, `netstat` L552-595, `rrd` L795-839, `rrddata` L841-881, `/nodes` index L2908-2997
- https://raw.githubusercontent.com/proxmox/pve-manager/stable-8/PVE/API2/Nodes.pm: status L389+ (no `memory.available`), rrd/rrddata enum without `decade`, `pve2-node` path
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Cluster.pm: `resources` L262-728, `get_status` L866-1010
- https://raw.githubusercontent.com/proxmox/pve-manager/stable-8/PVE/API2/Cluster.pm: `resources` L223+ (sdn/localnetwork block), `get_status` L736+
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2Tools.pm: `get_rrd_key` L21-36, `extract_node_stats` L38-79, `extract_vm_stats` L81-119, `extract_storage_stats` L121-145 (stable-8 differs only by `memhost`)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/Service/pvestatd.pm: rrd string L129-133, static info L135-167, node RRD L172-294, qemu L328-440, storage L735-759, sdn/network kv L773-800, `$updatetime = 10` L885
- https://raw.githubusercontent.com/proxmox/pve-manager/stable-8/PVE/Service/pvestatd.pm: `pve2-node` broadcast L221
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Network.pm: type enum L42-54, confdesc L56-225, index L263-489
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/APT.pm: pkginfo L95-122, cache L124-202, props L204-248, `list_updates` L250-291, `versions` L777-953 (stable-8 `list_updates` L203-211: Sys.Modify)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Services.pm: list L19-43, state L114-138, schema L140-214, index L216-259 (stable-8 list L19-39)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Subscription.pm: key pattern L33, read L67-86, `get` L128-253
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Certificates.pm: `info` L49-83 (identical on stable-8)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/API2/Hardware.pm (and stable-8): only pci/usb
- https://raw.githubusercontent.com/proxmox/pve-manager/master/debian/changelog: 9.0.0~15 (L1668-1685), 9.0.0~20 (L1599), 9.0.12 (L1372-1383), 9.1.7 (L1019), 9.1.10 (L920-926), 8.1.0 (L2697-2703), 8.1.4 (L2624)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/PVE/pvecfg.pm.in, `/Makefile` L4-5, `/PVE/Makefile` L23
- https://raw.githubusercontent.com/proxmox/pve-manager/master/www/manager6/data/model/RRDModels.js L1-37; `/www/manager6/node/Summary.js` L160-293
- https://raw.githubusercontent.com/proxmox/pve-manager/master/bin/pveupdate L75; `/services/pve-daily-update.timer`

**pve-common**
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/ProcFSTools.pm: cpuinfo L74-146, uptime L148-161, loadavg L197-206, PSI L208-244, proc_stat L248-332, meminfo L380-439, net_dev L459-478, active ifaces L621-646
- https://raw.githubusercontent.com/proxmox/pve-common/stable-bookworm/src/PVE/ProcFSTools.pm: PVE 8 cpuinfo (no vendor/family), meminfo L298-329
- https://raw.githubusercontent.com/proxmox/pve-common/master/debian/changelog: L237 (9.1.6 vendor/family), L444-448 (8.3.1 MemAvailable)
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/Network/Interfaces.pm L155-547; `stable-bookworm/src/PVE/INotify.pm` L1175-1189
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/Certificate.pm L44-104, L263-329; `src/PVE/JSONSchema.pm` L169-175 (fingerprint pattern)

**pve-cluster**
- https://raw.githubusercontent.com/proxmox/pve-cluster/master/src/PVE/RRD.pm (full file, L1-241)
- https://raw.githubusercontent.com/proxmox/pve-cluster/stable-bookworm/src/PVE/RRD.pm (PVE 8 `create_rrd_data`)
- https://raw.githubusercontent.com/proxmox/pve-cluster/master/src/pmxcfs/status.c: clinfo JSON L322-364, node DS L1099-1142, RRD expiry L1436-1445
- https://raw.githubusercontent.com/proxmox/pve-cluster/stable-bookworm/src/pmxcfs/status.c: PVE 8 node DS/RRA L1099-1123
- https://raw.githubusercontent.com/proxmox/pve-cluster/master/src/PVE/Cluster.pm: `get_members`/`get_nodelist` L305-319, `rrd_dump` L468-501
- https://raw.githubusercontent.com/proxmox/pve-cluster/master/debian/changelog: 9.0.3, 9.0.6, 9.0.7 entries (L91-145)

**Other**
- https://raw.githubusercontent.com/proxmox/pve-access-control/master/src/PVE/AccessControl.pm L1057+, L1194-1195 (PVEAuditor)
- https://raw.githubusercontent.com/proxmox/pve-http-server/master/src/PVE/APIServer/Formatter/Standard.pm L14-50, L132-163; `.../APIServer/AnyEvent.pm` L2084
- https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Disks.pm L180-224; `src/PVE/Diskmanage.pm` L90-173; `src/PVE/Storage/Plugin.pm` L260-269
- https://raw.githubusercontent.com/proxmox/pve-network/master/src/PVE/Network/SDN/Zones.pm (`sub status`)
- https://raw.githubusercontent.com/proxmox/pve-ha-manager/master/src/PVE/HA/NodeStatus.pm L25-31; `src/PVE/HA/Manager.pm` L421-433
- https://raw.githubusercontent.com/proxmox/qemu-server/master/src/PVE/QemuServer.pm L2663 (guest cpu fraction)
- https://raw.githubusercontent.com/proxmox/proxmox-widget-toolkit/master/src/panel/RRDChart.js L63, L115-121
- https://raw.githubusercontent.com/torvalds/linux/master/Documentation/accounting/psi.rst L60 ("ratios (in %)")
- https://raw.githubusercontent.com/oetiker/rrdtool-1.x/master/doc/rrdcreate.pod L153-182 (COUNTER/DERIVE per-second rate)
- Sensors patch series (pages not fetchable from this container; details from search snippets only, UNVERIFIED):
  https://lists.proxmox.com/pipermail/pve-devel/2025-October/075850.html ,
  https://lists.proxmox.com/pipermail/pve-devel/2025-October/075982.html ,
  https://lists.proxmox.com/pipermail/pve-devel/2025-October/075984.html ,
  https://lists.proxmox.com/pipermail/pve-devel/2025-October/075985.html ,
  https://lore.proxmox.com/pve-devel/mailman.911.1760476929.390.pve-devel@lists.proxmox.com/t/
- Hint only (older apidoc model): `scratchpad/ref/proxmox-api/package/src/model.ts` (`clusterResourcesResources` L3707, `clusterStatusGetStatus` L3879, `nodesIndex` L5222, `versionVersion` L8160)
