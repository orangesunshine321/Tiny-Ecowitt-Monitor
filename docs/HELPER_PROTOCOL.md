# SSH helper protocol (v2)

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
| `version` | `pve1-dash-helper 2` | protocol version (`1` = helper from before the df/updates/reboot sections; update it with `install.sh --update-helper`) |
| `inventory` | framed inventory of **all running LXCs** (via `pct exec`) and **running VMs with `agent` enabled** (via `qm guest exec`) | Guests run in parallel, at most 4 at a time; each guest is limited by `timeout 25`. Output stays in vmid order. |
| `inventory <vmid>` | the same framing for one guest | |
| `inventory [<vmid>] quick` | the same, but the guests skip counting package updates | The dashboard asks for a full inventory hourly and for quick ones in between. A v1 helper denies `quick`; the dashboard then falls back to plain `inventory`. |
| `sensors` | raw `sensors -j` JSON | exit 3 with `lm-sensors not installed` on stderr when missing |
| `pkgupdates` | pending updates as a JSON array (the objects of `/var/lib/pve-manager/pkgupdates`) | See below. Needed because `GET /apt/update` requires `Sys.Modify`. |
| `hostinfo` | `key value` lines, see below | v2 |
| `backups <storage>` | `pvesh get /nodes/$(hostname)/storage/<storage>/content --content backup --output-format json` | Needed because the API hides backup volumes from PVEAuditor tokens. |

The default (no command) is `inventory`.

### `pkgupdates`

The cache file is written by the daily `pveupdate` job only after `apt-get update` worked for every repository: one
failing repository (typically the enterprise repository without a subscription) leaves it stale or missing, and a
manual `apt full-upgrade` does not touch it. So when the file is missing, or older than `/var/lib/dpkg/status` or
`/var/cache/apt/pkgcache.bin`, the helper recomputes the list the way the web UI's Updates panel does:
`pvesh get /nodes/<node>/apt/update` as root, which reads the local apt cache only (no download) and rewrites the file
(limit 60 s). If that fails, it serves the file it has, or `[]`. Finally, entries whose candidate `Version` is already
installed (per `dpkg-query`) are dropped.

### `hostinfo`

```
running 6.8.12-4-pve                          uname -r
vmlinuz 6.8.12-9-pve                          one line per /boot/vmlinuz-*
package proxmox-kernel-6.8.12-9-pve-signed    installed proxmox-kernel-* / pve-kernel-* packages (dpkg-query)
pin 6.8.12-4-pve                              /etc/kernel/proxmox-boot-pin, if set
next-boot-pin 6.8.12-4-pve                    /etc/kernel/next-boot-pin, if set
stamp-lists 1760000000                        mtime of /var/lib/apt/lists and lists/partial (epoch s)
stamp-pkgupdates 1760000000                   mtime of /var/lib/pve-manager/pkgupdates
```

The dashboard (`parseHostInfo`) reports `runningKernel`, `newestKernel` (the kernel the next boot uses: next-boot pin,
pin, else the newest installed Proxmox kernel) and `updatesCheckedAt` (newest `stamp-lists`; the pkgupdates time only
when the lists are unknown, because the recompute above rewrites that file without refreshing anything).

## Inventory framing (host helper)

```
@@pve1-dash:inventory v2
@@pve1-dash:guest <vmid> <lxc|qemu> <pct-exec|qm-guest-exec>
...payload lines...
@@pve1-dash:end <vmid> <exitcode>
@@pve1-dash:guest ...
...
@@pve1-dash:done
```

Payload depends on the transport:
- **pct-exec:** the raw stdout of the inner guest script (see below), run as
  `timeout 25 pct exec <vmid> --keep-env 0 -- /bin/sh -c "$INNER" pve1-dash-inner [quick]`. When the script started but
  did not finish (e.g. a probe ran into the limit), the helper passes on what it printed, followed by
  `@@pve1-dash:error <reason>`; the dashboard keeps that partial inventory and shows the reason.
- **qm-guest-exec:** the JSON printed by
  `timeout 30 qm guest exec <vmid> --timeout 25 -- /bin/sh -c "$INNER" pve1-dash-inner [quick]`, which looks like
  `{"exitcode":0,"exited":1,"out-data":"…","err-data":"…","out-truncated":0}`. `qm guest exec` exits 0 even when the
  guest command failed, so read `exitcode` from the JSON. The dashboard unwraps `out-data` and parses it as inner script
  output.
