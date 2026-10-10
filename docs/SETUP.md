# 🛠️ Setting up pve1-dash

There are two ways in:

- **The installer** (recommended): one command on the Proxmox host does everything below. See
  [The one-liner](#-the-one-liner).
- **By hand**: every step the installer takes, as commands you can read and run yourself. Useful if you want to
  know exactly what changes on your host, or if your setup is unusual.

Afterwards: [put it behind your HTTPS proxy](../deploy/reverse-proxy/README.md),
[add VMs that have no guest agent](#-adding-vms-without-the-guest-agent) and
[turn on push notifications on your iPhone](#-web-push-on-iphone-and-ipad).

**Requirements**

- Proxmox VE **8.x or 9.x**, a single node (a cluster works too, the dashboard just looks at one node).
- Internet access for the container while installing (Debian packages, nodejs.org, GitHub, npm).
- About 1 GiB of RAM for the build (the running dashboard needs much less) and 6 GiB of disk.
- An HTTPS reverse proxy on your LAN for the app/push features (Nginx Proxy Manager, nginx, Caddy, Traefik...).

---

## 🚀 The one-liner

On the Proxmox host, as root (the shell from the web UI's node → **Shell** works):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)"
```

It asks a few questions (each has a sensible default), shows a plan, and only then changes anything:

| Question | Default | Notes |
|---|---|---|
| Container ID | next free id | |
| Hostname | `pve1-dash` | |
| Disk storage / size | `local-lvm` (or `local-zfs`, or the first one) / 6 GiB | storages that allow container disks |
| Template storage | `local` | where the Debian 13 template is downloaded |
| Bridge / VLAN | `vmbr0` / none | |
| IPv4 | `dhcp` | or a static `192.168.1.60/24` plus gateway |
| Cores / memory / swap | 1 / 1024 MiB / 512 MiB | the build needs the 1 GiB |
| Proxmox host IP | detected | the dashboard talks to `https://<ip>:8006` and SSH on `<ip>:22` |
| Public HTTPS URL | none | e.g. `https://dash.home.lan`, can be added later |
| Email for Web Push | **required** | your real address; Apple rejects `localhost` and made-up domains |
| Install lm-sensors | no | for CPU/board temperatures |

Unattended, with environment variables (see `install.sh --help` for all of them):

```bash
PVE1_DASH_VAPID_EMAIL=you@example.com PVE1_DASH_PUBLIC_URL=https://dash.home.lan \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)" -- --yes
```

Run it again any time: it finds the container by its `pve1-dash` tag and upgrades/repairs it in place, keeping your
config, push devices and history. A log of the long steps goes to `/var/log/pve1-dash-install.log`.

---

## 🧰 Manual install

Replace `192.168.1.10` (the Proxmox host), `120` (the container id) and `pve1` (the node name) with yours.

### 1. The container

```bash
# On the Proxmox host
pveam update                                   # prints "update successful" (it exits 0 even on failure!)
pveam available --section system | grep debian-13-standard
# PVE 8 prints "system  <template>", PVE >= 9.2.7 adds an arch column; the name is the 2nd column either way.
pveam download local debian-13-standard_13.1-2_amd64.tar.zst    # use the newest name from the list
pveam list local                               # check it is there

pct create 120 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
  --hostname pve1-dash --cores 1 --memory 1024 --swap 512 \
  --rootfs local-lvm:6 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 --start 1 --ostype debian --tags pve1-dash
```

- `--unprivileged 1` matters: **PVE 8 creates privileged containers by default**.
- `nesting=1` lets systemd sandbox the service inside the container.
- No `--password`: root in the container has no password; you get a shell with `pct enter 120`.
- No Debian 13 template on an older PVE 8? Update the host first (`apt update && apt full-upgrade`; Debian 13
  containers need pve-container 5.3.1 or newer), or use `debian-12-standard`, which works the same for pve1-dash.

### 2. A read-only API token

```bash
pveum user add pve1dash@pve --comment "pve1-dash read-only dashboard"
pveum acl modify / --users pve1dash@pve --roles PVEAuditor
pveum user token add pve1dash@pve dashboard --privsep 1 --comment "pve1-dash"
# ^ prints the secret ("value") ONCE: copy it now.
pveum acl modify / --tokens 'pve1dash@pve!dashboard' --roles PVEAuditor
pveum user token permissions pve1dash@pve dashboard --path /    # should list Sys.Audit, VM.Audit, Datastore.Audit, ...
```

Both ACL lines are needed: a privilege-separated token only gets what **both** the user and the token are granted.
The user has no password, so it can't log in to the web UI. Single-quote `'pve1dash@pve!dashboard'` (bash treats `!`
specially). **Don't** add `VM.Monitor` on PVE 8, see [SECURITY.md](SECURITY.md#why-not-vmmonitor-on-pve-8).

Prefer clicking? Datacenter → Permissions → **Users** → Add (realm `pve`), → **API Tokens** → Add (keep "Privilege
Separation" ticked), → **Permissions** → Add a *User Permission* and an *API Token Permission*, both path `/`, role
`PVEAuditor`.

### 3. Facts to note from the host

```bash
# TLS pin: the certificate pveproxy serves (pveproxy-ssl.pem if you uploaded one / use ACME, else pve-ssl.pem)
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256
# -> sha256 Fingerprint=3F:9A:...   (the part after "=")

# The host's SSH key, to pin it in the container
cat /etc/ssh/ssh_host_ed25519_key.pub
```

### 4. Inside the container

Easiest: let the setup script do it. It is the same script the installer runs, and it is safe to repeat.

```bash
# On the host: copy the script in and run it with your values
curl -fsSL -o /tmp/lxc-setup.sh https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/lxc-setup.sh
pct push 120 /tmp/lxc-setup.sh /root/lxc-setup.sh
pct enter 120
# now inside the container:
export P1D_NODE=pve1 P1D_NODE_IP=192.168.1.10 P1D_CTID=120
export P1D_TLS_FINGERPRINT='3F:9A:...'                     # from step 3
export P1D_HOST_KEY='ssh-ed25519 AAAA...'                  # from step 3, WITHOUT the trailing "root@pve1"
export P1D_TOKEN_SECRET='0b4c5d2e-...'                     # from step 2
export P1D_VAPID_EMAIL=you@example.com P1D_PUBLIC_URL=https://dash.home.lan
bash /root/lxc-setup.sh
```

Or completely by hand, these are its steps:

```bash
apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils openssh-client

# Node.js 24 LTS from nodejs.org, checked against the published SHA-256 sums
ARCH=x64                                            # arm64 on ARM hardware
cd /tmp
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
FILE=$(grep -oE "node-v24\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz" SHASUMS256.txt | head -n 1)
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$FILE"
grep " $FILE\$" SHASUMS256.txt | sha256sum -c -      # must say OK
mkdir -p "/opt/${FILE%.tar.xz}"
tar -xJf "$FILE" -C "/opt/${FILE%.tar.xz}" --strip-components=1 --no-same-owner
ln -sfn "/opt/${FILE%.tar.xz}" /opt/node
for b in node npm npx corepack; do ln -sfn /opt/node/bin/$b /usr/local/bin/$b; done

# Service user and the app (built from source, then dev dependencies removed)
useradd --system --user-group --home-dir /var/lib/pve1-dash --no-create-home --shell /usr/sbin/nologin pve1dash
git clone --depth 1 --branch main https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git /opt/pve1-dash
cd /opt/pve1-dash
npm ci --include=dev --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

# Config, token, state
install -d -o root -g pve1dash -m 0750 /etc/pve1-dash
install -d -o pve1dash -g pve1dash -m 0700 /etc/pve1-dash/ssh
install -d -o pve1dash -g pve1dash -m 0750 /var/lib/pve1-dash
install -o root -g pve1dash -m 0640 /dev/null /etc/pve1-dash/token
echo '0b4c5d2e-...' > /etc/pve1-dash/token                 # the token secret
# write /etc/pve1-dash/config.yaml (see below), then:
chown root:pve1dash /etc/pve1-dash/config.yaml && chmod 0640 /etc/pve1-dash/config.yaml

# The dashboard's SSH key and the pinned host key
ssh-keygen -q -t ed25519 -N '' -C pve1-dash@ct120 -f /etc/pve1-dash/ssh/id_ed25519
echo '192.168.1.10 ssh-ed25519 AAAA...' > /etc/pve1-dash/ssh/known_hosts   # host IP + key type + key
chown pve1dash:pve1dash /etc/pve1-dash/ssh/*
chmod 0600 /etc/pve1-dash/ssh/id_ed25519 /etc/pve1-dash/ssh/known_hosts

# systemd unit and the update tool
install -m 0644 /opt/pve1-dash/deploy/pve1-dash.service /etc/systemd/system/
install -m 0755 /opt/pve1-dash/deploy/update.sh /usr/local/bin/pve1-dash-update
printf 'PVE1_DASH_REPO=https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git\nPVE1_DASH_REF=main\n' > /etc/pve1-dash/install.env
systemctl daemon-reload && systemctl enable --now pve1-dash
curl -s http://127.0.0.1:8080/healthz      # {"ok":true}
```

A minimal `/etc/pve1-dash/config.yaml` (every other option, with its default, is in
[deploy/config.example.yaml](../deploy/config.example.yaml)):

```yaml
title: pve1
publicUrl: https://dash.home.lan
proxmox:
  url: https://192.168.1.10:8006
  node: pve1
  tokenId: "pve1dash@pve!dashboard"
  tokenSecretFile: /etc/pve1-dash/token
  tls:
    fingerprint: "3F:9A:..."
inventory:
  enabled: true
  host:
    address: 192.168.1.10
alerts:
  vapidSubject: "mailto:you@example.com"
```

### 5. The SSH helper on the host

The dashboard reaches the host with one SSH key that can run exactly one read-only script
([HELPER_PROTOCOL.md](HELPER_PROTOCOL.md), [SECURITY.md](SECURITY.md#the-ssh-helper)).

```bash
# On the host: install the helper from the container (or from the repo at the same version)
pct pull 120 /opt/pve1-dash/deploy/helpers/pve1-dash-helper /usr/local/sbin/pve1-dash-helper
chown root:root /usr/local/sbin/pve1-dash-helper && chmod 0755 /usr/local/sbin/pve1-dash-helper
SSH_ORIGINAL_COMMAND=version /usr/local/sbin/pve1-dash-helper     # -> pve1-dash-helper 1

# Authorize the dashboard key for that script only
pct exec 120 -- cat /etc/pve1-dash/ssh/id_ed25519.pub              # ssh-ed25519 AAAA... pve1-dash@ct120
echo 'restrict,command="/usr/local/sbin/pve1-dash-helper" ssh-ed25519 AAAA... pve1-dash@ct120' >> /root/.ssh/authorized_keys
```

- `/root/.ssh/authorized_keys` is a **symlink** to `/etc/pve/priv/authorized_keys`, which is shared by every node of a
  cluster. Append to it (as above) or edit it in place; never replace the symlink with a regular file.
- `restrict` blocks shells, PTYs, port/agent/X11 forwarding and `~/.ssh/rc`; `command=` makes sshd ignore whatever
  the client asks for and run the helper.
- Root key logins must be allowed: `sshd -T | grep -i permitrootlogin` should say `yes`, `prohibit-password` or
  `forced-commands-only` (the PVE installer sets `yes`).

Test it from the container, as the service user:

```bash
pct exec 120 -- runuser -u pve1dash -- ssh -i /etc/pve1-dash/ssh/id_ed25519 \
  -o UserKnownHostsFile=/etc/pve1-dash/ssh/known_hosts -o StrictHostKeyChecking=yes root@192.168.1.10 version
# -> pve1-dash-helper 1      (anything else, e.g. "denied" or a shell prompt, means something is wrong)
```

### 6. Optional: temperatures

```bash
apt install lm-sensors
sensors-detect          # answer the questions; the defaults are safe
sensors                 # you should see CPU/board temperatures
```

The helper only ever runs `sensors -j`. Without lm-sensors the temperature card is simply hidden.

---

## 💻 Adding VMs without the guest agent

How pve1-dash looks inside guests:

| Guest | How | Setup needed |
|---|---|---|
| Containers (LXC) | `pct exec` through the host helper | none |
| VMs with the QEMU guest agent | `qm guest exec` through the host helper | agent installed in the VM and enabled in Proxmox |
| VMs **without** the agent | direct SSH to the VM, with the same kind of pinned key | one command in the VM |

To enable the agent instead (often the easier route): install `qemu-guest-agent` in the VM, tick **Options → QEMU
Guest Agent** in Proxmox, then fully stop and start the VM (a reboot from inside is not enough).

For a VM without the agent, open **Settings → Data sources → Add a VM without guest agent** in the dashboard. It
shows a command like this; run it **inside the VM** as root:

```bash
curl -fsSL https://dash.home.lan/setup/guest.sh | sh
```

It installs `/usr/local/sbin/pve1-dash-guest-inventory` (read-only: OS, running services, Docker containers, IPs and
listening ports), authorizes the dashboard key for that script only, checks sshd, and prints a snippet to add to
`/etc/pve1-dash/config.yaml` in the dashboard container:

```yaml
inventory:
  guests:
    - vmid: 108            # the VM's id in Proxmox
      address: 192.168.1.60
      port: 22
      user: root
```

Then `systemctl restart pve1-dash` (inside the container). The VM's SSH host key is pinned on first contact.
Undo in the VM: `rm /usr/local/sbin/pve1-dash-guest-inventory` and delete the `pve1-dash-guest-inventory` line from
`/root/.ssh/authorized_keys`.

---

## 🔔 Web Push on iPhone and iPad

Needs **iOS/iPadOS 16.4 or newer**, the dashboard on **trusted HTTPS** (your reverse proxy), and a real
`alerts.vapidSubject` email in the config.

1. Open your public URL (e.g. `https://dash.home.lan`) in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **pve1** from the Home Screen (push never works in a Safari tab on iOS, only in the Home Screen app).
4. Go to **Settings → Notifications → Enable on this device** and allow notifications when iOS asks.
5. Tap **Send test**. You should get a notification within a few seconds.

Each device has its own settings (which alert kinds, minimum severity, recoveries). On a Mac, Safari, Chrome and
Firefox can enable push right in the browser tab. Not arriving? See
[TROUBLESHOOTING.md → push](TROUBLESHOOTING.md#-push-notifications-dont-arrive-on-iphone).

---

## 🔄 Updating

```bash
pct exec 120 -- pve1-dash-update                 # from the host
pve1-dash-update --ref v1.2.0                    # inside the container: a specific branch, tag or commit
```

It builds the new version next to the running one, swaps them, restarts, and rolls back automatically if the new
version doesn't come up healthy. It also updates Node.js within the 24.x line. If it says the host helper changed, run
on the host:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)" -- --update-helper
```

Re-running the full installer is also a fine way to update: it keeps your config and only updates the TLS pin if the
Proxmox certificate changed.

## 🧹 Uninstalling

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/uninstall.sh)"
```

Removes the authorized_keys line and the helper from the host, asks before removing the API user/token, and asks
(default **no**) before destroying the container. lm-sensors stays installed.

## 📁 Where things live

| Where | What |
|---|---|
| Host: `/usr/local/sbin/pve1-dash-helper` | the read-only forced-command helper |
| Host: `/root/.ssh/authorized_keys` (→ `/etc/pve/priv/authorized_keys`) | one `restrict,command=...` line ending in `pve1-dash@ct<id>` |
| Host: Datacenter → Permissions | user `pve1dash@pve`, token `pve1dash@pve!dashboard`, role PVEAuditor on `/` |
| Container: `/opt/pve1-dash` | the app (`/opt/pve1-dash.prev` = the previous version after an update) |
| Container: `/opt/node` → `/opt/node-v24.x.y-linux-<arch>` | Node.js, linked into `/usr/local/bin` |
| Container: `/etc/pve1-dash/config.yaml` | configuration (root:pve1dash, 0640) |
| Container: `/etc/pve1-dash/token` | API token secret (root:pve1dash, 0640) |
| Container: `/etc/pve1-dash/ssh/` | dashboard key `id_ed25519` (pve1dash, 0600) and `known_hosts` |
| Container: `/etc/pve1-dash/install.env` | the repo and ref used by `pve1-dash-update` |
| Container: `/etc/pve1-dash/env` | optional environment overrides for the service (e.g. `PVE1_DASH_PORT=8081`) |
| Container: `/var/lib/pve1-dash/` | VAPID keys + push devices (`push.json`), alert and uptime history |
| Container: `/etc/systemd/system/pve1-dash.service` | the service; overrides go into `systemctl edit pve1-dash` |
