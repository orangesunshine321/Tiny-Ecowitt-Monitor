# 🔧 Troubleshooting

Small steps, one or two at a time. Each section starts with what you see, then walks from the most likely cause to
the least likely. Commands marked **(host)** run on the Proxmox host as root; **(CT)** runs inside the dashboard
container (`pct enter <ctid>` from the host, or prefix the command with `pct exec <ctid> --`).

Jump to: [first checks](#-first-checks) · [token 401/403](#-token-401403) ·
[TLS fingerprint mismatch](#-tls-fingerprint-mismatch-after-a-certificate-renewal) ·
[SSH host key changed](#-ssh-host-key-changed) · [helper denied / no apps](#-helper-denied-or-apps--services-stay-empty) ·
[guest agent](#-guest-agent-vm-shows-no-ip-or-no-apps) · [push on iPhone](#-push-notifications-dont-arrive-on-iphone) ·
[live updates through the proxy](#-live-updates-stop-or-never-start-sse-through-the-proxy) ·
[421 unknown host](#-unknown-host-http-421) · [alert times off by hours](#-times-in-alerts-are-off-by-some-hours) ·
[temperatures](#-temperatures-are-missing) · [disk health / sleeping HDDs](#-disk-health-updates-slowly-or-hdds-dont-stay-spun-down) ·
[paused on an I/O error](#-a-vm-is-paused-on-an-io-error) · [installer](#-installer-problems) ·
[not verified on real hardware](#-things-that-could-not-be-tested-on-real-proxmox)

---

## 👀 First checks

**Step 1.** Is the service running? **(CT)**

```bash
systemctl status pve1-dash --no-pager
curl -s http://127.0.0.1:8080/healthz        # {"ok":true}
```

**Step 2.** What does the log say? **(CT)**

```bash
journalctl -u pve1-dash -n 50 --no-pager
```

Lines start with `[warn]` or `[error]` and the part that complained, e.g. `pve1-dash/proxmox:` (API),
`pve1-dash/host-helper:` (SSH helper), `pve1-dash/push:` (notifications).

**Step 3.** In the dashboard, **Settings → Data sources** shows each collector with its last success and last error.
The live dot in the toolbar opens the same list.

After any config change: `systemctl restart pve1-dash` **(CT)**, then repeat step 2.

---

## 🔑 Token 401/403

**You see:** `Proxmox GET ...: HTTP 401` (*Authentication failed!*) or `HTTP 403` (*Permission check failed*) in the
log, and the dashboard stays empty or shows "offline".

**401 = the token or its secret is wrong.**

**Step 1.** Does the token exist? **(host)**

```bash
pveum user token list pve1dash@pve
```

You should see a row `dashboard` (a second dashboard in the cluster has its own, `dashboard-ct<id>`; the container's
`proxmox.tokenId` names the one it uses). If the user or token is missing, re-run the installer; it creates them
again. A re-run also tests the container's secret against the API and offers (with `--yes`: does) a new token when
Proxmox rejects it.

**Step 2.** Is the secret in the container the current one? **(CT)**

```bash
cat /etc/pve1-dash/token                     # one line, a UUID like 0b4c5d2e-...
grep -n tokenId /etc/pve1-dash/config.yaml   # tokenId: "pve1dash@pve!dashboard"
```

A token secret is shown only once when it is created. If you're not sure the file matches, rotate it: run the
installer again with `PVE1_DASH_ROTATE_TOKEN=yes`. It replaces the token at the very end, after the new version runs:
it removes the old token, makes a new one, writes the new secret into the container and restarts the service, so a
run that fails earlier leaves the old secret working.

**Step 3.** Test the token directly **(host)**:

```bash
read -rs SECRET; echo                                  # paste the secret, press Enter
curl -sk -H 'Authorization: PVEAPIToken=pve1dash@pve!dashboard='"$SECRET" \
  https://127.0.0.1:8006/api2/json/nodes/$(hostname -s)/status | head -c 200; echo
```

(The token id is in single quotes on purpose: in an interactive shell, `!dashboard` inside double quotes is bash
history expansion and fails with "event not found". Use `dashboard-ct<id>` instead of `dashboard` for a second
dashboard.)

`{"data":{...` means it works. `401` again means the secret is wrong.

**403 = the token is valid but lacks a permission.**

**Step 1.** Check what the token is allowed **(host)**:

```bash
pveum user token permissions pve1dash@pve dashboard --path /
```

You should see `Sys.Audit`, `VM.Audit`, `Datastore.Audit` (and on PVE 9 `VM.GuestAgent.Audit`). Empty means an ACL is
missing.

**Step 2.** Grant `PVEAuditor` on `/` to **both** the user and the token (a privilege-separated token needs both)
**(host)**:

```bash
pveum acl modify / --users pve1dash@pve --roles PVEAuditor
pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor
```

Restart the dashboard **(CT)**.

**Expected 403s that are fine:**

- On **PVE 8**, the guest-agent endpoints answer 403 because they need `VM.Monitor`, which pve1-dash deliberately
  doesn't request ([why](SECURITY.md#why-not-vmmonitor-on-pve-8)). The log says so once; VM IPs come from the SSH
  inventory instead.
- `/apt/update` needs `Sys.Modify`; pending updates are read through the SSH helper instead.

---

## 🔒 TLS fingerprint mismatch after a certificate renewal

**You see:** `Proxmox TLS fingerprint mismatch: server presented AB:CD:...` in the log. Typical after a Let's Encrypt
renewal (every ~60-90 days), uploading a new certificate, or `pvecm updatecerts --force`.

**Step 1.** Get the fingerprint of the certificate pveproxy serves now **(host)**:

```bash
openssl s_client -connect 127.0.0.1:8006 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
# sha256 Fingerprint=3F:9A:...      (or look in the web UI: node → System → Certificates)
```

**Step 2.** Put it in the config **(CT)**, the part after `=`:

```bash
nano /etc/pve1-dash/config.yaml        # proxmox → tls → fingerprint: "3F:9A:..."
systemctl restart pve1-dash
```

(Re-running the installer does steps 1-2 for you. It keeps the branch or tag the container was installed from, so it
doesn't switch your code; and it warns when the host serves a custom/ACME certificate, which renews often.)

**Step 3, if this keeps happening** (ACME certificates renew often): stop pinning a single certificate.

- **Publicly trusted ACME certificate:** remove `fingerprint:` and make `proxmox.url` use the host name on the
  certificate, e.g. `https://pve1.example.com:8006` (the container must resolve it to the host's LAN IP).
- **Self-signed Proxmox certificate:** trust the cluster CA instead, which survives renewals:
  ```bash
  pct push <ctid> /etc/pve/pve-root-ca.pem /etc/pve1-dash/pve-root-ca.pem     # (host)
  ```
  then in the config replace `fingerprint:` with `ca: /etc/pve1-dash/pve-root-ca.pem`. The URL must use the node
  name or the IP that is in the certificate (`openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -ext subjectAltName`
  **(host)** lists them).

---

## 🧷 SSH host key changed

**You see:** `HOST KEY MISMATCH: 192.168.1.10 presented SHA256:..., which is not the key pinned in
/etc/pve1-dash/ssh/known_hosts` (or the same for a VM). Apps & services stop updating.

That happens after reinstalling the host or VM, or regenerating its SSH keys. It is also exactly what an
attacker-in-the-middle would look like, so check before you accept it.

**Step 1.** On the machine itself, print its current key fingerprint **(host, or inside the VM)**:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Compare it with the `SHA256:...` in the log message. Same? Continue. Different? Something else answered on that IP;
stop and find out what.

**Step 2a.** For the **Proxmox host**: re-run the installer (it re-pins the host key and keeps the installed branch or
tag), or by hand **(host)**:

```bash
echo "192.168.1.10 $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"     # copy this line
```

and replace the line starting with `192.168.1.10` in `/etc/pve1-dash/ssh/known_hosts` **(CT)** with it.

**Step 2b.** For a **VM**: delete its line from `/etc/pve1-dash/ssh/known_hosts` **(CT)**; the dashboard pins the new
key on the next contact.

```bash
sed -i '/^192\.168\.1\.60 /d' /etc/pve1-dash/ssh/known_hosts     # the VM's address
systemctl restart pve1-dash
```

---

## 🚫 Helper denied, or apps & services stay empty

**You see:** no apps/services on guests, and in the log one of:
`authentication failed (is the pve1-dash key authorized on the target?)`, `host helper denied "..."`,
`connection refused (is sshd running?)`, `refusing to connect, the host key ... is not pinned`.

**Step 1.** Test the helper the way the dashboard does **(CT)**:

```bash
runuser -u pve1dash -- ssh -i /etc/pve1-dash/ssh/id_ed25519 -o UserKnownHostsFile=/etc/pve1-dash/ssh/known_hosts \
  -o StrictHostKeyChecking=yes root@192.168.1.10 version
```

Expected: `pve1-dash-helper 1`. Go by what you get:

| Output | Meaning | Next |
|---|---|---|
| `pve1-dash-helper 1` | all good on the SSH side | step 4 |
| `Permission denied (publickey)` | key not authorized, or root key logins disabled | step 2 |
| `denied` | the helper got a command it doesn't know: it is older than the dashboard | step 3 |
| `Host key verification failed` | host key not pinned or changed | [SSH host key changed](#-ssh-host-key-changed) |
| `Connection refused` / timeout | sshd not reachable from the container | check sshd on the host and the firewall between them |
| a shell prompt or anything else | the key is authorized **without** the forced command: fix it now | step 2 |

**Step 2.** Is the key line there, exactly once? **(host)**

```bash
grep -n 'pve1-dash' /root/.ssh/authorized_keys
sshd -T | grep -i permitrootlogin            # yes, prohibit-password or forced-commands-only
```

You should see one line `restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 AAAA... pve1-dash@ct<id>`
per dashboard (options you added in front, like `from="..."`, are kept by the installer). Missing, duplicated or
without `restrict,command=`? Refresh it **(host)** (before the merge into `main`, use
`.../claude/homelab-dashboard-pve1-dizt16/deploy/install.sh` as the URL):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)" -- --update-helper
```

If `PermitRootLogin` is `no`, allow forced-command keys only:
`echo 'PermitRootLogin forced-commands-only' > /etc/ssh/sshd_config.d/00-pve1-dash.conf && systemctl reload ssh`.
(Proxmox itself uses root SSH between cluster nodes, so check that a cluster still works afterwards.)

**Step 3.** Update the helper to match the dashboard (same `--update-helper` command as above). It also shows a diff
if the container's copy differs from the repository's.

**Step 4.** Run the helper by hand on the host to see what it collects **(host)**:

```bash
/usr/local/sbin/pve1-dash-helper inventory 101 | head -40      # 101 = a running container
```

Each guest block ends with `@@pve1-dash:end <vmid> <exit code>`; `@@pve1-dash:error ...` lines say why a guest was
skipped (not running, no agent, timeout). Stopped guests and templates are skipped on purpose.

**Step 5.** In the dashboard, open the guest → **Apps** → **Refresh inventory**. The first full sweep can take a minute.

---

## 🤖 Guest agent (VM shows no IP or no apps)

VMs are inspected through the QEMU guest agent (`qm guest exec`) when it is enabled and running; otherwise they need
the [direct SSH setup](SETUP.md#-adding-vms-without-the-guest-agent).

**Step 1.** Is the agent enabled in Proxmox? **(host)**

```bash
qm config 108 | grep '^agent'          # agent: 1   (or agent: enabled=1,...)
```

No line, or `agent: 0`: enable it in the web UI (VM → Options → QEMU Guest Agent), then **fully stop and start** the
VM (a reboot from inside doesn't attach the agent device).

**Step 2.** Is it running inside the VM? **(host)**

```bash
qm guest cmd 108 ping && echo agent-ok
```

`QEMU guest agent is not running`: install and start it **inside the VM** (`apt install qemu-guest-agent`, then
`systemctl enable --now qemu-guest-agent`; on Windows install the VirtIO guest tools).

**Step 3.** Does the inspection work? **(host)**

```bash
/usr/local/sbin/pve1-dash-helper inventory 108 | head -20
```

`exitcode` other than 0 in the JSON, or an `@@pve1-dash:error` line, tells you why. Windows VMs show
`@@pve1-dash:error` by design (the script is POSIX sh); their IPs still show through the agent on PVE 9.

**PVE 8 note:** the dashboard can't use the agent's network API there (it would need `VM.Monitor`), so VM IPs appear
once the SSH inventory has run (step 3 working is enough).

---

## 🔔 Push notifications don't arrive on iPhone

Work through these in order; most problems are in steps 1-3.

**Step 1.** iOS/iPadOS **16.4 or newer**? (Settings → General → About.) Older versions can't do Web Push at all.

**Step 2.** Are you in the **Home Screen app**, not a Safari tab? On iOS, push only works in a web app added via
Safari → Share → **Add to Home Screen** and opened from its icon. In a Safari tab the dashboard explains this instead
of showing the toggle.

**Step 3.** Is the page on **trusted HTTPS**? The address must be your `https://` proxy URL, without certificate
warnings. A private CA must be installed **and** enabled under Settings → General → About → Certificate Trust Settings.

**Step 4.** Enabled on this device? In the app: **Settings → Notifications → Enable on this device**, and allow the
iOS prompt. If you once tapped "Don't Allow": iOS Settings → Notifications → pve1 → Allow Notifications.

**Step 5.** Send a test from the same screen. Then check the log **(CT)**:

```bash
journalctl -u pve1-dash -n 50 --no-pager | grep -i push
```

| Log says | Fix |
|---|---|
| `BadJwtToken` / `check alerts.vapidSubject` | set `alerts.vapidSubject: "mailto:you@your-real-domain"` (not `localhost`, not a `.lan`/`.local` address), restart, then **disable and enable** push on each device |
| `vapidSubject is the placeholder` | same fix |
| `410` / `404`, device removed | the subscription expired or was revoked; enable push on the device again |
| `made with other VAPID keys` / `VapidPkHashMismatch`, device removed | the server's keys changed (reinstall, new data directory, corrupt `push.json`); the device's subscription can never work again. Open the app on the device and turn notifications on again |
| `push.json ... cannot be read`, `Web Push disabled` | the file exists but the service user can't read it (often after copying it back as root). It is left untouched: `chown pve1dash:pve1dash /var/lib/pve1-dash/push.json && chmod 600 /var/lib/pve1-dash/push.json`, then `systemctl restart pve1-dash` |
| `push.json is not valid JSON; kept it as push.json.corrupt-...` | the file was damaged (e.g. a crash); new keys were generated and every device must turn notifications on again. The old file is kept for inspection |
| `publicUrl is not set and a device has no recorded origin` | notifications still arrive (classic format via the service worker), but set `publicUrl` so iOS 18.4+ can show them without waking the app |
| `resolves to a private address; device removed` | the subscription did not point at a public push service; enable push on the device again |
| `too many devices (max 50)` | devices not refreshed for 30 days are replaced automatically; otherwise remove old ones under Settings → Notifications |
| `Web Push disabled: ...` | read the message; usually the subject |
| nothing at all | the push never left: is the device listed under Settings → Notifications → devices? |

Temporary push service errors (429, 5xx, timeouts) are retried twice (after 5 s and 30 s, or the service's
`Retry-After`) before they show up as the device's last error. A device that is never opened is never removed for age
alone, so it keeps getting alerts; delete devices you no longer use (or that show as duplicates) in the devices list.

**Step 6.** Can the container reach Apple? **(CT)**

```bash
curl -sI https://web.push.apple.com | head -1      # any HTTP status line means it is reachable
```

A firewall must allow outgoing HTTPS to `*.push.apple.com` (and `fcm.googleapis.com` for Chrome).

**Step 7.** Still nothing on the phone although the test says sent? Check **Focus** (Do Not Disturb), and the
per-app notification style (iOS Settings → Notifications → pve1 → Lock Screen / Banners). Note that iOS removes a
web app's subscription after a few pushes it couldn't display; enabling again on the device fixes that.

---

## 📡 Live updates stop or never start (SSE through the proxy)

**You see:** the live dot stays amber/red, numbers only change on reload, or other requests hang when several tabs
are open.

**Step 1.** Does the stream work without the proxy? From any machine on the LAN:

```bash
curl -sN http://<container-ip>:8080/api/stream | head -c 300     # "retry: 3000" and an event, immediately
```

Works? The problem is the proxy; continue. Doesn't? See [First checks](#-first-checks).

**Step 2.** Through the proxy:

```bash
curl -sN https://dash.home.lan/api/stream | head -c 300
```

Nothing for a long time, then a burst: the proxy is **buffering**. Add the `/api/stream` block with
`proxy_buffering off` from [deploy/reverse-proxy/README.md](../deploy/reverse-proxy/README.md) (Nginx Proxy Manager:
the Advanced tab).

**Step 3.** Stream drops after about a minute: the proxy's **read timeout** is shorter than it should be. The server
sends a heartbeat every 15 s, so nginx's default 60 s is fine, but some proxies or load balancers use less. Set
`proxy_read_timeout 1h` (nginx/NPM) or the equivalent.

**Step 4.** Hangs with several tabs open: **HTTP/2 is off**, so the browser's 6-connections-per-host limit is used up
by streams. Check:

```bash
curl -s --http2 -o /dev/null -w '%{http_version}\n' https://dash.home.lan/      # should print 2
```

Turn on HTTP/2 in the proxy (NPM: SSL tab → HTTP/2 Support).

**Step 5.** The app doesn't update after a dashboard update: the proxy is caching `sw.js`. In NPM, turn **Cache
Assets off**; elsewhere remove caching for this host. Then reload the page twice (or remove and re-add the Home
Screen app).

**Step 6.** The stream uses a lot of mobile data. Each change resends the whole section it belongs to (for example
all guests with their last 120 CPU/memory samples on every 5 s status poll, or all services with their check history);
there are no deltas. The `services` section is sent at most every 5 s while a check round runs, plus once at its end.
With many guests, a raised `polling.status` (e.g. `15`) reduces the traffic proportionally. Close the app (swipe it
away) rather than leaving it open in the background on cellular.

---

## 🚪 "Unknown host" (HTTP 421)

**You see:** `{"error":"Unknown host", ...}` instead of the dashboard, and the log says
`refused a request for host "..."`.

The server only answers host names that can't be used for a DNS-rebinding attack (see
[SECURITY.md](SECURITY.md#lan-only-no-login)): IP addresses, `localhost`, single-label names, `.lan`/`.local`/
`.home.arpa`/`.internal` names, the host of `publicUrl`, and the names in `allowedHosts`. Add the name you use, e.g.
for a public domain on your proxy or a Tailscale name:

```yaml
publicUrl: https://dash.example.com          # usually enough when the proxy passes the Host header on
allowedHosts: ["dash.example.com", "*.tail1234.ts.net"]
```

Then `systemctl restart pve1-dash`.

---

## 🕐 Times in alerts are off by some hours

Alert texts and notifications contain clock times ("stopped since 14:02"). They are written in the zone set by
`timezone` in config.yaml (an IANA name such as `Europe/Berlin`), defaulting to the `TZ` environment variable and then
the container's system zone. A container created without a time zone is usually **UTC**, so set it:

```yaml
timezone: Europe/Berlin
```

The startup log line `listening on ...` shows the zone in use. Times shown by the web app itself always use the
browser's zone.

---

## 🔥 Temperatures are missing

The temperature card only appears when the host has readable sensors.

**Step 1.** Is lm-sensors installed on the host? **(host)**

```bash
sensors -j | head -20
```

`command not found`: `apt install lm-sensors` (or re-run the installer with `PVE1_DASH_SENSORS=yes`).

**Step 2.** No useful values? Detect the chips once **(host)**:

```bash
sensors-detect          # the defaults are safe; let it add the modules it suggests
systemctl restart systemd-modules-load   # or reboot, to load them
sensors
```

**Step 3.** Does the helper see them? **(host)**

```bash
SSH_ORIGINAL_COMMAND=sensors /usr/local/sbin/pve1-dash-helper | head -5
```

**Step 4.** Wait for the next inventory sweep (up to `inventory.interval`, default 5 minutes) or restart the dashboard
**(CT)**. Disk temperatures come from SMART and don't need lm-sensors.

Some hardware (many VMs-in-VMs, some mini PCs) simply exposes no sensors; then there is nothing to show.

---

## 🧰 Installer problems

**"pveam update did not succeed"** — the template index couldn't be refreshed (DNS, proxy, or
`download.proxmox.com` down); the installer falls back to the cached index. **Step 1:** `pveam update` **(host)** and
read `/var/log/pveam.log`. **Step 2:** if you already have a Debian 13 or 12 template downloaded, the installer uses
it.

**"unsupported debian version"** during `pct create` — the host's pve-container is too old for current Debian 13
templates (13.1+ need pve-container 5.3.1 on PVE 8, 6.0.10 on PVE 9). The installer checks the version up front and
uses Debian 12 by itself (it says so in the plan), and if `pct create` still fails this way it retries once with
Debian 12. You only see this error when you asked for `PVE1_DASH_DEBIAN=13`. **Step 1:** update the host: without a
subscription, first enable the `pve-no-subscription` repository (node → Updates → Repositories; the enterprise one
answers 401 without a subscription), then `apt update && apt full-upgrade`. **Step 2:** or run the installer with
`PVE1_DASH_DEBIAN=12`, which works the same for pve1-dash.

**"got no IPv4 address or DNS within 3 minutes"** — **Step 1:** `pct exec <ctid> -- ip -4 addr show eth0` **(host)**.
No address: DHCP on that bridge/VLAN isn't answering. Re-run the installer with a static address,
`PVE1_DASH_IP=192.168.1.60/24 PVE1_DASH_GATEWAY=192.168.1.1` (and `PVE1_DASH_BRIDGE=...` / `PVE1_DASH_VLAN=...` if those
were wrong): on a re-run they are applied to the existing container (its `net0` changes, the MAC address stays, and it
restarts). By hand: `pct set <ctid> --net0 name=eth0,bridge=vmbr0,ip=192.168.1.60/24,gw=192.168.1.1` (keep the
`hwaddr=` from `pct config <ctid>`), then re-run. With a VLAN, the gateway is the router of that VLAN, not the host's.
**Step 2:** address but no DNS: `pct exec <ctid> -- cat /etc/resolv.conf`; the container inherits the host's DNS
settings.

**"container ... was created but does not start"** — `pct create` can report success even though the container
then fails to start; the installer checks and shows the start error. A missing bridge is the usual cause. Fix it and
re-run with `PVE1_DASH_BRIDGE=<existing bridge>` (applied to the existing container), or remove the container
(`pct destroy <ctid>`) and start over.

**"... is not pve1-dash" / "could not download package.json" / "is not a branch or tag"** at the start — the ref
doesn't hold pve1-dash. Until pve1-dash is merged into `main`, `main` still has the old Tiny Ecowitt app: install with
`PVE1_DASH_REF=claude/homelab-dashboard-pve1-dizt16` and the installer URL of that branch (README.md). For a single
commit, give its full 40-character id.

**"container ... was installed from <repository>"** on a re-run — the container records a repository other than the
default (e.g. your fork). Answer yes to keep it, or with `--yes` pass `PVE1_DASH_REPO=<that repository>` (or the
default one to switch). It asks because that repository also decides which host helper may run as root.

**npm build killed / "JavaScript heap out of memory"** — give the container 1024 MiB or more (container → Resources →
Memory), then run the installer again.

**Service fails with `status=226/NAMESPACE`** — systemd's sandbox needs the container's **nesting** feature. The
setup and update scripts detect this and add a drop-in that turns the namespace options off
(`/etc/systemd/system/pve1-dash.service.d/10-lxc-compat.conf`). To get the sandbox back: enable Options → Features →
Nesting on the container, delete that file, `systemctl daemon-reload && systemctl restart pve1-dash` **(CT)**.

**Service starts, then fails with `EPERM` / "operation not permitted" errors in the log** — the unit's syscall filter
(`SystemCallFilter=@system-service`) may block something this Node.js/kernel combination needs; this couldn't be
tested in a real unprivileged container. **Step 1:** `systemctl edit pve1-dash` **(CT)** and add
```ini
[Service]
SystemCallFilter=
```
(an empty value turns the filter off). **Step 2:** `systemctl restart pve1-dash`. If that fixes it, please open an
issue with the log lines so the filter can be adjusted.

**"the container's helper differs from the copy in the repo"** — the container runs a different version than the ref
the installer compares with (it compares with the commit the ref points to now). **Step 1:** update the container
(`pct exec <ctid> -- pve1-dash-update`). **Step 2:** run `--update-helper` again. If you deliberately run another ref,
pass it: `PVE1_DASH_REF=<ref>`. The installer shows the first 60 lines of the diff, with bytes outside printable ASCII
as `\xNN`, and keeps the whole diff in `/var/log/pve1-dash-helper.diff`: read it before you answer yes, since the
helper runs as root on the host.

**Re-running the installer upgraded the code and the new version doesn't start** — like `pve1-dash-update`, the setup
restores the previous version (the failed build stays in `/opt/pve1-dash.failed`) and keeps the recorded source. To stay
on a known-good version, re-run with `PVE1_DASH_REF=<tag>`.

**The update or installer says the service is not healthy, but it runs** — the health check uses `listen.host` and
`listen.port` from `/etc/pve1-dash/config.yaml` (127.0.0.1 for `0.0.0.0`) and `PVE1_DASH_PORT` from
`/etc/pve1-dash/env`. If you bound `listen.host` to an address the container doesn't have, fix it there.

**An update failed** — `pve1-dash-update` restores the previous version automatically when the new one doesn't come up;
the failed build stays in `/opt/pve1-dash.failed` for a look. Run it again later, or pin a known-good tag with
`--ref`. A failed Node.js update (download, checksum, unpack, e.g. a full disk) never touches the working Node.js; the
update says "keeping v24.x.y" and goes on.

**`uninstall.sh --yes` changed nothing** (older versions) — they stopped at "Continue?". Current versions go ahead with
`--yes`; `PVE1_DASH_CONFIRM=no` still stops them. The uninstaller removes one dashboard (`--ctid N` picks which) and
leaves other pve1-dash dashboards in the cluster working.

---

## 💽 Disk health updates slowly, or HDDs don't stay spun down

The dashboard lists the disks every `polling.disks` seconds (default 600) with `skipsmart=1`, so Proxmox doesn't run
`smartctl` for that listing. Health (`PASSED` / `FAILED!`) and SSD wear come from a full listing that runs
`smartctl -H` on every disk. That full listing runs once every 6 hours (or every `polling.disks`, if you set that
longer), and right away when a new or replaced disk shows up.

- **A SMART failure can take up to 6 hours to show up and alert.** For a live reading, open the disk in the dashboard:
  that asks Proxmox for this one disk's SMART data.
- **Spun-down HDDs wake up for each full listing**, so 4 times a day by default. `smartctl` doesn't skip sleeping disks
  (Proxmox doesn't pass `-n standby`). To wake them less often, raise `polling.disks` (`86400` means once a day; the
  disk list itself then refreshes once a day too).
- Even with `skipsmart=1`, Proxmox's disk listing runs `lsblk` and LVM/ZFS queries. Whether these touch a sleeping
  disk depends on your LVM device filter (not verified). `smartd` and other tools on the host can also wake disks.

---

## 🛑 A VM is "paused on an I/O error"

The alert and the guest status **I/O error** mean the VM's QEMU process is halted in an error state. The dashboard
currently shows three QEMU states this way:

- `io-error`: a disk write failed (storage full, NFS/iSCSI target gone).
- `guest-panicked`: the guest kernel panicked. This only happens with a pvpanic device and the "pause" panic action.
- `internal-error`: KVM/QEMU itself failed (an emulation error, or a problem with nested virtualization).

**Step 1.** Find out which one it is **(host)**:

```bash
qm status <vmid> --verbose | grep qmpstatus      # qmpstatus: io-error | guest-panicked | internal-error
```

**Step 2.** For `io-error`, check the storage (`pvesm status`). For the other two, read the VM's log lines
(`journalctl -b | grep -i 'qemu\|kvm'`). Then `qm resume <vmid>` once the cause is fixed, or stop and start the VM.

Memory and uptime of a paused, suspended or halted VM are still shown: its QEMU process keeps holding the RAM.

---

## ❓ Things that could not be tested on real Proxmox

The scripts were checked with `bash -n`, ShellCheck and tests with stand-ins for the Proxmox tools, and the
in-container setup and update ran end to end in an isolated environment (with apt and systemd simulated). These
details come from reading Proxmox's source and couldn't be run on a real host, so if one of them misbehaves, this list
is the first place to look:

- `pct push` / `pct pull` (installing the setup script and fetching the helper), `pct start` / `pct stop` /
  `pct destroy` / `pct set --onboot 0` (uninstaller) and `pct set --net0` (network change on a re-run) are used in
  their basic forms only; they are standard but weren't covered by the research notes.
- `/root/.ssh/authorized_keys` is rewritten by renaming a complete copy over `/etc/pve/priv/authorized_keys`, inside
  pmxcfs. Should pmxcfs refuse the rename, the scripts rewrite the file in place and read it back; the backup is in
  `/root/.ssh/authorized_keys.pve1-dash.bak` either way.
- The format of ACME entries in `/etc/pve/nodes/<node>/config` (`acmedomain0: ...`), used only to propose a host name;
  the certificate itself is verified before the name is used.
- `pveum user token remove` vs `pveum user token delete`, and `pveum user delete`: the scripts try both spellings.
- `pveam download` may exit 0 on failure, so the installer checks `pveam list` afterwards.
- Whether the PVE 8 template index lists `debian-13-standard`; the installer falls back to Debian 12.
- systemd sandboxing inside an unprivileged container with nesting (the unit drops options known to need more than
  nesting gives; the 226/NAMESPACE fallback covers the rest).
- Whether Apple rejects VAPID contacts on made-up domains like `.lan` (it does for `localhost`); the installer insists
  on a real-looking address to be safe.
- HTTP Basic auth at the proxy in combination with the iOS Home Screen app.
- How long iOS keeps the live stream open in the background (the app reconnects when it comes back to the front).
- The host helper enters containers with `pct exec --keep-env 0`, so they don't inherit root's host environment. The
  research notes don't confirm the `PATH` that `lxc-attach --clear-env` sets. The inspection script sets its own
  `PATH` and is started as `/bin/sh` by absolute path, so this shouldn't matter.
- The host helper lists VMs with `pvesh get /nodes/<node>/qemu --full 1` to read their QEMU state (`qmpstatus`), so
  paused VMs are skipped. Like `qm list`, this asks each running VM over QMP.
