---
name: pve1-dash-install
description: "Use when installing pve1-dash on the Proxmox host pve1 for the first time, re-running the installer (upgrade, repair, static IP, publicUrl or allowedSources change, token rotation), refreshing the host helper, setting up Nginx Proxy Manager and DNS for dash.bgreen.cloud, enabling Web Push on the owner's iPhone, verifying an install with pve1-dash-doctor, or uninstalling the dashboard. Other config edits (launcher tiles, alert rules, polling, board title): see pve1-dash-troubleshoot."
---

# Installing and maintaining pve1-dash on pve1

The reference is `docs/SETUP.md` (every installer question, what it creates, manual install, updating,
uninstalling). Use this skill for the order of work and the answers that fit this homelab. Each command says where it
runs: **host** = pve1 as root, **CT** = the dashboard container (`pct exec <ctid> -- ...`), **LAN** = any machine on
10.10.10.0/24 or 10.10.20.0/24.

## Ground rules

- Anything that changes the host, the container or any other guest needs the owner's explicit OK first. That covers the installer,
  `--update-helper`, the uninstaller, `pct set`, and config edits. Say what will change before you ask.
- **The owner runs the installer in their own terminal**: an SSH session, or the web UI's **>_ Shell** arrow →
  **xterm.js**. Never use the embedded Shell panel, which kills the 5-10 minute run when it is closed. The installer asks
  interactive questions, and your Bash tool has no terminal for them. If it gets cut off, running the same command again
  continues where it stopped.
- The owner types their email at the prompt. Never write it into a file, the repo or a summary.
- Go one or two steps at a time and report back between them.

## 1. Pre-flight (read-only)

**main must contain the current code**, because the one-liner fetches `install.sh` from `main` and installs `main`:

```bash
# host or LAN: must print a number > 0 (the pre-merge main printed 0)
curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh | grep -c PVE1_DASH_ALLOWED_SOURCES
```

(raw.githubusercontent.com caches branch URLs for a few minutes after a push.)

Facts to collect on the **host** (all read-only):

| Command | Why |
|---|---|
| `pveversion` | PVE 8 or 9 (below 8 is refused; above 9 asks `PVE1_DASH_CONTINUE_UNTESTED`) |
| `pvesm status --content rootdir` · `pvesm status --content vztmpl` | the storages that allow container disks (here: `local-lvm` is the default; also `nvme-thin`, `local-ssd`, `kingstonssd`) and templates (`local`); the installer lists them the same way |
| `ip -br addr` and `ip route show default` | `vmbr0` (untagged = Main 10.10.20.0/24, pve1 = 10.10.20.241) and the router 10.10.20.1 |
| `sshd -T \| grep -i permitrootlogin` | must be `yes`, `prohibit-password`, `without-password` or `forced-commands-only` (the installer only warns) |
| `ls -l /etc/pve/local/pveproxy-ssl.pem` | present means a custom or ACME cert on :8006, and the installer will ask `PVE1_DASH_PVE_HOST`; absent means the default cert, so CA mode |
| `timedatectl show -p Timezone --value` | becomes `timezone:` in a new config (override: `PVE1_DASH_TIMEZONE`) |
| `pvesh get /nodes/pve1/lxc --output-format json` | does a container tagged `pve1-dash` already exist? (then it is a re-run, see section 7) |

Then ask the owner:

1. Already answered for this homelab (see `CLAUDE.md` → This homelab): NPM = 10.10.10.13 (VM 102), and the UDM
   **does forward WAN :80/:443 to NPM**, so the Access List in section 5 is mandatory.
2. Already answered: static **10.10.20.5/24**, gateway 10.10.20.1 (outside the .6-.254 DHCP pool). NPM forwards to
   this IP, so it must not move.
3. Any preferred container ID? (The default is the next free one.)
4. Do they want **lm-sensors** on the host for CPU temperatures? (The default is no.)

## 2. Answers for this homelab

