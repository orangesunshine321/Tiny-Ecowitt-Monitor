# SSH helper protocol (v1)

pve1-dash never gets a shell anywhere. It holds one ed25519 key, and every place that key is authorized pins it to a
single read-only script with OpenSSH's `restrict,command="..."` options. Whatever command the dashboard sends is
ignored by sshd. It only reaches the script as `SSH_ORIGINAL_COMMAND`, which the script validates against a short
allow-list.

There are two scripts, both in `deploy/helpers/`:

| Script | Installed at | Runs as | authorized_keys line |
|---|---|---|---|
| `pve1-dash-helper` (bash) | `/usr/local/sbin/pve1-dash-helper` on **pve1** | root | `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 AAAA… pve1-dash` in `/root/.ssh/authorized_keys` (a symlink to `/etc/pve/priv/authorized_keys` on PVE) |
| `pve1-dash-guest-inventory` (POSIX sh) | `/usr/local/sbin/pve1-dash-guest-inventory` inside a **VM without guest agent** | root | same pattern, pointing at the guest script |

Both scripts must:
- start with `set -u`, never `eval` input, and never pass `SSH_ORIGINAL_COMMAND` to a shell;
- validate arguments with strict regexes (`^[0-9]{1,9}$` for a vmid, `^[A-Za-z][A-Za-z0-9._-]{0,63}$` for a storage id);
- print `denied` to stderr and exit 1 for anything else;
- tolerate a noisy `.bashrc`, since sshd runs forced commands through the user's shell. The dashboard ignores everything
  before the first `@@pve1-dash:` line.

## Host helper commands (`SSH_ORIGINAL_COMMAND`)

| Command | Output | Notes |
|---|---|---|
| `version` | `pve1-dash-helper 1` | protocol version |
| `inventory` | framed inventory of **all running LXCs** (via `pct exec`) and **running VMs with `agent` enabled** (via `qm guest exec`) | Guests run in parallel, at most 4 at a time; each guest is limited by `timeout 25`. Output stays in vmid order. |
| `inventory <vmid>` | the same framing for one guest | |
| `sensors` | raw `sensors -j` JSON | exit 3 with `lm-sensors not installed` on stderr when missing |
| `pkgupdates` | contents of `/var/lib/pve-manager/pkgupdates` (JSON array) | prints `[]` when the file is missing. Needed because `GET /apt/update` requires `Sys.Modify`. |
| `backups <storage>` | `pvesh get /nodes/$(hostname)/storage/<storage>/content --content backup --output-format json` | Needed because the API hides backup volumes from PVEAuditor tokens. |

The default (no command) is `inventory`.

## Inventory framing (host helper)

```
@@pve1-dash:inventory v1
@@pve1-dash:guest <vmid> <lxc|qemu> <pct-exec|qm-guest-exec>
...payload lines...
@@pve1-dash:end <vmid> <exitcode>
@@pve1-dash:guest ...
...
@@pve1-dash:done
```

Payload depends on the transport:
- **pct-exec:** the raw stdout of the inner guest script (see below), run as `timeout 25 pct exec <vmid> -- sh -c "$INNER"`.
- **qm-guest-exec:** the JSON printed by `timeout 30 qm guest exec <vmid> --timeout 25 -- sh -c "$INNER"`, which looks like
  `{"exitcode":0,"exited":1,"out-data":"…","err-data":"…","out-truncated":0}`. `qm guest exec` exits 0 even when the
  guest command failed, so read `exitcode` from the JSON. The dashboard unwraps `out-data` and parses it as inner script
  output.
- If a guest can't be inspected, the payload is one line: `@@pve1-dash:error <message>`. Examples: guest agent not running,
  `qm`/`pct` failed, timeout (exit 124), Windows guest.

Skipped without a block: stopped guests, templates, and VMs whose config has no enabled agent (`agent: 0`, or no `agent:`
line). A config line counts as enabled when it matches `^agent:\s*(1|enabled=1)` (`agent: 1` or `agent: enabled=1,...`).

