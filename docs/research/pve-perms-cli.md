# PVE permissions, API tokens and host CLI tools (pct, qm, pveum, pveam, pvesm), PVE 8 and 9

Reference for **pve1-dash** (read-only dashboard, PVE 8.x and 9.x). Everything below was checked against Proxmox source
fetched from the GitHub read-only mirrors on **2026-10-10**. Line numbers apply to the branch heads on that date:

| repo | PVE 9 branch (`master`) | PVE 8 branch |
|---|---|---|
| pve-access-control | 9.1.2 | `stable-bookworm` 8.2.3 |
| qemu-server | 9.2.11 | `stable-bookworm` 8.4.10 |
| pve-manager | 9.2.21 | `stable-8` 8.4.22 |
| pve-container | 6.1.14 | `stable-bookworm` 5.3.6 |
| pve-storage | 9.1.13 | `stable-8` 8.3.9 |
| pve-cluster | 9.1.6 | `stable-bookworm` 8.1.3 |
| pve-common / pve-http-server / pve-docs | 9.2.3 / 6.0.5 / 9.2.13 | n/a |

Raw URL pattern: `https://raw.githubusercontent.com/proxmox/<repo>/<branch>/<path>`. Short names are used below, for example
`AC9:src/PVE/AccessControl.pm:1086` means pve-access-control@master, and a `8:` prefix means the PVE 8 branch.
Anything marked **UNVERIFIED** could not be confirmed from source.

---

## 1. Built-in role `PVEAuditor` and guest-agent privileges

### 1.1 How built-in roles are generated
`src/PVE/AccessControl.pm` holds a `$privgroups` hash. Each category (VM, Sys, Datastore, SDN, User, Pool, Mapping) has
`root` / `admin` / `user` / `audit` lists. `create_roles()` adds **every `audit` entry** to `PVEAuditor`:

```perl
for my $priv (@{ $cd->{audit} }) {
    $special_roles->{"PVEAuditor"}->{$priv} = 1;
}
```
(AC9 `src/PVE/AccessControl.pm` 1177-1204; AC8 the same function, PVEAuditor line 1191.)

### 1.2 Exact `PVEAuditor` privilege list

| PVE 8 (access-control 8.x, `stable-bookworm`) | PVE 9 (access-control 9.x, `master`) |
|---|---|
| `Datastore.Audit` | `Datastore.Audit` |
| `Mapping.Audit` | `Mapping.Audit` |
| `Pool.Audit` | `Pool.Audit` |
| `SDN.Audit` | `SDN.Audit` |
| `Sys.Audit` | `Sys.Audit` |
| `VM.Audit` | `VM.Audit` |
| (none) | **`VM.GuestAgent.Audit`** |

Sources: AC9 1085-1087 has `audit => ['VM.Audit', 'VM.GuestAgent.Audit']`. AC8 1081-1083 has `audit => ['VM.Audit']`.
The `User` category's `audit` list is empty in both. `Mapping.*` has existed since access-control 8.0.0~3 (AC8
`debian/changelog`: "add privileges and paths for cluster resource mapping"), so every PVE 8.x release has `Mapping.Audit`.

**Answer: yes, PVE 9's `PVEAuditor` includes `VM.GuestAgent.Audit`.**

### 1.3 Privilege changes from 8 to 9 (access-control changelog)
- 9.0.2: "privileges: drop VM.Monitor in favor of more granular VM.GuestAgent.* privileges".
- 9.0.3: "add VM.Replicate privilege".
- 9.1.0: "api: token: support regenerating the secret on update".
- New PVE 9 VM privileges (AC9 1056-1088):
  - admin: `VM.GuestAgent.Unrestricted`, `VM.Replicate`
  - user: `VM.GuestAgent.FileRead`, `VM.GuestAgent.FileSystemMgmt`, `VM.GuestAgent.FileWrite`
  - audit: `VM.GuestAgent.Audit`
- **`VM.Monitor` no longer exists in PVE 9.**
  - `pveum role add/modify --privs VM.Monitor` dies with `invalid privilege 'VM.Monitor'` (AC9 1222-1236, `add_role_privs`).
  - An existing `user.cfg` role that contains it is loaded with a warning and the privilege is dropped:
    `user config - ignore invalid privilege 'VM.Monitor'` (AC9 1503-1508).
  - The `pve8to9` checker fails on any custom role containing `VM.Monitor`. It explains that PVE 9 replaced it with
    `Sys.Audit` for read-only QEMU HMP monitor access and with `VM.GuestAgent.*` for the guest agent
    (pve-manager@stable-8 `PVE/CLI/pve8to9.pm` 919-944).
- In the other direction, `VM.GuestAgent.Audit` is **not** a valid privilege on PVE 8, so adding it to a role dies there.

### 1.4 Privilege needed for `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces`

| | PVE 8 (qemu-server 8.4.10) | PVE 9 (qemu-server ≥ 9.0.3) |
|---|---|---|
| Rule | `VM.Monitor` on `/vms/{vmid}` | `VM.GuestAgent.Audit` **or** `VM.GuestAgent.Unrestricted` on `/vms/{vmid}` |
| Source | QS8 `src/PVE/API2/Qemu/Agent.pm` 44-46 sets no `perms`, so the default applies at line 147: `$perm //= 'VM.Monitor'; $permission = { check => ['perm', '/vms/{vmid}', [$perm]] };` | QS9 `src/PVE/API2/Qemu/Agent.pm` 66-69 sets `perms => 'VM.GuestAgent.Audit'`; line 185: `check => ['perm', '/vms/{vmid}', [$perm, 'VM.GuestAgent.Unrestricted'], any => 1]` |
| Covered by PVEAuditor? | **No.** `VM.Monitor` is in the VM *admin* group (AC8 1070) | **Yes** |

qemu-server changelog 9.0.3 (2025-07-17): "api: agent: use more specific guest agent privileges", "api: monitor: require
Sys.Audit or Sys.Modify privilege".

On PVE 9, `VM.GuestAgent.Audit` covers the informational commands `ping`, `get-time`, `info`, `network-get-interfaces`,
`get-vcpus`, `get-fsinfo`, `get-memory-blocks`, `get-memory-block-info`, `get-host-name`, `get-osinfo`, `get-users`,
`get-timezone`, and also `fsfreeze-status` (QS9 Agent.pm 26-119). On PVE 8, every one of these needs `VM.Monitor`.

> **SECURITY WARNING (PVE 8):** `VM.Monitor` is not a read-only privilege. In qemu-server 8.4.10 it is also the only check
> on `agent/exec`, `agent/exec-status`, `agent/file-read`, `agent/file-write` and `agent/set-user-password`
> (QS8 Agent.pm 224, 281, 334, 408, 486). In practice it gives root-equivalent command execution inside every guest that
> runs an agent. It also covers the agent `shutdown` and `suspend-*` commands, and the HMP monitor (read-only `info`/`help`;
> other commands need `Sys.Modify`, QS8 `src/PVE/API2/Qemu.pm` ~5650-5680). **Do not give the dashboard token
> `VM.Monitor`.** On PVE 8, either skip guest-agent IPs or fetch them through a tightly scoped root-side helper (see §7).

Response wrapper for every agent command endpoint: `{"data": {"result": <QGA result>}}`. The code is
`return { result => $res };`.

Errors raised before the command runs (QS9 `src/PVE/QemuServer/Agent.pm` 109-114, `assert_agent_available`):
- `No QEMU guest agent configured`: no `agent` key in the config. A config of `agent: 0` passes this check and then fails
  at the next one.
- `VM <vmid> is not running`
- `QEMU guest agent is not running`: `guest-ping` failed within 3 s.

PVE 8 has the same messages in `agent_available` (QS8 `QemuServer/Agent.pm` 39-51).

QGA payload (QEMU `qga/qapi-schema.json` 635-708):
- `GuestNetworkInterface` = `{ name: str, "hardware-address"?: str, "ip-addresses"?: GuestIpAddress[], statistics?: GuestNetworkInterfaceStat }`
- `GuestIpAddress` = `{ "ip-address": str, "ip-address-type": "ipv4"|"ipv6", prefix: int }`
- `GuestNetworkInterfaceStat` = `rx-bytes`, `rx-packets`, `rx-errs`, `rx-dropped`, `tx-bytes`, `tx-packets`, `tx-errs`,
  `tx-dropped`, all uint64.

