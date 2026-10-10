# 🛡️ Security model

pve1-dash is a **read-only window** onto one Proxmox VE node for your own LAN. It has no power buttons, no console of
its own and no login. This page explains what it can reach, what it deliberately can't, and what you should do
around it.

**TL;DR**

- It reads Proxmox through an **API token with the built-in `PVEAuditor` role** (audit privileges only).
- It reads "what runs inside guests" through **one SSH key pinned to a read-only script** (`restrict,command=...`).
  That key can't open a shell, forward ports, or run anything else.
- It has **no login**: keep it on your LAN behind your HTTPS reverse proxy, and **never port-forward it to the
  internet**. Want a login anyway? Add it at the proxy (IP allow-list or SSO).
- Secrets live in the container with tight permissions; nothing secret is sent to the browser.

## What we protect, and from whom

| Asset | Threat | Defense |
|---|---|---|
| Your Proxmox host | a bug or compromise in the dashboard container turning into control of the host | read-only token; forced-command SSH key; host helper with a strict allow-list; no root password in the container |
| Guests (VMs/containers) | the dashboard being used to run commands in guests | the helper runs one fixed, read-only inspection script; no API privilege that allows guest exec (see `VM.Monitor` below) |
| The API token secret | theft from the container, leaking on the wire | file readable only by root and the service user; TLS to Proxmox pinned **before** any request byte is sent |
| Your homelab's inventory (names, IPs, ports, services, backups) | anyone else on your network looking at the dashboard | LAN only, behind your proxy; add proxy auth/IP allow-list if your LAN isn't just you |

Out of scope: someone who already has root on the Proxmox host, or physical access.

## The API token

