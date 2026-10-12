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

To rotate the token: run the installer again and answer "yes" to rotating (or `PVE1_DASH_ROTATE_TOKEN=yes`). The
installer replaces it at the very end, once the new version runs, so a run that fails half-way never leaves the
dashboard with a revoked secret; on a re-run it also checks the container's secret against the API and offers a new
token when Proxmox rejects it. To revoke it: Datacenter → Permissions → API Tokens → remove.

Tokens are cluster-wide. A second dashboard in the same cluster (another node, or `PVE1_DASH_EXISTING=new`) gets its
own token, `pve1dash@pve!dashboard-ct<id>`, so installing or removing one dashboard never revokes another one's.

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
  commented. The cross-check is built so that a compromised container can't steer it:
  - the repository is the one you chose on the host; one recorded in the container is only used after you confirm it;
  - the ref is resolved once to a commit of that repository, and the reference copy is downloaded at that commit. A ref
    recorded in the container is used only if the repository has it as a **branch or tag**: pull-request refs
    (`pull/<n>/head`) and commit ids are never taken from the container, because GitHub serves the code of forks and
    pull requests under the original repository's URLs too;
  - if the copies differ, the installer shows both SHA-256 sums and the diff with every byte outside printable ASCII
    shown as `\xNN` (so escape sequences can't redraw your terminal or hide lines), keeps the whole diff in
    `/var/log/pve1-dash-helper.diff`, and installs nothing unless you say so (never with `--yes` alone).
- If the container is compromised, the attacker gets what the helper prints: your guests' service lists, Docker
  containers, IPs and open ports, pending updates, backup lists and temperatures. Nothing more.
- `/root/.ssh/authorized_keys` on Proxmox is a symlink to `/etc/pve/priv/authorized_keys`, **shared by every node of a
  cluster**. The key line therefore exists on all nodes; on nodes without the helper installed, sshd tries to run a
  missing file and the login simply fails (there is no fallback to a shell). Each dashboard has its own line
  (`pve1-dash@ct<id>`); the installer and uninstaller only touch the line of the container they work on (and copies of
  its key). They write the file carefully: a backup goes to `/root/.ssh/authorized_keys.pve1-dash.bak`, the new
  content is built next to the file (not in `/tmp`) and its line count checked, the complete copy replaces the file by
  a rename, and any failure stops the script and names the backup.
- Optional extra fence when the container has a static IP: prefix the line with `from="192.168.1.60",` so the key only
  works from that address. The installer doesn't add it because DHCP addresses change, but it **keeps** options you add
  to the line (as long as it still has `restrict` and the helper's `command=`), on re-runs and with `--update-helper`.
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
3. **Let the dashboard itself refuse other networks:** `listen.allowedSources` (the installer offers the host's network,
   e.g. `["10.10.10.0/24"]`) is checked on the TCP connection's real source address, never on `X-Forwarded-For`, and
   everyone else gets 403 (loopback and `/healthz` excepted). This matters because the container's plain-HTTP port
   8080 is reachable from every network routed to it, past any access list on the proxy. Behind a proxy, the proxy's
   own address must be in the list (it is what connects).
4. **Separate untrusted networks at the router.** An IoT VLAN that can reach your LAN can reach the proxy too. Block
   IoT → LAN at the router/firewall; that is the real fix, and the allow-lists here are the second line.
5. If your LAN has other people or guests you don't trust, **add a gate at the proxy** as well: an IP access list
   (friendliest with the iPhone Home Screen app) or SSO forward-auth (Authelia, Authentik). Plain HTTP Basic auth
   also works in browsers; its behaviour in the iOS Home Screen app is UNVERIFIED.

**Nginx Proxy Manager access lists have two gaps** (from NPM's templates and nginx.conf, not tested inside NPM):

- NPM applies a host's Access List only inside the `location` blocks it generates itself (the default one and the
  **Custom Locations** tab). A `location` you type into the **Advanced** tab is not covered and skips the list. Put
  per-path settings into Custom Locations instead; pve1-dash needs none.
- NPM's `nginx.conf` trusts the `X-Real-IP` header from every private address (`set_real_ip_from 10.0.0.0/8;
  172.16.0.0/12; 192.168.0.0/16`), so a client on any private network (an IoT VLAN, say) can claim to be
  `10.10.10.5` for the access list. Optional hardening: in that proxy host's Advanced tab add only
  `set_real_ip_from 127.0.0.1;` (a server-level `set_real_ip_from` replaces the inherited list, so `X-Real-IP` from LAN
  clients is ignored). The dashboard's own `listen.allowedSources` doesn't have this problem: it never reads headers.

**DNS rebinding.** Without a login, a web page on the internet could otherwise read the API through your browser by
re-pointing its own host name at the dashboard's LAN address. The server therefore answers only requests whose `Host`
is an IP address, `localhost`, a single-label name or a name under `.lan`, `.local`, `.home.arpa`, `.internal` (and a
few similar private suffixes), the host of `publicUrl`, `listen.host`, the container's hostname, or a name listed in
`allowedHosts` (exact, or `*.example.com` for subdomains). Everything else gets **421 Unknown host** (`/healthz`
excepted). If you reach the dashboard under another public name, add it to `allowedHosts` or set `publicUrl`.

`X-Forwarded-*` headers are trusted from any client (the proxy's address is not known in advance). They are never used
for access decisions (`listen.allowedSources` uses the connection's address). Their only uses are
log lines, the request origin recorded for push links (the browser's `Origin` header is preferred, and only accepted
when its host passes the check above) and the URL inside `/setup/guest.sh` when `publicUrl` is unset (a forwarded host
is used only when it passes the same check). A client that spoofs them only changes what it gets back itself.

**Outbound requests the server makes on someone's behalf** are limited:

- *Web Push.* A subscription endpoint must be an `https://` URL of a public host name (no IP literals, LAN names,
  trailing dots or credentials). The name is resolved when connecting and only **public** addresses are used: private,
  loopback, link-local, CGNAT, documentation, multicast and IPv4-mapped/NAT64 forms of them are refused, so a
  registered "device" cannot make the server POST into your LAN (a device whose endpoint resolves there is removed).
  TLS certificates are verified as usual.
- *Docker auto-discovery.* The `docker ps` output comes from inside a guest, so root in that guest controls it. The
  bind address of a published port is used only when it is an IP literal **of that guest**; anything else (other
  hosts, names, URL paths) falls back to the guest's own address. A compromised guest can therefore still choose a
  port (and, since a guest reports its own IPs through the agent or its interfaces, which of "its" addresses) for the
  recurring `GET /` health check, but cannot aim it at arbitrary host names or paths. Turn
  `services.autoDiscoverDocker` off if you don't trust a guest's root user.

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

The token is never sent before the Proxmox certificate checks out. There are three modes, and the installer picks one:

- **Proxmox's cluster CA** (`proxmox.tls.ca`, the default for a new install with Proxmox's own self-signed
  certificate): the dashboard verifies the certificate against a copy of `/etc/pve/pve-root-ca.pem`, including that the
  address in `proxmox.url` is one of its names, like a browser does with a public CA. The installer only chooses this
  after `openssl s_client -CAfile ... -verify_ip <host address>` succeeded on the host. Proxmox renews the node
  certificate by itself (`pveupdate`, in the two weeks before it expires) with the same CA and names, so nothing
  breaks. Anyone who can sign with that CA could impersonate the host; its key lives in `/etc/pve/priv/` on the host.