```json
{"data":{"result":[
  {"name":"lo","hardware-address":"00:00:00:00:00:00",
   "ip-addresses":[{"ip-address":"127.0.0.1","ip-address-type":"ipv4","prefix":8},
                   {"ip-address":"::1","ip-address-type":"ipv6","prefix":128}],
   "statistics":{"rx-bytes":1520,"rx-dropped":0,"rx-errs":0,"rx-packets":18,"tx-bytes":1520,"tx-dropped":0,"tx-errs":0,"tx-packets":18}},
  {"name":"ens18","hardware-address":"bc:24:11:aa:bb:cc",
   "ip-addresses":[{"ip-address":"192.168.1.50","ip-address-type":"ipv4","prefix":24},
                   {"ip-address":"fe80::be24:11ff:feaa:bbcc","ip-address-type":"ipv6","prefix":64}],
   "statistics":{"rx-bytes":91234567,"rx-dropped":0,"rx-errs":0,"rx-packets":81234,"tx-bytes":1234567,"tx-dropped":0,"tx-errs":0,"tx-packets":9876}}
]}}
```
The values above are illustrative; the field names come from the QGA schema. Windows guests also return extra
`Loopback Pseudo-Interface`-style names.

Detecting whether the agent is enabled, via the API:
- `GET /nodes/{node}/qemu/{vmid}/status/current` returns `agent: 1` **only** when it is enabled in the config, and omits
  the key otherwise (QS9 `src/PVE/API2/Qemu.pm` 3486-3490 schema, 3518 code; QS8 3382).
- `GET .../config` returns the raw property string, for example `"agent":"1"` or `"agent":"enabled=1,fstrim_cloned_disks=1"`.
  Parsing rules are in §6.4.

---

## 2. Privileges required by the endpoints the dashboard uses

All of the following are **identical in PVE 8 and PVE 9**; the two versions were diffed or both read. "Auditor OK" assumes
`PVEAuditor` on `/` with propagate on (the `pveum acl modify` default; AC9 `src/PVE/API2/ACL.pm` `update_acl`,
`my $propagate = 1`).

| Endpoint | `permissions` block (quoted) | Auditor OK? |
|---|---|---|
| `GET /nodes/{node}/disks/list` | `check => ['or', ['perm', '/', ['Sys.Audit']], ['perm', '/nodes/{node}', ['Sys.Audit']]]` (pve-storage `src/PVE/API2/Disks.pm` 88-90, both branches) | yes |
| `GET /nodes/{node}/disks/smart` | `check => ['perm', '/', ['Sys.Audit']]` (Disks.pm 186-188) | yes (needs the ACL on `/`) |
| `GET /nodes/{node}/disks/zfs` | `check => ['perm', '/', ['Sys.Audit']]` (`src/PVE/API2/Disks/ZFS.pm` 62-64). `GET .../zfs/{name}` is the same (135-137) | yes |
| `GET /nodes/{node}/apt/update` (`list_updates`) | `check => ['perm', '/nodes/{node}', ['Sys.Modify']]` (pve-manager `PVE/API2/APT.pm` 255-257; stable-8 207-209) | **NO** |
| `GET /nodes/{node}/apt/versions` | `check => ['perm', '/nodes/{node}', ['Sys.Audit']]` (APT.pm 783-785) | yes |
| `GET /nodes/{node}/tasks` | `description => "List task associated with the current user, or all task the user has 'Sys.Audit' permissions on /nodes/<node> (the <node> the task runs on).", user => 'all'` (`PVE/API2/Tasks.pm` 43-47). Code: `my $auditor = $rpcenv->check($user, "/nodes/$node", ['Sys.Audit'], 1);` (184) | yes, sees all users' tasks |
| `GET /nodes/{node}/tasks/{upid}/log` | `description => "The user needs 'Sys.Audit' permissions on '/nodes/<node>' if they aren't the owner of the task.", user => 'all'` (Tasks.pm 338-342) | yes |
| `GET /nodes/{node}/tasks/{upid}/status` | the same rule (Tasks.pm 457-461) | yes |
| `GET /cluster/backup` | `check => ['perm', '/', ['Sys.Audit']]` (`PVE/API2/Backup.pm` 187-189; stable-8 128-130) | yes |
| `GET /cluster/backup-info/not-backed-up` | `check => ['perm', '/', ['Sys.Audit']]` (`PVE/API2/Cluster/BackupInfo.pm` 71-73). The result is also filtered to VMIDs where the caller has `VM.Audit` | yes |
| `GET /nodes/{node}/storage/{storage}/content` | `check => ['perm', '/storage/{storage}', ['Datastore.Audit', 'Datastore.AllocateSpace'], any => 1]` (pve-storage `src/PVE/API2/Storage/Content.pm` 27-34) **plus a per-volume filter** (see below) | partial |
| `GET /nodes/{node}/lxc/{vmid}/interfaces` | `check => ['perm', '/vms/{vmid}', ['VM.Audit']]` (pve-container `src/PVE/API2/LXC.pm` 2998-3000) | yes |
| `GET /nodes/{node}/network` | `permissions => { user => 'all' }` (`PVE/API2/Network.pm` 267). Only SDN fabrics are filtered, by `SDN.Audit/Use/Allocate` | yes (any authenticated id) |
| `GET /nodes/{node}/certificates/info` | `permissions => { user => 'all' }` (`PVE/API2/Certificates.pm` 53) | yes |
| `GET /nodes/{node}/subscription` | `permissions => { user => 'all' }` (`PVE/API2/Subscription.pm` 134). The code limits the fields returned without `Sys.Audit` (see below) | yes, full data |
| `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` | see §1.4 | PVE 9 yes / PVE 8 **no** |
| extra: `GET /nodes/{node}/status`, `/rrddata`, `/netstat` | `check => ['perm', '/nodes/{node}', ['Sys.Audit']]` (Nodes.pm 357, 847, 557) | yes |
| extra: `GET /cluster/resources` | `permissions => { user => 'all' }` (Cluster.pm 267). The result is filtered per object | yes |
| extra: `GET /cluster/nextid` | `permissions => { user => 'all' }` (Cluster.pm 1018) | yes |
| extra: `GET /access/permissions` | `user => 'all'`. Each id may dump its own permissions (AC9 `src/PVE/API2/AccessControl.pm`) | yes. Use it at startup to self-check capabilities |
| extra: `GET /version` | `permissions => { user => 'all' }` (pve-manager `PVE/API2.pm` 86-89) | yes |

### 2.1 Behaviours that matter for the dashboard

**`/apt/update` needs `Sys.Modify`.** `Sys.Modify` is a *root-group* privilege (AC9 1089-1095, `Sys` root list), so a
read-only token **cannot** list pending updates. Workarounds:
1. Read the cache that the API itself serves, `/var/lib/pve-manager/pkgupdates` (APT.pm 125). It is a JSON array with the
   same objects as the API (`decode_json` at 125-131) and is refreshed by `pveupdate`/`update_database`. Read it with
   `cat` through the root SSH helper (§7).
2. Or show only `GET /apt/versions` (`Sys.Audit`).

**Storage content is filtered silently.** `GET .../storage/{s}/content` runs `PVE::Storage::check_volume_access` on every
volume and drops the ones that fail, with no error (Content.pm code; pve-storage `src/PVE/Storage.pm` 619-663):

| vtype | Needed to see it | With PVEAuditor |
|---|---|---|
| any volume | short-circuit if `Datastore.Allocate` on `/storage/{sid}` | n/a |
| `iso`, `vztmpl`, `import` | `Datastore.AllocateSpace` or `Datastore.Audit` | visible |
| `backup` (with owner vmid) | `Datastore.AllocateSpace` on storage **and** `VM.Backup` on `/vms/<owner>` | **hidden** |
| `images` / `rootdir` | `Datastore.Audit` **and** `VM.Config.Disk` on `/vms/<owner>` | **hidden** |
| `snippets` | requires a typed request, so it is never listed | hidden |

So listing backups with PVEAuditor returns `[]`, not 403. This is the same on 8 and 9. The PVE 9 snippets branch is new,
but on PVE 8 snippets fall through to `die "missing privileges"`, so they are hidden there too. For backup status use
`GET /cluster/backup-info/not-backed-up` and `GET /nodes/{node}/tasks?typefilter=vzdump`, both `Sys.Audit`. A
read-only way to list backup files does not exist: every option needs `VM.Backup`, `Datastore.AllocateSpace` or
`Datastore.Allocate`, and none of those are read-only.