| Question | Answer here | Env var (unattended) |
|---|---|---|
| Container ID / hostname | next free / `pve1-dash` | `PVE1_DASH_CTID` / `PVE1_DASH_HOSTNAME` |
| Disk storage / size / template storage | `local-lvm` / 6 / `local` | `PVE1_DASH_STORAGE` / `PVE1_DASH_DISK` / `PVE1_DASH_TEMPLATE_STORAGE` |
| Bridge / VLAN | `vmbr0` (confirm in pre-flight) / none | `PVE1_DASH_BRIDGE` / `PVE1_DASH_VLAN` |
| IPv4 / gateway | `10.10.20.5/24` + `10.10.20.1` | `PVE1_DASH_IP` / `PVE1_DASH_GATEWAY` |
| Cores / memory / swap | 1 / 1024 / 512 (the build needs 1 GiB) | `PVE1_DASH_CORES` / `PVE1_DASH_MEMORY` / `PVE1_DASH_SWAP` |
| Proxmox host IP | detected (10.10.20.241) | `PVE1_DASH_NODE_IP` |
| Public HTTPS URL | `https://dash.bgreen.cloud` | `PVE1_DASH_PUBLIC_URL` |
| Email for Web Push | the owner's real address (they type it) | `PVE1_DASH_VAPID_EMAIL` |
| Allow connections from | `10.10.10.0/24 10.10.20.0/24` (the installer's default, pve1's own /24, would leave out NPM) | `PVE1_DASH_ALLOWED_SOURCES` |
| lm-sensors | the owner's choice | `PVE1_DASH_SENSORS` |
| Host name on the certificate | only asked for a custom/ACME cert, and only when a **new** config is written: its DNS name (must resolve to pve1 inside the CT) | `PVE1_DASH_PVE_HOST` |

`bash deploy/install.sh --help` (from a checkout, no side effects, but it prompts every time because it matches an
ask rule) lists the flags and the documented variables.
Three more work but are not listed there: `PVE1_DASH_TIMEZONE`, `PVE1_DASH_PROCEED` (the "Go ahead?" answer) and
`PVE1_DASH_CONTINUE_UNTESTED`.

## 3. Run it (owner, host)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)"
```

Unattended form, only if the owner wants it. They put in their own email:

```bash
PVE1_DASH_VAPID_EMAIL=<their email> PVE1_DASH_PUBLIC_URL=https://dash.bgreen.cloud \
PVE1_DASH_ALLOWED_SOURCES="10.10.10.0/24 10.10.20.0/24" PVE1_DASH_IP=10.10.20.5/24 PVE1_DASH_GATEWAY=10.10.20.1 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)" -- --yes
```

Even with `--yes`, three questions come **after** "Go ahead?" and can still matter:

- `PVE1_DASH_ROTATE_TOKEN`: with `--yes`, the token is rotated automatically when the container's secret is missing or rejected.
- `PVE1_DASH_PVE_HOST`: asked only for a custom/ACME cert, and only applied when a new config is written (see
  section 7 for an existing install).
- `PVE1_DASH_TRUST_CT_HELPER`: defaults to no, and then the run stops with "helper not installed".

The installer runs 9 steps: Preflight, Settings, Container template, Container, Read-only API token, Dashboard inside
the container, Host helper and SSH key, Temperatures, Smoke test. At the end it runs the doctor. Its log is
`/var/log/pve1-dash-install.log` (host), which includes the full in-container setup output. If it fails, see
`docs/TROUBLESHOOTING.md#-installer-problems`. Many host-side steps were never run on real Proxmox; the list is in
`docs/TROUBLESHOOTING.md#-things-that-could-not-be-tested-on-real-proxmox`.

## 4. Verify (read-only)

```bash
pvesh get /nodes/pve1/lxc --output-format json          # host: find <ctid> (tags contain pve1-dash)
pct exec <ctid> -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 TERM=dumb NO_COLOR=1 pve1-dash-doctor
                                                        # host: the installer's own form; the short form is `pct exec <ctid> -- pve1-dash-doctor`
pct exec <ctid> -- curl -s http://127.0.0.1:8080/healthz # host: {"ok":true}
pct exec <ctid> -- cat /etc/pve1-dash/install.env        # host: PVE1_DASH_REF=main
SSH_ORIGINAL_COMMAND=version /usr/local/sbin/pve1-dash-helper   # host: "pve1-dash-helper 2"
pveum user token permissions pve1dash@pve dashboard --path /    # host: only *.Audit privileges (unverified on a real host)
pct exec <ctid> -- ip -4 addr show eth0                  # host: the container IP that NPM must forward to
pct config <ctid> | grep net0                            # host: hwaddr= is the MAC for a DHCP reservation
```

Doctor exit code: 0 means nothing failed (warnings are fine), 1 means a check failed. The reverse-proxy checks
(`proxy.*`) only mean something once NPM and DNS are set up. They need an https `publicUrl`, and the container must
be able to resolve `dash.bgreen.cloud`. Until then, read their result as "not set up yet", not as a broken install.

## 5. Nginx Proxy Manager and DNS (owner, in the NPM UI)

Follow the NPM recipe in `deploy/reverse-proxy/README.md`, with these values:

- **Details**: Domain `dash.bgreen.cloud`; scheme `http`; forward to `<container IP>` port `8080`; **Cache Assets OFF**;
  Websockets ON; **Access List** `allow 10.10.10.0/24` + `allow 10.10.20.0/24` + `deny all` (named "LAN only"). This is
  mandatory here: the UDM forwards WAN :443 to NPM, so "Publicly Accessible" would put the dashboard on the internet. The dashboard sees NPM as the client, so whatever NPM lets in passes
  `allowedSources`, and the app has no login.