- **A pin** (`proxmox.tls.fingerprint`, when the CA check fails, or for existing installs): the dashboard compares the
  certificate's SHA-256 fingerprint with the pin before it sends any request. The flip side: when the certificate is
  renewed (an ACME/Let's Encrypt cert every ~60-90 days, the self-signed one at most every 2 years or after
  `pvecm updatecerts --force`), the dashboard **fails closed** until you update the pin
  ([TROUBLESHOOTING.md](TROUBLESHOOTING.md#-tls-fingerprint-mismatch-after-a-certificate-renewal), which also shows how
  to switch to the CA).
- **The public CAs** (no TLS option, a `proxmox.url` host name that matches a publicly trusted ACME certificate).

TLS session resumption is off, so every connection is checked. `insecure: true` exists but turns off all checks;
avoid it.

When the host serves a custom or ACME certificate (`pveproxy-ssl.pem`), the installer warns that a pin breaks at every
renewal and, for a new install, offers the public-CA mode: it asks for the host name on the certificate (proposing the
node's ACME domain) and uses it only after checking that the certificate verifies for that name against the public CAs
and that the name resolves to the host inside the container. Otherwise it pins as before.

## What is stored where

| Location | Contents | Owner / mode | Sensitivity |
|---|---|---|---|
| Container `/etc/pve1-dash/token` | API token secret | root:pve1dash 0640 | **secret** (read-only access to Proxmox) |
| Container `/etc/pve1-dash/ssh/id_ed25519` | dashboard SSH private key | pve1dash 0600 | **secret** (can run the helpers only) |
| Container `/etc/pve1-dash/ssh/known_hosts` | pinned host keys (pve1 + learned VMs) | pve1dash 0600 | integrity matters |
| Container `/etc/pve1-dash/config.yaml` | settings (no secrets unless you inline `tokenSecret`) | root:pve1dash 0640 | low |
| Container `/etc/pve1-dash/pve-root-ca.pem` | copy of Proxmox's cluster CA certificate (public) | root 0644 | integrity matters |
| Container `/var/lib/pve1-dash/config.good.yaml` | the last config the dashboard started with | pve1dash 0600 | low |
| Container `/var/lib/pve1-dash/push.json` | VAPID key pair, push subscriptions (device endpoints) | pve1dash 0600 | **secret-ish**: lets someone send notifications to your devices. Never overwritten when unreadable; a corrupt copy is kept as `push.json.corrupt-<time>` |
| Container `/var/lib/pve1-dash/alerts.json`, `health.json` | alert history, service uptime history | pve1dash 0600 | low |
| Host `/usr/local/sbin/pve1-dash-helper` | the helper | root 0755 | integrity matters |
| Host `/etc/pve/priv/authorized_keys` | one pve1-dash line | (pmxcfs) | integrity matters |
| Host `/etc/pve/priv/token.cfg`, `/etc/pve/user.cfg` | the token and its ACLs (managed by Proxmox) | (pmxcfs) | secret |
| Browser `localStorage` | theme, reduce transparency, board sound and similar | | none |

Back up the container like any other guest; `/var/lib/pve1-dash` is all the state there is.

## Supply chain and updates

- The installer and update tool fetch code from the GitHub repository over HTTPS, at the ref you choose (`main` by
  default; pin a tag with `PVE1_DASH_REF` / `pve1-dash-update --ref` if you prefer, so nothing merged later changes
  what gets built). The installer resolves the ref to
  one commit up front: the container checks out exactly that commit, and the files the host downloads (the setup
  script, the reference copy of the helper) come from that commit's immutable URL. It stops right away if the ref does
  not contain pve1-dash.
- A Node.js update is unpacked and test-run next to the working version; only then is `/opt/node` switched, and older
  versions are deleted only after the switch is verified. A failed download or unpack (say, a full disk) leaves the
  working Node.js untouched.
- Node.js comes from the official `nodejs.org` tarball and is checked against `SHASUMS256.txt`. That catches corrupt
  or tampered downloads in transit, but both files come from the same server; the GPG signature of the checksums is
  **not** verified.
- npm dependencies are installed with `npm ci` from the lockfile (integrity hashes checked) and with
  `--ignore-scripts`, so no dependency install scripts run. The build then removes dev dependencies.
- The service runs as the unprivileged user `pve1dash` with systemd sandboxing (read-only file system except its
  state, no capabilities, syscall filter, `NoNewPrivileges`). See the comments in `deploy/pve1-dash.service` for which
  options are on, which are deliberately off in an LXC, and why.
- `pve1-dash-doctor` (run at the end of every install and update) is read-only: it only reads from the
  Proxmox API, runs the helper's read-only commands, and never prints the token secret. The installer shows its
  output with control characters escaped, like everything else that comes from the container.
- Keep the container patched like any Debian system: `apt update && apt full-upgrade` inside it now and then (or
  install `unattended-upgrades`), and `pve1-dash-update` for the app and Node.js 24.x.

## Revoking everything

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/uninstall.sh)"
```

removes one dashboard's key line, the helper (unless another dashboard on the node uses it) and, after asking, its API token (the
user too when no other dashboard is left). A container you keep is stopped and taken off autostart, so it can't send
false alerts. By hand: delete the `pve1-dash@ct<id>` line from `/root/.ssh/authorized_keys`,
`rm /usr/local/sbin/pve1-dash-helper`, and remove the token (or the user) in Datacenter → Permissions.