The installer creates the user `pve1dash@pve` (no password, so it can't log in to the web UI) and the
**privilege-separated** token `pve1dash@pve!dashboard`, and grants the built-in role **`PVEAuditor` on `/`** to both
(a privilege-separated token only gets what *both* the user and the token are granted).

`PVEAuditor` contains only audit privileges:

| PVE 8 | PVE 9 |
|---|---|
| `Datastore.Audit`, `Mapping.Audit`, `Pool.Audit`, `SDN.Audit`, `Sys.Audit`, `VM.Audit` | the same plus `VM.GuestAgent.Audit` |

With that the dashboard can read node status and history, guests and their configs, storage, ZFS, disks and SMART,
the network config, tasks and their logs, backup jobs and coverage, the certificate info and subscription status.
It **cannot** start/stop/migrate anything, open a console, change config, read or write guest files, or run commands.

Things worth knowing:

- `Sys.Audit` also lets the token read **all task logs** and the **subscription key**. The dashboard passes task logs
  to the browser on request (they can mention file names and guest names); it never sends the subscription key.
- Listing pending updates (`/apt/update`) needs `Sys.Modify`, which is **not** read-only, so the dashboard reads the
  same data from `/var/lib/pve-manager/pkgupdates` through the SSH helper instead.
- Proxmox silently hides backup files from audit-only tokens, so the backup list also comes through the helper
  (`pvesh ... --content backup`, run as root but read-only).

To rotate the token: run the installer again and answer "yes" to rotating (or `PVE1_DASH_ROTATE_TOKEN=yes`). To
revoke it: Datacenter → Permissions → API Tokens → remove.

### Why not VM.Monitor on PVE 8

On PVE 8, the guest-agent API (for example `agent/network-get-interfaces`, to learn a VM's IPs) requires the
privilege **`VM.Monitor`**. It looks harmless, but in PVE 8 it is also the *only* check on `agent/exec`,
`agent/file-read`, `agent/file-write` and `agent/set-user-password`. A token with `VM.Monitor` can therefore **run any
command as root inside every VM with a guest agent**, and shut it down or suspend it. That is not read-only at all,
so pve1-dash never asks for it. On PVE 8 it gets guest IPs and agent info from the SSH helper (`qm guest exec` with a
fixed script) instead, and logs a short note when the API answers 403.

PVE 9 dropped `VM.Monitor` and split the agent privileges: `VM.GuestAgent.Audit` (part of `PVEAuditor`) covers only
informational commands such as `network-get-interfaces`, `get-osinfo` and `ping`. Command execution needs separate
privileges the dashboard doesn't have.

## The SSH helper

The dashboard container holds one ed25519 key (`/etc/pve1-dash/ssh/id_ed25519`, readable only by the service user).
On the Proxmox host it is authorized with:

```
restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 AAAA... pve1-dash@ct120
```

- **`command=`**: whatever the client asks to run is ignored; sshd always runs the helper, which gets the request only
  as the text `SSH_ORIGINAL_COMMAND` and checks it against a short allow-list. It never `eval`s it or hands it to a
  shell.
- **`restrict`**: no PTY, no port/agent/X11 forwarding, no `~/.ssh/rc`.

What the key **can** do (the complete list, [HELPER_PROTOCOL.md](HELPER_PROTOCOL.md)):

| Request | What happens (as root on the host) |
|---|---|
| `version` | prints the protocol version |
| `inventory [vmid]` | for each **running** container: `pct exec` of a fixed, read-only inspection script; for each running VM **with the guest agent enabled**: `qm guest exec` of the same script. It reports OS release, kernel, uptime, load, running services, Docker containers (name, image, state, ports), IP addresses and listening TCP ports. Each guest is time-limited. |
| `sensors` | `sensors -j` (only if lm-sensors is installed) |
| `pkgupdates` | prints `/var/lib/pve-manager/pkgupdates` (the pending updates list Proxmox already keeps) |
| `backups <storage>` | lists backup volumes of one storage as JSON (the storage id is checked against a strict pattern) |

What it **cannot** do: run any other command, get a shell, read or write arbitrary files, change anything in Proxmox
or in guests, start/stop guests, or reach other machines through the host.

Honest caveats:

- The helper runs **as root** on the host, and the inspection script runs **as root inside guests** (that is how
  `pct exec`/`qm guest exec` work). The script only reads, but it is code that runs with full power: it is installed by
  root, owned by root, and `install.sh` cross-checks the copy from the container against the repository before
  installing it (the container is treated as less trusted than the host). Review it if you like; it is short and
  commented.
- If the container is compromised, the attacker gets what the helper prints: your guests' service lists, Docker
  containers, IPs and open ports, pending updates, backup lists and temperatures. Nothing more.
- `/root/.ssh/authorized_keys` on Proxmox is a symlink to `/etc/pve/priv/authorized_keys`, **shared by every node of a
  cluster**. The key line therefore exists on all nodes; on nodes without the helper installed, sshd tries to run a
  missing file and the login simply fails (there is no fallback to a shell).
- Optional extra fence when the container has a static IP: prefix the line with `from="192.168.1.60",` so the key only
  works from that address. (The installer doesn't add it because DHCP addresses change; re-running
  `install.sh --update-helper` rewrites the line, so add it again afterwards.)
- The pve1 host key is pinned from `/etc/ssh/ssh_host_ed25519_key.pub` at install time; the dashboard refuses to
  connect if it changes ([TROUBLESHOOTING.md](TROUBLESHOOTING.md#-ssh-host-key-changed)).

**VMs without the guest agent** get the same pattern: `/setup/guest.sh` installs
`/usr/local/sbin/pve1-dash-guest-inventory` (only `inventory` and `version`) and a
`restrict,command="/usr/local/sbin/pve1-dash-guest-inventory"` line for root in that VM. Their host keys are learned on
first contact (trust on first use) and pinned in `/etc/pve1-dash/ssh/known_hosts` afterwards; a changed key is refused.

## LAN only, no login

The dashboard has **no accounts and no login**. That is a deliberate choice for a personal, read-only homelab screen,
and it means: **anyone who can reach it can see everything it shows** (guest names, IPs, services, ports, task logs,
backup status). They can't change your Proxmox, but a few dashboard-local actions exist without a login:

- register a browser for push notifications, change or remove push devices, send a test push;
- ask for an early inventory refresh (rate limited).

So:

1. Keep it on your LAN (or VPN: WireGuard/Tailscale for remote access). **Do not port-forward it** and don't publish it
   through a public tunnel without authentication.
2. Put it behind your HTTPS reverse proxy ([deploy/reverse-proxy/README.md](../deploy/reverse-proxy/README.md)).
3. If your LAN has other people, guests or IoT devices you don't trust, **add a gate at the proxy**: an IP allow-list
   (friendliest with the iPhone Home Screen app) or SSO forward-auth (Authelia, Authentik). Plain HTTP Basic auth
   also works in browsers; its behaviour in the iOS Home Screen app is UNVERIFIED.
4. The container listens on plain HTTP port 8080. If you can, let only the proxy reach it (Proxmox firewall on the
   container: allow 8080 from the proxy's IP).

The **console buttons** only deep-link to Proxmox's own noVNC/xterm.js console. Proxmox asks for your normal Proxmox
login there; the dashboard's token can't open consoles.

## In the browser

Every response carries:

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob: https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline';
  script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none';
  base-uri 'self'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
X-Frame-Options: DENY
```

- Scripts only from the dashboard itself: no inline scripts, no third-party JavaScript, no analytics.
- The only outside request the page makes is for **app icons** from `cdn.jsdelivr.net` (the open-source
  dashboard-icons set). That tells jsDelivr your IP and which icon names you use. Use your own image URLs in
  `services.items[].icon` if you'd rather not.
- `'unsafe-inline'` is allowed for **styles only** (needed for live layout values); scripts stay locked down.
- Guest notes (the Proxmox description field) are shown as plain text, never as HTML.
- HSTS is left to your proxy, which owns TLS.
- No cookies. Your theme and similar preferences stay in the browser's `localStorage`.
- Web Push payloads are end-to-end encrypted to each device (RFC 8291); Apple/Google/Mozilla's push services only
  see ciphertext and the target device. The VAPID keys never leave the container.

## TLS to Proxmox

The installer pins the **SHA-256 fingerprint** of the certificate pveproxy serves (`proxmox.tls.fingerprint`). On
every new connection the dashboard compares the certificate with the pin **before** it sends any request, so the token
never goes to an impostor. TLS session resumption is off, so every connection is checked.

The flip side: when the certificate is renewed (an ACME/Let's Encrypt cert every ~60-90 days, the self-signed one at
most every 2 years or after `pvecm updatecerts --force`), the dashboard **fails closed** until you update the pin
([TROUBLESHOOTING.md](TROUBLESHOOTING.md#-tls-fingerprint-mismatch-after-a-certificate-renewal)). If renewals are
frequent, use `proxmox.tls.ca` with a copy of `/etc/pve/pve-root-ca.pem` instead (self-signed setup) or no TLS option
at all (publicly trusted ACME certificate, with a `proxmox.url` host name that matches it). `insecure: true` exists
but turns off all checks; avoid it.

## What is stored where

| Location | Contents | Owner / mode | Sensitivity |
|---|---|---|---|
| Container `/etc/pve1-dash/token` | API token secret | root:pve1dash 0640 | **secret** (read-only access to Proxmox) |
| Container `/etc/pve1-dash/ssh/id_ed25519` | dashboard SSH private key | pve1dash 0600 | **secret** (can run the helpers only) |
| Container `/etc/pve1-dash/ssh/known_hosts` | pinned host keys (pve1 + learned VMs) | pve1dash 0600 | integrity matters |
| Container `/etc/pve1-dash/config.yaml` | settings (no secrets unless you inline `tokenSecret`) | root:pve1dash 0640 | low |
| Container `/var/lib/pve1-dash/push.json` | VAPID key pair, push subscriptions (device endpoints) | pve1dash 0600 | **secret-ish**: lets someone send notifications to your devices |
| Container `/var/lib/pve1-dash/alerts.json`, `health.json` | alert history, service uptime history | pve1dash 0600 | low |
| Host `/usr/local/sbin/pve1-dash-helper` | the helper | root 0755 | integrity matters |
| Host `/etc/pve/priv/authorized_keys` | one pve1-dash line | (pmxcfs) | integrity matters |
| Host `/etc/pve/priv/token.cfg`, `/etc/pve/user.cfg` | the token and its ACLs (managed by Proxmox) | (pmxcfs) | secret |
| Browser `localStorage` | theme, reduce transparency, board sound and similar | | none |

Back up the container like any other guest; `/var/lib/pve1-dash` is all the state there is.

## Supply chain and updates

- The installer and update tool fetch code from the GitHub repository over HTTPS, at the ref you choose (`main` by
  default; pin a tag with `PVE1_DASH_REF` / `pve1-dash-update --ref` if you prefer).
- Node.js comes from the official `nodejs.org` tarball and is checked against `SHASUMS256.txt`. That catches corrupt
  or tampered downloads in transit, but both files come from the same server; the GPG signature of the checksums is
  **not** verified.
- npm dependencies are installed with `npm ci` from the lockfile (integrity hashes checked) and with
  `--ignore-scripts`, so no dependency install scripts run. The build then removes dev dependencies.
- The service runs as the unprivileged user `pve1dash` with systemd sandboxing (read-only file system except its
  state, no capabilities, syscall filter, `NoNewPrivileges`). See the comments in `deploy/pve1-dash.service` for which
  options are on, which are deliberately off in an LXC, and why.
- Keep the container patched like any Debian system: `apt update && apt full-upgrade` inside it now and then (or
  install `unattended-upgrades`), and `pve1-dash-update` for the app and Node.js 24.x.

## Revoking everything

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/uninstall.sh)"
```

removes the key line, the helper and (after asking) the API user and token from the host. By hand: delete the
`pve1-dash@ct...` line from `/root/.ssh/authorized_keys`, `rm /usr/local/sbin/pve1-dash-helper`, and remove the user
in Datacenter → Permissions → Users.