- **SSL**: the Let's Encrypt certificate (DNS challenge), Force SSL ON, **HTTP/2 ON**.
- **Advanced tab: no `location` block, ever.** One there bypasses the Access List. Per-path settings go in Custom
  Locations (pve1-dash needs none). Leave the tab empty, except for the optional hardening line below.
- **The Access List has a gap:** NPM trusts the `X-Real-IP` header from every private address, so a client on any
  private network (an IoT VLAN, say) can send `X-Real-IP: 10.10.10.5` and pass `allow 10.10.10.0/24`. The app's
  `allowedSources` can't stop that, because it only sees NPM. The real fix is to block IoT → LAN at the router; the
  documented optional hardening is the single line `set_real_ip_from 127.0.0.1;` in this host's Advanced tab
  (`docs/SECURITY.md`, section "LAN only, no login"; taken from NPM's source, not tested inside NPM).
- DNS: `dash.bgreen.cloud` must resolve to NPM's LAN address for LAN clients. How the owner does that (split DNS or
  a local record) is not recorded, so ask.

Check from a **LAN** machine (read-only):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://dash.bgreen.cloud/api/snapshot
#   200 ok · 403 see below · 421 the Host gate refused the name (publicUrl/allowedHosts set, but not to dash.bgreen.cloud) · 502 NPM can't reach the CT
curl -s --http2 -o /dev/null -w '%{http_version}\n' https://dash.bgreen.cloud/      # 2
curl -sN --max-time 5 https://dash.bgreen.cloud/api/stream | head -c 300            # "retry: 3000" then an event
```

A 403 has two possible sources, so read its body. The dashboard's own says `listen.allowedSources` (JSON) or "Not
allowed from this network" (HTML), and means NPM's IP is not in `listen.allowedSources`. Any other 403 page comes
from NPM's Access List, so check that instead.

LAN-only check, from a device **outside** both LANs that can still reach NPM (a guest/IoT VLAN), and from a phone
on mobile data with Wi-Fi off. Both commands must print 403 or fail to connect, and the page must not load:

```bash
curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' https://dash.bgreen.cloud/api/stream
curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' -H 'X-Real-IP: 10.10.10.5' https://dash.bgreen.cloud/api/stream   # the spoof test
```

If only the spoof test gets through (200), the `X-Real-IP` gap above is open: tell the owner, and offer router
separation or the hardening line.

`/healthz` bypasses both access gates, so a 200 there proves nothing about pages or the API. To find NPM's address
after a dashboard 403, read the 403 body (it names the address), or run
`pct exec <ctid> -- journalctl -u pve1-dash --no-pager | grep 'refused a connection'` (host). To fix it (with OK),
the owner runs `pct enter <ctid>`, then `pve1-dash-config`, and adds NPM's IP to `listen.allowedSources` (it validates,
saves and restarts). Re-running the installer with `PVE1_DASH_ALLOWED_SOURCES="10.10.10.0/24 10.10.20.0/24"` also works,
but that is a full rebuild and upgrade (section 7), so offer it second, when an upgrade is wanted anyway.

## 6. Push on the owner's iPhone

These need iOS 16.4+, the HTTPS URL above, and a real `alerts.vapidSubject`. The steps are in
`docs/SETUP.md#-web-push-on-iphone-and-ipad`:

1. Open https://dash.bgreen.cloud in Safari.
2. Share → Add to Home Screen.
3. Open the Home Screen app (push never works in a Safari tab).
4. Settings → Notifications → Enable on this device.
5. Send test.

If it fails, see `docs/TROUBLESHOOTING.md#-push-notifications-dont-arrive-on-iphone`. Never delete
`/var/lib/pve1-dash/push.json`: it holds the only copy of the VAPID keys, and every device would have to re-enable push.

## 7. Re-run, upgrade, repair

- **Update the app** (CT change, ask first): `pct exec <ctid> -- pve1-dash-update`, with the Bash tool's maximum
  timeout (600000 ms) or in the background (it takes minutes; `CLAUDE.md` → Gotchas). It builds next to the running
  copy, swaps, rolls back if `/healthz` fails, then runs the doctor. It needs about 1 GiB free; if not,
  `pct resize <ctid> rootfs +2G` (host, cannot be undone).