- If a guest can't be inspected, the payload is one line: `@@pve1-dash:error <message>`. Examples: guest agent not running,
  `qm`/`pct` failed, timeout (exit 124), Windows guest. The dashboard sets `inspectable: "unsupported"` (shown as
  information, never as a failure) for a Windows guest and for an agent whose `guest-exec` is disabled (Home Assistant
  OS); every other error is a real, fixable failure (`inspectable: "yes"`).

Skipped without a block: stopped guests, templates, and VMs whose config has no enabled agent (`agent: 0`, or no `agent:`
line). A config line counts as enabled when it matches `^agent:\s*(1|enabled=1)` (`agent: 1` or `agent: enabled=1,...`).

## Inner guest script output (shared by both helpers)

The inner script is POSIX `sh`, so it works on Debian/Ubuntu/Alpine/busybox (and NixOS: its PATH includes
`/run/current-system/sw/bin`). Every section is optional; a missing tool leaves an empty section. Its first argument
may be `quick`, which skips the package-update count (the one probe that costs real CPU).

```
##pve1-dash:inventory v2
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
##pve1-dash:section df                          (v2)
<df -P -T -k -l  (fallbacks: df -P -T -k for busybox, df -P -k)>
##pve1-dash:section updates                     (v2; local package cache only, never the network)
manager apt|apk|dnf|yum|pacman
count <n>                                       apt-get -s -o Debug::NoLocking=1 dist-upgrade ("Inst <pkg> [<old>]" lines),
security <n>                                      apk --no-network version -l '<', dnf|yum -C -q check-update, pacman -Qu
stamp <epoch>                                   one per file whose mtime tells when the lists were refreshed
  (or the single line "skipped" in quick mode; empty without a package manager)
##pve1-dash:section reboot                      (v2)
flag reboot-required|nixos|needs-restarting     /run/reboot-required, NixOS booted ≠ current kernel, needs-restarting -r
container                                       inside a container (no kernel checks)
modules-missing                                 /lib/modules/$(uname -r) is gone (Alpine, Arch after a kernel upgrade)
vmlinuz <version>                               one per /boot/vmlinuz-* (VMs)
##pve1-dash:end
```

Protocol v1 output (no df/updates/reboot sections) still parses; those fields then stay unset ("unknown").

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
- **`ip -o addr show` lines:** `2: eth0    inet 10.10.20.31/24 brd ... scope global eth0`. Skip loopback, link-local and
  multicast addresses, and the virtual interfaces of `server/util/ipfilter.ts` (shared with the guest-agent path):
  docker0/docker_gwbridge/`br-<12 hex>`, veth*, virbr*, lxcbr/lxdbr/incusbr, podman/cni*, flannel*, cali*,
  vxlan.calico, cilium*, weave, tunl0, kube-*, hassio. VPN interfaces (tailscale0, wg*, zt*) and the Tailscale CGNAT
  range are kept.
- **`df` lines** (1K blocks): drop pseudo filesystems (tmpfs, devtmpfs, overlay, squashfs, proc, sysfs, cgroup*, nsfs,
  `fuse.*`, ...), mounts below /proc, /sys, /dev, /run and /snap, zero-size ones, and bind mounts of an already listed
  filesystem. Mount points may contain spaces. Network shares stay in the list (the guest_disk alert ignores them).
- **`reboot`:** a reboot is due on any `flag` or `modules-missing`, or when a `vmlinuz` of the same flavour (`amd64`,
  `generic`, `pve`, ...) is newer than the running kernel and the running kernel is itself listed.
- **`ss -Hltnp` lines:** `LISTEN 0 4096 0.0.0.0:8096 0.0.0.0:* users:(("jellyfin",pid=123,fd=45))`. Handle `[::]:80`, `*:53`
  and `%iface` suffixes. Dedupe by port+process.

## Guest helper commands

`pve1-dash-guest-inventory` accepts `inventory` (the default), `inventory quick` or `version` (`pve1-dash-guest-inventory 2`).
For `inventory` it prints the inner script output directly, with no `@@` framing; the dashboard records `source: "ssh"`.
A v1 guest helper denies `inventory quick`; the dashboard then retries with `inventory`.

## Transport

`server/inventory/ssh.ts` uses `ssh2` and pins host keys from `known_hosts`:
- The pve1 host key is written by the installer.
- Guest keys are learned on first use and appended.

Every remote command is bounded twice: by the helper's own `timeout` and by a client-side timer. Closing an ssh2 channel
does not kill the remote process.