Since PVE 9, content items carry an integer `approximate-size`. Content.pm (9) loops over
`qw(approximate-size size used vmid)` and `int()`s each; PVE 8 does only `vmid`, `size`, `used`.

**Subscription.** Without `Sys.Audit` the response is only `{status, message, url}`; with it you get the full record.
`status` enum: `new|notfound|active|invalid|expired|suspended`. Optional fields: `checktime`, `key`, `level`, `message`,
`nextduedate`, `productname`, `regdate`, `serverid`, `signature`, `sockets`, `url` (Subscription.pm 129-254).
Note that PVEAuditor can read the subscription **`key`**.

**Tasks list fields.** Schema fields (Tasks.pm 116-139; fields at 121-136):
- `upid`, `node`, `pid`, `pstart`, `starttime` (epoch), `type`, `id`, `user`: always present.
- `endtime` (epoch) and `status`: optional, absent while running. Status is the string `OK`, an error text, or
  `WARNINGS: n`. Active tasks get `RUNNING` when `source=active|all`.

For tasks started by an API token, `$convert_token_task` splits `user@realm!tok` into `user` and an **extra, undocumented
`tokenid`** field (Tasks.pm top). A mock should emit `tokenid` sometimes.

Params: `start` (0), `limit` (50), `userfilter`, `typefilter`, `vmid`, `errors`, `source` (`archive|active|all`),
`since`, `until`, `statusfilter`. The response has a top-level `total` (set via `set_result_attrib('total', $count)`).

**Task log.** `GET .../tasks/{upid}/log?start=0&limit=50` returns `[{"n":1,"t":"line text"}, ...]` plus a top-level
`total`. `download=1` streams the file (gzip when it is larger than 1024 bytes) and cannot be combined with
`start`/`limit` (Tasks.pm 347-450).

**`/cluster/backup-info/not-backed-up`** returns `[{ vmid: int, type: "qemu"|"lxc", name?: str }]`
(BackupInfo.pm 78-140).

**LXC `/interfaces`** (both versions, pve-container `src/PVE/LXC.pm` 1285-1325). The container runs
`nsenter -t <pid> --net -- ip --json a`. Each entry looks like:

```
{ name, "hardware-address", hwaddr (legacy dup),
  inet?: "a.b.c.d/len", inet6?: "x::y/len",
  "ip-addresses": [{ "ip-address", "ip-address-type", prefix }] }
```

- **`ip-address-type` is `"inet"` / `"inet6"`**, copied from iproute2's `family` (iproute2 `lib/utils.c` 1079-1091).
  It is **not** `ipv4`/`ipv6` as in QGA.
- The legacy `inet`/`inet6` keys only hold the *last* address of that family.
- `lo` is included.
- A stopped container returns `data: null` (the code is `return if $@` after `find_lxc_pid`).

```json
{"data":[
 {"name":"lo","hwaddr":"00:00:00:00:00:00","hardware-address":"00:00:00:00:00:00","inet":"127.0.0.1/8","inet6":"::1/128",
  "ip-addresses":[{"ip-address":"127.0.0.1","ip-address-type":"inet","prefix":8},{"ip-address":"::1","ip-address-type":"inet6","prefix":128}]},
 {"name":"eth0","hwaddr":"bc:24:11:12:34:56","hardware-address":"bc:24:11:12:34:56","inet":"192.168.1.60/24","inet6":"fe80::be24:11ff:fe12:3456/64",
  "ip-addresses":[{"ip-address":"192.168.1.60","ip-address-type":"inet","prefix":24},{"ip-address":"fe80::be24:11ff:fe12:3456","ip-address-type":"inet6","prefix":64}]}
]}
```

**Certificates info item** (pve-common `src/PVE/Certificate.pm` 44-100, 263-320). Each item has `filename`,
`fingerprint` (SHA-256, **uppercase hex with colons**; Net::SSLeay `SSLeay.xs` ~4625 `"%02X:"`), `subject`, `issuer`
(OpenSSL oneline format), `notbefore`, `notafter` (epoch seconds), `san` (string array; IPs rendered as dotted or
colon-hex), `pem`, `public-key-type`, `public-key-bits`. All fields are optional.

The files checked are, in order, `/etc/pve/pve-root-ca.pem`, `/etc/pve/nodes/<node>/pve-ssl.pem` and
`/etc/pve/nodes/<node>/pveproxy-ssl.pem`; missing files are skipped (Certificates.pm 72-81).

### 2.2 Error shape a mock should copy
- A permission failure is HTTP **403** with message `Permission check failed (<path>, <priv>)`. With several privileges
  they are joined by `|` (AC9 `src/PVE/RPCEnvironment.pm` 300, 325; pve-common `src/PVE/Exception.pm` 53-62).