- **Re-run the one-liner** to repair, upgrade or change the network. It finds the container by its `pve1-dash` tag
  and keeps config, data and the recorded ref, but every re-run is a full 5-10 minute rebuild: apt in the CT, a
  checkout of the **newest commit** of the recorded ref (an unplanned upgrade if `main` moved), build, swap, restart,
  a token check, and it re-pins a changed Proxmox certificate. Env vars such as `PVE1_DASH_PUBLIC_URL`,
  `PVE1_DASH_ALLOWED_SOURCES`, `PVE1_DASH_IP` and `PVE1_DASH_GATEWAY` apply to the existing container (the network
  change restarts it; the MAC stays).
- **Change only `publicUrl` or `allowedSources`** (CT, ask first): use `pve1-dash-config` (owner: `pct enter <ctid>`,
  then `pve1-dash-config`; it validates, saves and restarts). Offer the re-run only when an upgrade is wanted anyway.
  Other settings (launcher tiles, alert rules, polling, board title) are the same edit; the troubleshoot skill has the
  form without a terminal.
- **Helper refresh**, when `pve1-dash-update` says the helper changed, or after a PR that changed the helper was
  merged (the notice appears only in the update that changed it), or whenever the CT and host helper hashes differ
  (`CLAUDE.md` → Gotchas) (host, ask first):
  `bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)" -- --update-helper`.
  When the container's helper differs from the repo copy, it shows a diff and asks on the terminal, which your Bash
  tool doesn't have, so it stops with "no terminal to ask". Then stop too: the owner reads
  `/var/log/pve1-dash-helper.diff` and re-runs the command in their own SSH or xterm.js terminal, because the helper
  runs as root. Never preset `PVE1_DASH_TRUST_CT_HELPER=yes` to get past it (`--yes` answers no there).
- **Token rotation** (revokes the old secret, ask first): `PVE1_DASH_ROTATE_TOKEN=yes` in front of the one-liner.
- **`:8006` moved to an ACME certificate after the install**: `PVE1_DASH_PVE_HOST` only applies when a new config is
  written. On an existing install, a re-run (with or without it) pins the new certificate instead, and that pin
  breaks at the next renewal (60-90 days). Switch by hand, with the owner's OK:
  1. (host) the installer's own test, which must print `Verify return code: 0 (ok)`:
     `openssl s_client -connect 127.0.0.1:8006 -servername <name> -verify_hostname <name> -CAfile /etc/ssl/certs/ca-certificates.crt </dev/null 2>&1 | grep 'Verify return'`
  2. (host) `pct exec <ctid> -- getent ahostsv4 <name>` must return pve1's 10.10.20.241 (note: the LAN wildcard `*.bgreen.cloud` points at NPM, so a
     `*.bgreen.cloud` name needs its own record first).
  3. (CT) With `pve1-dash-config`: under `proxmox.tls`, remove the `ca:` or `fingerprint:` line, and set
     `proxmox.url` to `https://<name>:8006`. It saves and restarts.

  If step 1 fails, look at the names and chain the cert really has (host, read-only):
  `openssl s_client -connect 127.0.0.1:8006 </dev/null 2>/dev/null | openssl x509 -noout -ext subjectAltName -issuer`.
  If step 2 fails (nothing, or a public IP), the owner adds a local or split-DNS record `<name>` → 10.10.20.241
  on the router or DNS server the CT uses, then repeat step 2. The installer falls back to a pin in both cases. If the
  dashboard must come back first, a temporary pin with the doctor's `pve.tls` fix (its `sed` on `ca:`/`fingerprint:`)
  is fine with the owner's OK, but it breaks at the next renewal, so the switch must still be finished.
- Watch out:
  - `--ctid N` for an id that is **not** tagged `pve1-dash` means a *new* install, and it dies if the id is in use.
  - A recorded commit id is not kept by a re-run unless you pass `PVE1_DASH_REF=<full sha>`.
  - Never use `PVE1_DASH_REF=1.0`. That tag is the old Tiny Ecowitt app.

## 8. Uninstall (destructive, needs explicit OK)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/uninstall.sh)"   # host
```

The owner runs it in their own terminal, like the installer, because it asks questions. It removes the container's
`authorized_keys` line and the helper (if no other local dashboard uses it). It asks four questions, in this order:
**Continue?** (default no; yes with `--yes`); remove the API token, plus the user `pve1dash@pve` if it was the last
dashboard (default yes; it is removed last); **destroy** the container (default **no**; destroying loses push devices
and history); and, if not destroyed, stop it and turn off onboot (default yes). Answering `y` to the destroy question
destroys it, so read the prompts with the owner. With `--yes`, the defaults apply and only `PVE1_DASH_DESTROY_CT=yes` destroys the container. lm-sensors
stays. `authorized_keys` is backed up to `/root/.ssh/authorized_keys.pve1-dash.bak` first. Details:
`docs/SETUP.md#-uninstalling` and `bash deploy/uninstall.sh --help`.