## Inner guest script output (shared by both helpers)

The inner script is POSIX `sh`, so it works on Debian/Ubuntu/Alpine/busybox. Every section is optional; a missing tool
leaves an empty section.

```
##pve1-dash:inventory v1
##pve1-dash:section os-release
<contents of /etc/os-release>
##pve1-dash:section kernel
<uname -r>
##pve1-dash:section uptime
<contents of /proc/uptime>              e.g. "1234.56 4321.00"
##pve1-dash:section loadavg
<contents of /proc/loadavg>             e.g. "0.08 0.12 0.10 1/234 5678"
##pve1-dash:section init
systemd | openrc | unknown
##pve1-dash:section services
<systemd: systemctl list-units --type=service --state=running --no-legend --no-pager --plain>
<openrc:  rc-status --servicelist  (fallback: rc-status -s)>
##pve1-dash:section docker
present | absent
<when present: docker ps -a --no-trunc --format '{{json .}}'  (one JSON object per line)>
##pve1-dash:section ip
<ip -o addr show  (fallback: ifconfig)>
##pve1-dash:section listen
<ss -Hltnp  (fallback: netstat -ltnp)>
##pve1-dash:end
```

Parser notes, for `server/inventory/parse.ts`:
- **systemd lines:** `nginx.service loaded active running A high performance web server`. Strip the `.service` suffix.
  Mark these as `system: true`: `systemd-*`, `dbus*`, `getty@*`, `serial-getty@*`, `cron`, `crond`, `ssh`, `sshd`,
  `rsyslog`, `polkit`, `user@*`, `unattended-upgrades`, `networkd-dispatcher`, `postfix*`, `chrony*`, `qemu-guest-agent`,
  `console-getty`, `container-getty@*`, `ifupdown*`, `networking`, `rpcbind`, `apparmor`, `udisks2`, `ModemManager`,
  `multipathd`, `snapd*`, `fwupd`, `irqbalance`, `atd`, `lvm2-*`, `packagekit`, `accounts-daemon`, `upower`, `thermald`,
  `wpa_supplicant`, `NetworkManager*`, `avahi-daemon`, `cups*`, `exim4`.
- **Docker JSON fields:** `ID`, `Image`, `Names`, `State`, `Status` (e.g. `Up 3 days (healthy)`),
  `Ports` (e.g. `0.0.0.0:8096->8096/tcp, [::]:8096->8096/tcp, 6767/tcp`), `Labels` (`k=v,k=v`), `RunningFor`, `CreatedAt`.
  - Take health from `Status`: `(healthy)`, `(unhealthy)`, or `(health: starting)`.
  - The compose project and service come from the `com.docker.compose.project` / `com.docker.compose.service` labels.
  - Dedupe IPv4/IPv6 duplicates of the same host port.
- **`ip -o addr show` lines:** `2: eth0    inet 10.10.20.31/24 brd ... scope global eth0`. Skip `lo`, link-local `fe80::`,
  docker/veth/br- bridges (`docker0`, `br-*`, `veth*`), and the tailscale CGNAT range is kept.
- **`ss -Hltnp` lines:** `LISTEN 0 4096 0.0.0.0:8096 0.0.0.0:* users:(("jellyfin",pid=123,fd=45))`. Handle `[::]:80`, `*:53`
  and `%iface` suffixes. Dedupe by port+process.

## Guest helper commands

`pve1-dash-guest-inventory` accepts `inventory` (the default) or `version`. For `inventory` it prints the inner script output
directly, with no `@@` framing; the dashboard records `source: "ssh"`.

## Transport

`server/inventory/ssh.ts` uses `ssh2` and pins host keys from `known_hosts`:
- The pve1 host key is written by the installer.
- Guest keys are learned on first use and appended.

Every remote command is bounded twice: by the helper's own `timeout` and by a client-side timer. Closing an ssh2 channel
does not kill the remote process.