- In JSON format, pve-http-server ≥ 5.2.0 (late PVE 8 and all PVE 9) puts the message in the body:
  `{"data":null,"message":"Permission check failed (/nodes/pve1, Sys.Modify)\n"}` (pve-http-server
  `src/PVE/APIServer/Formatter/Standard.pm` 14-51; changelog 5.2.0 "fix #6503: return error messages from the API also
  for the json formatter").
- Older PVE 8 returns only `{"data":null}`, with the text in the HTTP reason phrase.
- Parameter errors add `"errors":{"param":"msg"}`.

---

## 3. API token authentication

### 3.1 Header (verified in code and docs)
```
Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET
```
Example: `Authorization: PVEAPIToken=pve1dash@pve!dashboard=0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f`

- Docs: "set the HTTP header 'Authorization' to the displayed value of the form `PVEAPIToken=USER@REALM!TOKENID=UUID`"
  (pve-docs `pveum.adoc` 114-116).
- Extraction (pve-http-server `src/PVE/APIServer/Formatter.pm` 78-88):
  `($header =~ /(?:^|\s)\Q$key\E(?:=| )([^;]*)/)[0]`, then `uri_unescape`, with `$key = 'PVEAPIToken'`
  (AnyEvent.pm 2084). So `PVEAPIToken ` followed by a space is also accepted, and the value ends at the first `;`.
- The token check is used only when no `PVEAuthCookie` ticket was found (AnyEvent.pm 1576-1597).
- Split (AC9 `src/PVE/AccessControl.pm` 493): `/^(.*)=(.*)\z/` is greedy, so the separator is the **last** `=`. The
  secret is a UUID and contains no `=`.
- Token id regex: `<user>@<realm>!<tokenname>`, where tokenname matches `[A-Za-z][A-Za-z0-9\.\-_]+` (at least 2 chars,
  must start with a letter) (AC9 280-287; `src/PVE/Auth/Plugin.pm` 34-35).
- Validation (AC9 487-512, `verify_token`):
  - The user must exist and be enabled, and the token must exist. Errors: `token '<name>' access expired`,
    `invalid token value!`. Every failure reaches the client as HTTP 401 `Authentication failed!`
    (pve-manager `PVE/HTTPServer.pm` 85-91).
- **No CSRF token is needed** for non-GET requests made with a token (HTTPServer.pm 120-128).
- Endpoints without `allowtoken` reject tokens with `URI '...' not available with API token, need proper ticket.`
  (HTTPServer.pm 170-171). These are only console and ticket style calls.
- The secret is generated by `UUID::uuid()` (pve-access-control `src/PVE/TokenConfig.pm` `generate_token`) and stored in
  `/etc/pve/priv/token.cfg` as `<full-tokenid> <uuid>`, one line each. Lowercase output is **UNVERIFIED** but libuuid
  normally prints lowercase. Treat the secret as an opaque string.

### 3.2 Privilege separation (`privsep`)
- Option `token-privsep`: boolean, **default 1** ("Restrict API token privileges with separate ACLs (default), or give
  full privileges of corresponding user.") (AC9 `src/PVE/API2/User.pm` 96-105; `generate_token` line 813
  `$token->{privsep} = defined($param->{privsep}) ? $param->{privsep} : 1;`).
- Effective permissions (AC9 `src/PVE/RPCEnvironment.pm` 99-108 and 131-175):
  - `privsep=0`: the token has exactly the **user's** privileges.
  - `privsep=1`: the token's own ACL privileges **intersected** with the user's privileges on the same path. The
    propagate flags are ANDed.
- Docs: "Separated privileges: The token needs to be given explicit access with ACLs. Its effective permissions are
  calculated by intersecting user and token permissions" and "privilege separated tokens can never have permissions on any
  given path that their associated user does not have" (`pveum.adoc` 100-102, 983-984).
- **Consequence: with privsep=1 you need two ACL entries**, one for the user and one for the token. With only the token
  ACL the token has no privileges.
- Token `expire`: epoch seconds, `0` means none, the default is the user's expiry (User.pm 85-95).

---

## 4. `pveum` commands (the same on PVE 8 and 9)

CLI facts (AC9 `src/PVE/CLI/pveum.pm`, pve-common):
- Parameters accept `--name value` and `-name value` (Getopt::Long `prefix_pattern=(--|-)`). Unique abbreviations work,
  which is why the docs' `-token` / `-role` match `tokens` / `roles`.
- Booleans accept `1|on|yes|true|0|off|no|false`, and a bare `--privsep` means 1 (pve-common
  `src/PVE/JSONSchema.pm` 1061-1066, 2528-2534).
- List-valued options (`--privs`, `--roles`, `--tokens`, `--users`) split on commas, semicolons or whitespace
  (pve-common `src/PVE/ParseUtils.pm` 49-58).
- `--output-format text|json|json-pretty|yaml`. JSON output is `to_json(..., {canonical=>1})`: one line, **sorted keys**,
  trailing newline (pve-common `src/PVE/CLIFormatter.pm` 364-390).
- **Custom role IDs must not start with `PVE` (case-insensitive)**, or creation fails with `cannot use role ID starting
  with the (case-insensitive) 'PVE' namespace` (AC9 `src/PVE/API2/Role.pm`, `create_role`; AC8 96-99). A name like
  `pve1dash-agent` would be rejected.

### 4.1 Create the user
```bash
pveum user add pve1dash@pve --comment "pve1-dash read-only dashboard"
```
- `password` is **optional**; it is only set when given, and must be 8-64 chars if it is (User.pm `create_user`).
- With no password, a `@pve` user cannot log in to the GUI, but tokens still work.
- `enable` defaults to 1.
- Running it again fails with `create user failed: user 'pve1dash@pve' already exists`.

### 4.2 Create the token (privsep) and capture the secret
```bash
OUT=$(pveum user token add pve1dash@pve dashboard --privsep 1 --comment "pve1-dash" --output-format json)
# OUT (single line, keys sorted):
# {"full-tokenid":"pve1dash@pve!dashboard","info":{"comment":"pve1-dash","privsep":1},"value":"0b4c5d2e-1f3a-4b6c-8d9e-0a1b2c3d4e5f"}
SECRET=$(printf '%s' "$OUT" | perl -MJSON -0777 -ne 'print decode_json($_)->{value}')
TOKENID=$(printf '%s' "$OUT" | perl -MJSON -0777 -ne 'print decode_json($_)->{"full-tokenid"}')
```
- The return schema is exactly `{ info: {expire?, privsep?, comment?}, value: string, "full-tokenid": "<userid>!<tokenid>" }`
  (User.pm 772-788, 823-828; identical on 8, diffed). The model.ts `accessUsersTokenGenerateToken` agrees.
- `info.privsep` is the number `1`: `parse_boolean` returns 1, and the default literal is also 1.
- `info.comment` is present only if non-empty, `info.expire` only if given.
- **`value` is shown only once.** Creating it again fails with `tokenid: Token already exists.` (HTTP 400 param error).
- `perl` and its `JSON` module are always present on PVE, because the PVE stack is Perl and uses `JSON`. `jq` being
  installed by default is **UNVERIFIED**, so do not depend on it.
- Rotation on **PVE ≥ 9.1** (access-control 9.1.0): `pveum user token modify pve1dash@pve dashboard --regenerate 1
  --output-format json` returns `{..., "full-tokenid": ..., "value": ...}` (User.pm 833-935). On PVE 8 and 9.0, delete
  with `pveum user token delete pve1dash@pve dashboard` and add it again, then **run the token `acl modify` again**
  (it is idempotent).
  - `remove_token` does not touch ACLs (User.pm `remove_token`). However, when `user.cfg` is parsed, ACL entries for a
    token that does not exist are dropped with `user config - ignore invalid acl token '<id>'` (AC9 1545-1552), and they
    disappear on the next write.
- Listing tokens: `pveum user token list pve1dash@pve --output-format json` returns
  `[{"tokenid":"dashboard","privsep":1,"comment":"..."}]`.

### 4.3 ACLs: the user AND the token
```bash
pveum acl modify / --users pve1dash@pve --roles PVEAuditor
pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor
```
- Parameter names are `path` (positional), `users`, `groups`, `tokens`, `roles` (required), `propagate` (default 1) and
  `delete` (AC9 `src/PVE/API2/ACL.pm`, `update_acl`). At least one of users, groups or tokens is required.
- Single-quote the token id: `!` triggers history expansion in interactive bash.
- Verify with:
  - `pveum user token permissions pve1dash@pve dashboard [--path /]`
  - `pveum user permissions pve1dash@pve`
  - from the API, `GET /access/permissions`.

### 4.4 Optional guest-agent role (PVE 9 only; nothing to do on PVE 8)
- PVE 9: `PVEAuditor` already includes `VM.GuestAgent.Audit`, so no extra role is needed.
- PVE 8: the only privilege that unlocks agent endpoints is `VM.Monitor`, which grants guest exec (see §1.4).
  **Recommendation: do not create it.** If the user insists, accept the risk explicitly and use a non-`PVE` name:
  ```bash
  pveum role add DashAgentPVE8 --privs "VM.Monitor"     # PVE 8 only; would fail on PVE 9 ("invalid privilege")
  pveum acl modify /vms --users pve1dash@pve --roles DashAgentPVE8
  pveum acl modify /vms --tokens 'pve1dash@pve!dashboard' --roles DashAgentPVE8
  ```

### 4.5 Version and feature detection in shell
```bash
# major version from pveversion (format in §8)
PVE_MAJOR=$(pveversion | sed -nE 's#^pve-manager/([0-9]+)\..*#\1#p')

# feature probe (preferred): VM.GuestAgent.Audit exists only on PVE >= 9
if pveum role list --output-format json | grep -q '"VM.GuestAgent.Audit'; then HAS_GA_AUDIT=1; else HAS_GA_AUDIT=0; fi
```
- `pveum role list` returns `[{roleid, privs: "<comma,joined,sorted>", special: 0|1}]` (AC9 `src/PVE/API2/Role.pm`,
  index). PVEAuditor's `privs` on PVE 9 is `"Datastore.Audit,Mapping.Audit,Pool.Audit,SDN.Audit,Sys.Audit,VM.Audit,VM.GuestAgent.Audit"`.
- **UNVERIFIED:** whether `special` is serialized as `1`/`0` or `true`/`false`. Do not parse it.

---

## 5. `pct`, `pveam`, `pvesm`, next free VMID

pct is pve-container `src/PVE/CLI/pct.pm`. Lines cited are from master; `list`, `status` and `exec` are byte-identical on
`stable-bookworm` (diffed).

### 5.1 `pct list`
```perl
my $format = "%-10s %-10s %-12s %-20s\n";
printf($format, 'VMID', 'Status', 'Lock', 'Name');   # sorted by vmid; prints NOTHING if no CTs
```
(pct.pm 1057-1071)
```
VMID       Status     Lock         Name                
101        running                 pve1-dash           
102        stopped    backup       pihole              
```
- Lines have trailing spaces, and the **Lock column is usually empty**, so splitting on whitespace is ambiguous. Prefer
  `pvesh get /nodes/$(hostname)/lxc --output-format json`.
- `pvesh` prints JSON with `--output-format json`; the default `text` prints bordered tables (pve-manager
  `PVE/CLI/pvesh.pm` 460).

### 5.2 `pct exec <vmid> [--keep-env 0|1] -- <cmd> [args...]`
pct.pm 215-255:
- Loads the config, then dies `container '<vmid>' not running!` if the CT is stopped, and dies `missing command` with no
  command.
- Removes `SSL_CERT_FILE` and `SSL_CERT_DIR` from the environment (`clean_environment`, 162-169).
- Then `exec('lxc-attach', '-n', $vmid, ($keep_env ? '--keep-env' : '--clear-env'), '--', @cmd)`.
- **`--keep-env` defaults to 1 on BOTH 8 and 9** ("FIXME: switch to default 0 with pve 9" is still in master). The host
  environment, including `SSH_*` variables when called from SSH, leaks into the CT. Pass `--keep-env 0` to get
  `--clear-env`, after which only `container=lxc` is set (lxc `doc/lxc-attach.sgml.in` 222-232). Use absolute paths in
  that case; the PATH behaviour with clear-env is **UNVERIFIED**.
- Runs as **uid 0 inside the CT** (lxc-attach's default user). It works for unprivileged CTs, where uid 0 maps to host
  uid 100000 by default.
- **Exit code:** pct `exec()`s lxc-attach, which exits with the command's exit status, or 128+signal (lxc
  `src/lxc/tools/lxc_attach.c` 446-456). If attaching fails, lxc-attach exits 1 (`EXIT_FAILURE`). A pct-side `die`
  (CT not running) exits non-zero, typically 255 (Perl `die`).
- stdin, stdout and stderr pass straight through. Use `--` before commands that take `-` options.

### 5.3 `pct status <vmid> [--verbose]`
pct.pm 47-86:
- Prints `status: running` or `status: stopped` (falls back to `unknown`).
- `--verbose` prints every non-undef `vmstatus` key as `key: value`, sorted, skipping `cpu`.
- Dies if the CT does not exist on this node.

### 5.4 `pct config <vmid>`
pct.pm 1073-1093:
- Prints `key: value` lines **sorted by key**, skipping `digest`.
- `description` is percent-encoded (`encode_text`).
- Raw `lxc.*` entries are printed last.

Illustrative output (values made up):
```
arch: amd64
cores: 1
features: nesting=1
hostname: pve1-dash
memory: 512
net0: name=eth0,bridge=vmbr0,hwaddr=BC:24:11:12:34:56,ip=dhcp,type=veth
onboot: 1
ostype: debian
rootfs: local-lvm:vm-120-disk-0,size=4G
swap: 512
tags: dashboard
unprivileged: 1
```
The ordering of sub-keys inside `net0`/`rootfs` is illustrative only (**UNVERIFIED**).

### 5.5 `pct create`: Debian 13, unprivileged
```bash
pct create "$VMID" "local:vztmpl/$TEMPLATE" \
  --hostname pve1-dash \
  --cores 1 --memory 512 --swap 512 \
  --rootfs "$STORAGE:4" \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 --start 1 --ostype debian \
  --ssh-public-keys /root/pve1dash_ct_keys.pub \
  --tags dashboard
# optional: --password 'secret' (min 5 chars), or a bare --password to be prompted interactively
```
Option facts (pve-container `src/PVE/LXC/Config.pm` and `src/PVE/API2/LXC.pm` `create_vm`):

| option | type and unit | note |
|---|---|---|
| positional `ostemplate` | `<storage>:vztmpl/<file>` | max 255 chars |
| `--hostname` | dns-name, ≤255 | |
| `--cores` | int 1..8192 | the default is all host cores |
| `--memory` | int, **MB**, ≥16 | default 512 |
| `--swap` | int, **MB**, ≥0 | default 512 |
| `--rootfs` | `STORAGE_ID:SIZE_IN_GiB` allocates a new volume ("Use the special syntax STORAGE_ID:SIZE_IN_GiB") | the storage must have content `rootdir` |
| `--net0` | `name=<ifname>` (required), `bridge=`, `ip=<IPv4/CIDR\|dhcp\|manual>`, `gw=`, `ip6=<IPv6/CIDR\|auto\|dhcp\|manual>`, `gw6=`, `hwaddr=`, `mtu=`, `firewall=`, `tag=`, `type=veth`, … (Config.pm 853-950) | |
| `--unprivileged` | bool | **PVE 8 API default is 0 (privileged)** (8: Config.pm 648-654). PVE 9 defaults to 1 on create (9: LXC.pm 272 `$unprivileged = 1 if !defined`; changelog "api: create CT: default to unprivileged containers"). **Always pass `--unprivileged 1`.** Privileged CTs need `Sys.Modify` on `/` |
| `--features` | `nesting=1`, `keyctl=1`, `fuse=1`, `mknod=1`, `mount=fs;fs`, `force_rw_sys=1` | |
| `--onboot` | bool, default 0 | |
| `--start` | bool, default 0 | starts the CT after a successful create, inside the create worker |
| `--ostype` | `debian\|devuan\|ubuntu\|centos\|fedora\|opensuse\|archlinux\|alpine\|gentoo\|nixos\|unmanaged` | optional; detected from the template if omitted |
| `--password` | string ≥5 | CLI mapping: with a value it uses the value; bare it prompts; omitted means no root password |
| `--ssh-public-keys` | **file path** on the CLI; the CLI reads the file. The API takes the key text, one key per line | pct.pm 88-98 + pve-common RESTHandler.pm 687-697 (`<filepath>`, `file_get_contents`) |
| `--tags` | `pve-tag-list`; each tag matches `[a-z0-9_][a-z0-9_\-\+\.]*` (case-insensitive); separated by `,` `;` or space | pve-common JSONSchema.pm 890-898 |
| `--storage` | default `local` | only used for volumes given without an explicit storage |

- Exit code: pct runs the create task synchronously, then `$upid_exit` exits **0 on success and -1 (255) if the task
  status is an error** (pct.pm 36-40). Output is the task log.
- **Debian 13 container support:** the setup code accepts Debian ≤ 14.x. `DEBIAN_MAXIMUM_RELEASE => 14` is a soft limit
  (master and stable-bookworm `src/PVE/LXC/Setup/Debian.pm` 17-19).
  - This needs **pve-container ≥ 6.0.10 on PVE 9** or **≥ 5.3.1 on PVE 8** ("setup: debian: increase upper supported
    version limit from <= 13 to < 15 to ensure all points releases of Debian 13 … get accepted", both 2025-09-07).
  - Older hosts fail on 13.1 templates with "unsupported debian version '13.1'", as reported in forum threads (see
    Sources).

### 5.6 `pveam`
pve-manager `PVE/CLI/pveam.pm` and `PVE/APLInfo.pm`.

**`pveam update`**
- Downloads the index from `http://download.proxmox.com/images/aplinfo-pve-9.dat` (PVE 9) or `aplinfo-pve-8.dat`
  (PVE 8), checking a GPG `.asc` against `/usr/share/doc/pve-manager/trustedkeys.gpg`, plus the TurnKey index
  `https://releases.turnkeylinux.org/pve/aplinfo.dat` (APLInfo.pm 148-215).
- Prints `update successful` (stdout) or `update failed - see /var/log/pveam.log for details` (stderr).
- **Exit code is 0 in both cases** (the method returns `undef`; pveam.pm 37-50), so check the text.
- Cached under `/var/lib/pve-manager/apl-info/<host>`.

**`pveam available [--section system|mail|turnkeylinux]`**
- One line per template, sorted by section, then by name (Perl `sort`).
- PVE 8: `sprintf("%-15s %s\n", $section, $template)` (stable-8 pveam.pm 80).
- PVE 9 ≥ 9.2.7: `sprintf("%-15s %-60s %s\n", $section, $template, $arch)` (master pveam.pm 82). Changelog 9.2.7:
  "show the appliance template architecture in 'pveam available'".
- In **both**, the template name is the 2nd whitespace-separated field.

```
system          debian-13-standard_13.1-2_amd64.tar.zst                      amd64
```
(PVE 8 line: `system          debian-13-standard_13.1-2_amd64.tar.zst`)

Picking the newest Debian 13 standard template:
```bash
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '$2 ~ /^debian-13-standard_.*_amd64\.tar\.(zst|gz|xz)$/ {print $2}' | sort -V | tail -n1)
[ -n "$TEMPLATE" ] || { echo "no debian-13-standard template in index"; exit 1; }
```
- Name pattern `debian-13-standard_<13.x>-<rel>_amd64.tar.zst`. Forum posts mention `13.0-1`, `13.1-1` and `13.1-2`.
  The exact current version is **UNVERIFIED**, because download.proxmox.com is unreachable from here.
- Whether the **PVE 8** index (`aplinfo-pve-8.dat`) lists `debian-13-standard` at all is **UNVERIFIED**. Fall back to
  `debian-12-standard_` if empty.

**`pveam download <storage> <template>`**
- Calls the API `apl_download` (pve-manager `PVE/API2/Nodes.pm`). It needs `Datastore.AllocateTemplate`, the storage must
  allow `vztmpl`, and it errors with `no such template` if the name is not in the index. The hash is verified
  (sha512/md5 from the index).
- Runs a synchronous worker that prints the task log, ending with `TASK OK` or `TASK ERROR: …` (pve-common
  `src/PVE/RESTEnvironment.pm` 652-667).
- **There is no exit-code handler** in pveam's cmddef, so the exit status is probably 0 even when the download fails.
  This is inferred from code and **UNVERIFIED** by execution. Verify with `pveam list <storage>` afterwards.

**`pveam list <storage>`** (pveam.pm 199-205; the API needs `Datastore.AllocateTemplate`, and the storage must allow
`vztmpl`):
```
NAME                                                         SIZE  
local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst         123.58MB
```
(`%-60s %-6s` header; rows `%-60s %-4.2fMB`, where MB = size/1024/1024)

### 5.7 Storages that can hold templates or CT disks: `pvesm status`
`pvesm status [--content <type[,type]>] [--enabled 1] [--storage ID]` (pve-storage `src/PVE/CLI/pvesm.pm` 244-274, 641).
- Header format: `"%-${maxlen}s %10s %10s %15s %15s %15s %8s\n"` with `Name Type Status 'Total (KiB)' 'Used (KiB)'
  'Available (KiB)' %`. `maxlen` = longest storage id + 1.
- Row format: `%15d` KiB values and a percentage `% 7.2f%%`. Status is `active`, `inactive` or `disabled`; a disabled
  storage shows `N/A` for the percentage.
```
Name             Type     Status     Total (KiB)      Used (KiB) Available (KiB)        %
local             dir     active        98497780        12345678        81098765   12.53%
local-lvm     lvmthin     active      1855602688       123456789      1732145899    6.65%
```
- Templates need `--content vztmpl`; CT root disks need `--content rootdir`.
- Machine-readable equivalent:
  `pvesh get /nodes/$(hostname)/storage --content rootdir --enabled 1 --output-format json`, which returns
  `[{storage, type, content, enabled?, active?, shared?, total?, used?, avail?, used_fraction?}]`.
  `total`, `used` and `avail` are **bytes**; `used_fraction` is 0..1 (pve-storage `src/PVE/API2/Storage/Status.pm`, index
  returns).
- The headers contain spaces (`Total (KiB)`), so skip line 1 when parsing text.

### 5.8 Next free VMID
- `pvesh get /cluster/nextid` prints the integer as plain text plus a newline, e.g. `100`, because the result is a scalar
  and is printed with `"$data\n"` (CLIFormatter.pm 442).
- The range is datacenter.cfg `next-id: lower=,upper=` (default 100 up to 1,000,000). The first unused id wins.
- `--vmid N` asserts N is free, otherwise it fails with `VM N already exists` (pve-manager `PVE/API2/Cluster.pm` 1013-1050).
- Race-prone: `pct create` fails if the id is taken in the meantime.
- HTTP JSON type: the schema says `integer`, but some clients see a string. **UNVERIFIED**; accept both.

---

## 6. `qm`

qemu-server `src/PVE/CLI/qm.pm`. `list` and `print_agent_result` are identical on 8 and 9 (diffed).

### 6.1 `qm list`
```perl
printf "%10s %-20s %-10s %-10s %12s %-10s\n", qw(VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID);
printf "%10s %-20s %-10s %-10s %12.2f %-10s\n", $vmid, $name, $qmpstatus||$status, maxmem/MiB, maxdisk/GiB, $pid||0;
```
(qm.pm 1336-1356; sorted by vmid; exits 0 printing **nothing** if there are no VMs)
```
      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID       
       100 haos                 running    4096              32.00 12345     
       200 win11                stopped    8192              64.00 0         
```
`MEM(MB)` is printed with `%s`, so it can be fractional. VMID is right-aligned. Prefer
`pvesh get /nodes/$(hostname)/qemu --output-format json`.

### 6.2 `qm guest exec <vmid> [--timeout N] [--synchronous 0|1] [--pass-stdin 1] -- <cmd> [args...]`
qm.pm 963-1055:
- `timeout`: integer seconds, default **30**, `0` means wait forever. It cannot be combined with `--synchronous 0`
  (`synchronous` "needs to be set for 'timeout'").
- `pass-stdin`: reads STDIN to EOF and sends it as `input-data`; the limit is 1 MiB (`'input-data' (STDIN) is limited to
  1 MiB, aborting`).
- Flow: `guest-exec` with `capture-output: true`, then polls `guest-exec-status` every 1 s.
- Output is printed by `$print_agent_result` (qm.pm 1292-1312) as `to_json($result, {pretty=>1, canonical=>1, utf8=>1})`:
  3-space indent, `" : "` separators, **sorted keys**. A scalar result prints raw. An empty hash or undef prints
  **nothing**.
- Result fields (QEMU `GuestExecStatus`, `qga/qapi-schema.json` 1212-1241):
  - `exited`: bool, converted to **1/0**.
  - `exitcode?`: int.
  - `signal?`: int.
  - `out-data?`, `err-data?`: base64 from QGA, which PVE **decodes to plain text** (qemu-server `QemuServer/Agent.pm`
    153-180).
  - `out-truncated?`, `err-truncated?`: 1/0.
  - QGA includes `out-data`/`out-truncated` only if stdout was non-empty (`qga/commands.c`: `if (gei->out.length > 0)`),
    and likewise for stderr. The capture limit is 16 MiB (`GUEST_EXEC_MAX_OUTPUT`).

Successful run:
```
{
   "exitcode" : 0,
   "exited" : 1,
   "out-data" : "Linux pve-vm 6.12.0\n",
   "out-truncated" : 0
}
```

**Timeout:**
- qm writes `timeout reached, returning pid` to **stderr** and prints the original `guest-exec` result:
  ```
  {
     "pid" : 4321
  }
  ```
- Follow up with `qm guest exec-status <vmid> <pid>`, which uses the same printer and the same fields.
- **The exit status of `qm` does not reflect the guest command's exit code.** On success the CLI returns normally
  (exit 0); read `exitcode` from the JSON.
- If the agent is unavailable or the VM is stopped, qm dies with the messages listed in §1.4 and exits non-zero
  (Perl `die`, typically 255).

### 6.3 `qm guest cmd <vmid> <command>`
- `command` is one of the enum keys of `$guest_agent_commands`: `fsfreeze-freeze`, `fsfreeze-status`, `fsfreeze-thaw`,
  `fstrim`, `get-fsinfo`, `get-host-name`, `get-memory-block-info`, `get-memory-blocks`, `get-osinfo`, `get-time`,
  `get-timezone`, `get-users`, `get-vcpus`, `info`, `network-get-interfaces`, `ping`, `shutdown`, `suspend-disk`,
  `suspend-hybrid`, `suspend-ram` (QS9 Agent.pm 26-119; the PVE 8 list is the same).
- It runs QMP `guest-<command>` and prints the pretty JSON result.
- `ping` returns `{}`, so it prints **nothing** and exits 0 on success; that makes it a good liveness probe.
- `get-osinfo` returns `GuestOSInfo` with optional keys `kernel-release`, `kernel-version`, `machine`, `id`, `name`,
  `pretty-name`, `version`, `version-id`, `variant`, `variant-id` (qapi-schema 1464-1469).
```
{
   "id" : "debian",
   "kernel-release" : "6.12.43+deb13-amd64",
   "machine" : "x86_64",
   "name" : "Debian GNU/Linux",
   "pretty-name" : "Debian GNU/Linux 13 (trixie)",
   "version" : "13 (trixie)",
   "version-id" : "13"
}
```
The values are illustrative.

### 6.4 Is the agent enabled? (`qm config <vmid>`)
`qm config` prints `key: value` sorted (qm.pm 1373-1389). The `agent` value is a property string using `$agent_fmt`
(QS9 `QemuServer/Agent.pm` 23-62):
- `enabled` is a boolean, default 0, and is the **default_key**, so a bare first value is `enabled`.
- Other keys:
  - `fstrim_cloned_disks`
  - PVE 8 has `freeze-fs-on-backup` (QS8 `src/PVE/QemuServer.pm` 165-190, where `$agent_fmt` lived in PVE 8). PVE 9
    uses `freeze-fs`, with `freeze-fs-on-backup` and `guest-fsfreeze` kept as aliases.
  - `type=virtio|isa`

Examples: `agent: 1`, `agent: 0`, `agent: enabled=1,fstrim_cloned_disks=1`, `agent: 1,type=virtio`. No `agent:` line
means disabled.

Parse rule: split on `,`. The element without `=` is `enabled`, otherwise use `enabled=X`. It is enabled iff X matches
`^(1|on|yes|true)$` (case-insensitive), the same as `parse_boolean`. The status endpoint's `agent: 1` flag (§1.4) is the
simpler check.

---

## 7. SSH on the PVE host

### 7.1 `/root/.ssh/authorized_keys` (unchanged in PVE 9)
- `setup_ssh_keys()` (pve-cluster `src/PVE/Cluster/Setup.pm` 179-218; identical on `stable-bookworm`, diffed):
  - If `/root/.ssh/authorized_keys` is a regular file, it is renamed to `authorized_keys.org`.
  - Then `symlink /etc/pve/priv/authorized_keys -> /root/.ssh/authorized_keys`.
  - `ssh_merge_keys` (98-139) merges `.org` into the cluster file, dedups, and deletes `.org`.
- It runs from `updatecerts_and_ssh` (827-850), i.e. `pvecm updatecerts`, which runs as **`ExecStartPre` of
  `pveproxy.service`** (`ExecStartPre=-/usr/bin/pvecm updatecerts --silent`). The symlink is therefore re-asserted on
  every pveproxy start.
- PVE 9 docs still say "the `root` user's `authorized_keys` file gets linked to `/etc/pve/priv/authorized_keys`, merging
  all authorized keys within a cluster" (pve-docs `pvecm.adoc` 1078-1087).
- **No PVE 9 change** was found in the pve-cluster changelog (through 9.1.6), the pve-manager changelog (through 9.2.21)
  or the docs. The only related change is pve-cluster 8.0.6 (2024-03): "stop merging SSH known hosts by default" / "pin
  node's host key". It concerns `known_hosts`, not `authorized_keys`. The node's RSA host key is now written to
  `/etc/pve/nodes/<node>/ssh_known_hosts` (Setup.pm 230-243).
- **Implications:**
  - Add keys by appending to `/etc/pve/priv/authorized_keys` (or through the symlink).
  - Never replace the symlink with a regular file: it is converted back on the next pveproxy restart.
  - **In a cluster this file is shared by all nodes**, so the key works on every node.
  - pmxcfs has size limits and fixed ownership and modes; **UNVERIFIED** detail.

### 7.2 `PermitRootLogin`
- The PVE ISO installer runs `sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config`
  (pve-installer `Proxmox/Install.pm` 1437-1445).
- Cluster join also forces `PermitRootLogin yes` (`setup_sshd_config`, Setup.pm 141-156, called from join).
- PVE installed on top of plain Debian keeps OpenSSH's default **`prohibit-password`** (`sshd_config.5`: "The default is
  prohibit-password"). Key-based root login works with either value.
- `forced-commands-only` would also work for a `command=` key.
- Debian 13 drop-ins under `/etc/ssh/sshd_config.d/` could override this; **UNVERIFIED** per host. Check with
  `sshd -T | grep -i permitrootlogin`.

### 7.3 Restricted key for a dashboard helper (forced command)
OpenSSH `sshd.8` AUTHORIZED_KEYS options:
- `command="cmd"`: "executed whenever this key is used … The command supplied by the user (if any) is ignored … The
  command originally supplied by the client is available in the SSH_ORIGINAL_COMMAND environment variable". It applies to
  shell, command and subsystem requests.
- `restrict`: "disable port, agent and X11 forwarding, as well as disabling PTY allocation and execution of ~/.ssh/rc",
  including any future restrictions.
- `from="pattern-list"`: requires the client's address to match. CIDR is allowed.
- `ssh.1`: "SSH_ORIGINAL_COMMAND This variable contains the original command line if a forced command is executed."
- Like `ForceCommand`, the command runs through the user's login shell with `-c`.

Example line in `/etc/pve/priv/authorized_keys`:
```
restrict,from="192.168.1.60",command="/usr/local/sbin/pve1dash-helper" ssh-ed25519 AAAAC3Nza... pve1-dash@ct120
```

Helper skeleton (allow-list only, never `eval` the input):
```bash
#!/bin/bash
set -euo pipefail
read -r -a ARGV <<<"${SSH_ORIGINAL_COMMAND:-}"
case "${ARGV[0]:-}" in
  pkgupdates)  exec cat /var/lib/pve-manager/pkgupdates ;;                   # replaces apt/update (Sys.Modify)
  vm-ifaces)   [[ "${ARGV[1]:-}" =~ ^[0-9]+$ ]] || exit 2
               exec qm guest cmd "${ARGV[1]}" network-get-interfaces ;;      # PVE 8 fallback for §1.4
  *)           echo "denied" >&2; exit 1 ;;
esac
```
- The pve-docs warning applies: root's `.bashrc` runs for SSH sessions, so non-interactive output can break parsing.
  Guard it with an interactivity check (`pvecm.adoc` "Pitfalls due to automatic execution of `.bashrc`").
- Host keys are `/etc/ssh/ssh_host_ed25519_key[.pub]`, `/etc/ssh/ssh_host_ecdsa_key[.pub]` and
  `/etc/ssh/ssh_host_rsa_key[.pub]` (`sshd.8` FILES 964-976).
- PVE itself pins only the RSA key (Setup.pm 84, 230-243).
- To pin from the CT: `ssh-keyscan -t ed25519 <pve-ip>`, or copy `/etc/ssh/ssh_host_ed25519_key.pub` into the CT's
  `known_hosts` as `<host> ssh-ed25519 AAAA...`.

---

## 8. `pveversion` output
`bin/pveversion` (pve-manager, the same on stable-8):
```perl
my $ver = PVE::pvecfg::package() . '/' . PVE::pvecfg::version_text();   # version_text = '@VERSION@/@REPOID@'
print "$ver (running kernel: $kver)\n";                                   # $kver = (POSIX::uname())[2]
```
- `PACKAGE=pve-manager` (`defines.mk`).
- `REPOID` is `git rev-parse --short=16 HEAD`, i.e. **16 hex chars** on both 8 and 9 (`PVE/Makefile` 23).
- The `/version` API comment: "length 8 is old (< 8.0) short-id, 16 is new short id" (`PVE/API2.pm`).

Format: `pve-manager/<X.Y.Z>/<16-hex> (running kernel: <uname -r>)`. Example (hash illustrative):
```
pve-manager/9.0.10/0123456789abcdef (running kernel: 6.14.11-2-pve)
pve-manager/8.4.14/fedcba9876543210 (running kernel: 6.8.12-15-pve)
```

`pveversion -v` (or `--verbose`) prints one line per package:
- `<pkg>: <version>`
- `proxmox-ve: <ver> (running kernel: <kver>)` for the kernel meta package
- `pve-manager: <ver> (running version: <ver>/<repoid>)`
- non-installed states are `not correctly installed` or `residual config`.

Regex: `^pve-manager/(\d+)\.(\d+)\.(\d+)/([0-9a-f]+) \(running kernel: (\S+)\)$`.

The API equivalent is `GET /version`, which returns `{version: "9.0.10", release: "9.0", repoid: "<hex>", console?}`.

---

## 9. Node TLS certificates

### 9.1 Paths (pmxcfs; pve-docs `pmxcfs.adoc` 105-150)

| file | meaning |
|---|---|
| `/etc/pve/pve-root-ca.pem` | cluster CA cert (public) |
| `/etc/pve/priv/pve-root-ca.key`, `/etc/pve/priv/pve-root-ca.srl` | CA key and serial |
| `/etc/pve/nodes/<node>/pve-ssl.pem` and `.key` | node cert signed by the cluster CA (always present) |
| `/etc/pve/nodes/<node>/pveproxy-ssl.pem` and `.key` | optional custom or ACME cert (chain), overriding `pve-ssl.pem` |
| `/etc/pve/local` | symlink to `nodes/<LOCAL_HOST_NAME>`, so `/etc/pve/local/pve-ssl.pem` works |

pveproxy uses `/etc/pve/local/pveproxy-ssl.pem` **only if** both it and the key exist. The key path can be overridden
with `TLS_KEY_FILE` in `/etc/default/pveproxy`. Otherwise pveproxy serves `pve-ssl.pem`/`.key` (pve-manager
`PVE/Service/pveproxy.pm` 112-157).

### 9.2 What `pve-ssl.pem` contains
`gen_pve_ssl_cert` (pve-cluster `src/PVE/Cluster/Setup.pm` 487-570; the same SAN logic on stable-bookworm, which used an
openssl config file instead of `-addext`):
- SAN = `IP:127.0.0.1, IP:::1, DNS:localhost, IP:<node IP>, DNS:<nodename>`, plus `DNS:<nodename>.<search>` when
  `/etc/resolv.conf` has a `search` domain.
  - `<node IP>` is `PVE::Cluster::remote_node_ip(nodename)`, normally the address from `/etc/hosts`.
  - Only **one** node IP is included; other interfaces' IPs are not.
- Subject: `/OU=PVE Cluster Node/O=Proxmox Virtual Environment/CN=<fqdn or nodename>`.
- Extensions: `basicConstraints=CA:FALSE`, `extendedKeyUsage=serverAuth`. Key: RSA 2048.
- Validity: at most 2 years (730 days), and at most CA lifetime − 2 days. Issued with `faketime yesterday`, so
  `notBefore` is one day back.
- CA: RSA 4096, 3650 days, subject `/CN=Proxmox Virtual Environment/OU=<uuid>/O=PVE Cluster Manager CA/`
  (Setup.pm 406-452).
- The cert is regenerated if missing. `pvecm updatecerts --force` forces a new one, and pveproxy's `ExecStartPre` runs
  `updatecerts`, which does not force.

### 9.3 SHA-256 fingerprint in the PVE UI format
The PVE UI and API show uppercase hex pairs joined by `:` (Net::SSLeay `X509_get_fingerprint(..., 'sha256')`, which
uses `"%02X:"`).
```bash
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256 | cut -d= -f2
# OpenSSL 3 prints: sha256 Fingerprint=BB:40:F0:04:...:6F   (OpenSSL 1.1 used the prefix "SHA256 Fingerprint=")
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -ext subjectAltName
# for the cert actually served (custom or ACME aware):
openssl s_client -connect 127.0.0.1:8006 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
```
- Node.js 22: `new crypto.X509Certificate(pem).fingerprint256` and `tlsSocket.getPeerCertificate().fingerprint256` use
  the **same** uppercase colon format. This was checked locally (Node v22.22.0 against OpenSSL 3.0.13 output: identical
  strings).
- The backend can therefore pin the PVE cert by comparing it to the value from `openssl` or from
  `GET /nodes/{node}/certificates/info`.
- Alternatively trust `/etc/pve/pve-root-ca.pem` as the CA (`ca:` option). This works for `pve-ssl.pem` only if the SAN
  includes the hostname or IP you connect to (see §9.2).

---

## 10. Checklist for the mock server and client
- Use the token header format from §3.1. The mock should return 401 `Authentication failed!` for a bad secret and 403
  `Permission check failed (...)` for missing privileges, with the body `{"data":null,"message":"...\n"}`.
- Under a PVEAuditor token:
  - `/apt/update` must return **403** on both 8 and 9.
  - `/storage/{s}/content` must **omit `backup` and `images`/`rootdir`** volumes, keeping only iso and vztmpl.
  - `/agent/*` must return 403 on PVE 8 and work on PVE 9.
- The LXC `/interfaces` endpoint uses `inet`/`inet6`; the QGA one uses `ipv4`/`ipv6`. Normalize in the client.
- Task list items may have an extra `tokenid`; `endtime` and `status` are absent while a task runs.
- CLI parsers should prefer `pvesh … --output-format json` over the `pct list`, `qm list` and `pvesm status` text
  tables: those have empty columns and trailing spaces.

---

## Sources
GitHub mirrors, fetched 2026-10-10 (line numbers refer to those heads):
- pve-access-control
  - master: `src/PVE/AccessControl.pm`, `src/PVE/RPCEnvironment.pm`, `src/PVE/API2/User.pm`, `src/PVE/API2/ACL.pm`,
    `src/PVE/API2/Role.pm`, `src/PVE/API2/AccessControl.pm`, `src/PVE/CLI/pveum.pm`, `src/PVE/TokenConfig.pm`,
    `src/PVE/Auth/Plugin.pm`, `debian/changelog`
  - stable-bookworm: the same files.
  - URL pattern: https://raw.githubusercontent.com/proxmox/pve-access-control/master/src/PVE/AccessControl.pm
- qemu-server
  - master and stable-bookworm: `src/PVE/API2/Qemu/Agent.pm`, `src/PVE/QemuServer/Agent.pm`, `src/PVE/CLI/qm.pm`,
    `src/PVE/API2/Qemu.pm`, `debian/changelog`
- pve-manager
  - master and stable-8: `PVE/API2/Tasks.pm`, `PVE/API2/APT.pm`, `PVE/API2/Backup.pm`,
    `PVE/API2/Cluster/BackupInfo.pm`, `PVE/API2/Network.pm`, `PVE/API2/Certificates.pm`, `PVE/API2/Subscription.pm`,
    `PVE/API2/Cluster.pm`, `PVE/API2/Nodes.pm`, `PVE/API2.pm`, `PVE/CLI/pveam.pm`, `PVE/APLInfo.pm`, `PVE/CLI/pvesh.pm`,
    `PVE/CLI/pve8to9.pm`, `PVE/HTTPServer.pm`, `PVE/Service/pveproxy.pm`, `services/pveproxy.service`, `bin/pveversion`,
    `PVE/pvecfg.pm.in`, `PVE/Makefile`, `defines.mk`, `debian/changelog`
- pve-storage (master and stable-8): `src/PVE/API2/Disks.pm`, `src/PVE/API2/Disks/ZFS.pm`,
  `src/PVE/API2/Storage/Content.pm`, `src/PVE/API2/Storage/Status.pm`, `src/PVE/CLI/pvesm.pm`, `src/PVE/Storage.pm`
- pve-container (master and stable-bookworm): `src/PVE/CLI/pct.pm`, `src/PVE/API2/LXC.pm`, `src/PVE/LXC.pm`,
  `src/PVE/LXC/Config.pm`, `src/PVE/LXC/Setup/Debian.pm`, `debian/changelog`
- pve-cluster (master and stable-bookworm): `src/PVE/Cluster/Setup.pm`, `src/PVE/CLI/pvecm.pm`, `debian/changelog`
- pve-common (master): `src/PVE/JSONSchema.pm`, `src/PVE/RESTHandler.pm`, `src/PVE/CLIHandler.pm`,
  `src/PVE/CLIFormatter.pm`, `src/PVE/ParseUtils.pm`, `src/PVE/Tools.pm`, `src/PVE/Certificate.pm`,
  `src/PVE/RESTEnvironment.pm`, `src/PVE/Exception.pm`
- pve-http-server (master): `src/PVE/APIServer/Formatter.pm`, `src/PVE/APIServer/AnyEvent.pm`,
  `src/PVE/APIServer/Formatter/Standard.pm`, `debian/changelog`
- pve-docs (master): `pveum.adoc` (tokens 84-116, roles and privileges 820-940, monitoring token example 1194-1225),
  `pmxcfs.adoc` (105-150), `pvecm.adoc` (SSH setup 1078-1094)
- pve-installer (master): `Proxmox/Install.pm` 1437-1445
- QEMU: https://raw.githubusercontent.com/qemu/qemu/master/qga/qapi-schema.json and `qga/commands.c`
- LXC: https://raw.githubusercontent.com/lxc/lxc/main/src/lxc/tools/lxc_attach.c and `doc/lxc-attach.sgml.in`
- iproute2: https://raw.githubusercontent.com/iproute2/iproute2/main/lib/utils.c and `ip/ipaddress.c`
- OpenSSH: https://raw.githubusercontent.com/openssh/openssh-portable/master/sshd.8, `sshd_config.5`, `ssh.1`
- Net::SSLeay: https://raw.githubusercontent.com/radiator-software/p5-net-ssleay/master/SSLeay.xs (`X509_get_fingerprint`)
- Local checks:
  - OpenSSL 3.0.13 `-fingerprint -sha256` output format, and Node v22.22.0 `X509Certificate.fingerprint256` (same format)
  - Perl JSON `pretty`/`canonical` rendering
  - Perl `printf` rendering of the pct, qm, pvesm and pveam table formats
- Proxmox forum (Debian 13 template names and version-parse bug):
  - [VE 9 - Unable to create Debian 13 container](https://forum.proxmox.com/threads/ve-9-unable-to-create-debian-13-container.171919/)
  - [Regarding the installation failure of Debian 13.1 CT](https://forum.proxmox.com/threads/regarding-the-installation-failure-of-debian-13-1-ct.171669/)
  - [debian-13-standard_13.1-1_amd64.tar.zst not found](https://forum.proxmox.com/threads/trying-to-download-debian-13-template-gives-debian-13-standard_13-1-1_amd64-tar-zst-not-found.173175/)
  - [Debian 13 LXC Template](https://forum.proxmox.com/goto/post?id=799962)
- Unreachable from this container: download.proxmox.com (template index) and pve.proxmox.com. Facts depending on them are
  marked UNVERIFIED.
