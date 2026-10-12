#!/usr/bin/env bash
# pve1-dash: set up the dashboard INSIDE its Debian container. Run as root in the container; deploy/install.sh does
# this for you (pct push + pct exec). Idempotent: run it again to repair or upgrade.
#
# Usage: bash lxc-setup.sh [SETTINGS_FILE]
#
# Settings come from the environment, or from SETTINGS_FILE (KEY=value lines in bash syntax, as written by
# install.sh; the file is deleted after reading because it may hold the API token secret):
#   PVE1_DASH_REPO, PVE1_DASH_REF  git source (default: the GitHub repo, "main")
#   P1D_NODE_IP                    IP of the Proxmox host: API at https://<ip>:8006, SSH helper at <ip>:22  (required)
#   P1D_HOST_KEY                   "ssh-ed25519 AAAA..." from the host's /etc/ssh/ssh_host_ed25519_key.pub  (required)
#   P1D_NODE                       Proxmox node name, e.g. pve1                         (required for a new config)
#   P1D_TLS_FINGERPRINT            SHA-256 of the Proxmox certificate, "AB:CD:..."      (required for a new config,
#                                  unless P1D_PVE_HOST or P1D_TLS_CA is set)
#   P1D_TLS_CA                     PEM of the Proxmox cluster CA (/etc/pve/pve-root-ca.pem), when the host checked
#                                  that its certificate verifies with it for P1D_NODE_IP: stored as
#                                  /etc/pve1-dash/pve-root-ca.pem, and a new config verifies with it instead of a pin
#                                  (survives Proxmox's automatic certificate renewals)
#   P1D_VAPID_EMAIL                your email address, the Web Push contact             (required for a new config)
#   P1D_PUBLIC_URL                 public HTTPS URL of the dashboard (optional; also set in an existing config)
#   P1D_ALLOWED_SOURCES            CIDRs/addresses allowed to connect, space separated, "any" for everyone
#                                  (optional; listen.allowedSources, also set in an existing config)
#   P1D_TOKEN_ID                   API token id (default pve1dash@pve!dashboard)
#   P1D_TOKEN_SECRET               token secret; needed on the first install and after a rotation
#   P1D_CTID                       this container's id (SSH key comment, and recorded in install.env)
#   P1D_COMMIT                     full commit id of PVE1_DASH_REF to check out (install.sh resolves the ref once, so
#                                  the container builds exactly what the host compares the helper with)
#   P1D_PVE_HOST                   host name on a publicly trusted (ACME) Proxmox certificate: a new config then uses
#                                  https://<name>:8006, checked against the public CAs instead of a fingerprint pin
#   P1D_NODE_IPS                   all IPv4 addresses of the Proxmox host, space separated: an existing config that
#                                  points at an address the host no longer has is moved to P1D_NODE_IP
#
# Result: Node.js 24 in /opt/node, the app in /opt/pve1-dash (built from source), the system user pve1dash,
# /etc/pve1-dash/{config.yaml,token,ssh/}, state in /var/lib/pve1-dash, the systemd service pve1-dash and the tools
# pve1-dash-update, pve1-dash-doctor and pve1-dash-config in /usr/local/bin. An existing config.yaml is kept; only its
# TLS fingerprint is updated when the Proxmox certificate changed, the host address when the host no longer has the
# old one, and publicUrl / listen.allowedSources when they are given.
#
# A new token secret is stored before anything slow happens, so a failing later step never loses it. When an upgrade
# does not come up healthy, the previous version is restored, as pve1-dash-update does.
#
# The Node.js and code build/activation steps come from deploy/update.sh of the same ref (sourced after the
# checkout).

set -Eeuo pipefail

# Not readonly: deploy/update.sh declares the shared ones readonly when it is sourced.
APP_DIR=/opt/pve1-dash
CONF_DIR=/etc/pve1-dash
SSH_DIR=/etc/pve1-dash/ssh
TOKEN_FILE=/etc/pve1-dash/token
CONFIG_FILE=/etc/pve1-dash/config.yaml
CA_FILE=/etc/pve1-dash/pve-root-ca.pem
DATA_DIR=/var/lib/pve1-dash
SVC_USER=pve1dash
DEFAULT_TOKEN_ID='pve1dash@pve!dashboard'
SETUP_REPO_DEFAULT='https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git'
PIN_ADDR=''

say() { printf 'pve1-dash: %s\n' "$*"; }
ok() { printf 'pve1-dash: ✔ %s\n' "$*"; }
warn() { printf 'pve1-dash: ! %s\n' "$*" >&2; }
die() {
  printf 'pve1-dash: error: %s\n' "$*" >&2
  exit 1
}

lxc_on_error() {
  local code=$?
  if ((BASH_SUBSHELL > 0)); then exit "$code"; fi
  trap - ERR
  warn "setup stopped at line ${1:-?} (exit $code). Fix the cause and run it again; it is safe to repeat."
  exit "$code"
}

# ───────────────────────────────────────────────────────────────────────── settings

load_settings() {
  local file=${1-}
  [[ -n $file ]] || return 0
  [[ -f $file ]] || die "settings file $file not found"
  # shellcheck source=/dev/null # written by install.sh with printf %q
  source "$file"
  rm -f "$file"
}

is_ipv4() {
  local o
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do ((10#$o <= 255)) || return 1; done
}
is_host_key() { [[ $1 =~ ^ssh-ed25519\ AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$ ]]; }
is_node() { [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; }
is_fingerprint() { [[ $1 =~ ^([0-9A-F]{2}:){31}[0-9A-F]{2}$ ]]; }
is_email() { [[ $1 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; }
is_https_url() { [[ $1 =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]; }
is_token_id() { [[ $1 =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]+$ ]]; }
is_token_secret() { [[ $1 =~ ^[A-Za-z0-9-]{8,128}$ ]]; }
is_commit() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }
# One or more PEM certificates, nothing else.
is_pem_certs() {
  [[ $1 == '-----BEGIN CERTIFICATE-----'* && $1 == *'-----END CERTIFICATE-----'* && $1 =~ ^[A-Za-z0-9+/=[:space:]-]+$ ]]
}
# An IPv4 address or CIDR (a.b.c.d/0-32).
is_ipv4_cidr() {
  is_ipv4 "${1%/*}" || return 1
  [[ $1 != */* ]] && return 0
  [[ ${1#*/} =~ ^[0-9]{1,2}$ ]] && ((10#${1#*/} <= 32))
}
# A fully qualified host name (at least one dot), not an IP address.
is_dns_name() {
  [[ ${#1} -le 253 && $1 =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] && ! is_ipv4 "$1"
}
is_ipv4_list() {
  local w
  for w in $1; do is_ipv4 "$w" || return 1; done
}

# Defense in depth: everything below ends up in config files, so check the shapes even though install.sh did.
validate_settings() {
  local need_config=$1
  PVE1_DASH_REPO=${PVE1_DASH_REPO:-$SETUP_REPO_DEFAULT}
  PVE1_DASH_REF=${PVE1_DASH_REF:-main}
  P1D_TOKEN_ID=${P1D_TOKEN_ID:-$DEFAULT_TOKEN_ID}
  P1D_PUBLIC_URL=${P1D_PUBLIC_URL-}
  P1D_PUBLIC_URL=${P1D_PUBLIC_URL%/}
  P1D_ALLOWED_SOURCES=${P1D_ALLOWED_SOURCES-}
  P1D_ALLOWED_SOURCES=${P1D_ALLOWED_SOURCES//,/ }
  P1D_TLS_CA=${P1D_TLS_CA-}
  P1D_TLS_FINGERPRINT=${P1D_TLS_FINGERPRINT-}
  P1D_TLS_FINGERPRINT=${P1D_TLS_FINGERPRINT^^}
  P1D_COMMIT=${P1D_COMMIT-}
  P1D_PVE_HOST=${P1D_PVE_HOST-}
  P1D_TIMEZONE=${P1D_TIMEZONE-}
  P1D_NODE_IPS=${P1D_NODE_IPS-}
  [[ $PVE1_DASH_REPO =~ ^(https://|git@|file:///)[A-Za-z0-9@:/._~+-]{3,300}$ ]] || die "PVE1_DASH_REPO=\"$PVE1_DASH_REPO\" is not a git URL"
  [[ $PVE1_DASH_REF =~ ^[A-Za-z0-9._/-]{1,200}$ && $PVE1_DASH_REF != *..* && $PVE1_DASH_REF != -* ]] || die "PVE1_DASH_REF=\"$PVE1_DASH_REF\" is invalid"
  is_ipv4 "${P1D_NODE_IP-}" || die 'P1D_NODE_IP must be the IPv4 address of the Proxmox host'
  is_host_key "${P1D_HOST_KEY-}" || die 'P1D_HOST_KEY must be "ssh-ed25519 AAAA..." (the host'"'"'s /etc/ssh/ssh_host_ed25519_key.pub without comment)'
  is_token_id "$P1D_TOKEN_ID" || die "P1D_TOKEN_ID=\"$P1D_TOKEN_ID\" is not user@realm!name"
  if [[ -n ${P1D_TOKEN_SECRET-} ]]; then is_token_secret "$P1D_TOKEN_SECRET" || die 'P1D_TOKEN_SECRET has an unexpected format'; fi
  [[ -z ${P1D_CTID-} || $P1D_CTID =~ ^[0-9]{1,9}$ ]] || die 'P1D_CTID must be a number'
  if [[ -n $P1D_TLS_FINGERPRINT ]]; then is_fingerprint "$P1D_TLS_FINGERPRINT" || die 'P1D_TLS_FINGERPRINT must look like AB:CD:... (32 bytes)'; fi
  [[ -z $P1D_COMMIT ]] || is_commit "$P1D_COMMIT" || die 'P1D_COMMIT must be a full 40-character commit id'
  [[ -z $P1D_PVE_HOST ]] || is_dns_name "$P1D_PVE_HOST" || die 'P1D_PVE_HOST must be a host name such as pve1.example.com'
  if [[ -n $P1D_TIMEZONE && ! ( $P1D_TIMEZONE =~ ^[A-Za-z][A-Za-z0-9_+./-]{0,63}$ && $P1D_TIMEZONE != *..* ) ]]; then
    warn "ignoring an invalid time zone name ($P1D_TIMEZONE); alert times will use the container's zone"
    P1D_TIMEZONE=''
  fi
  is_ipv4_list "$P1D_NODE_IPS" || die 'P1D_NODE_IPS must be IPv4 addresses separated by spaces'
  [[ -z $P1D_PUBLIC_URL ]] || is_https_url "$P1D_PUBLIC_URL" || die 'P1D_PUBLIC_URL must be an https:// URL'
  [[ -z $P1D_TLS_CA ]] || is_pem_certs "$P1D_TLS_CA" || die 'P1D_TLS_CA must be PEM certificates'
  if [[ -n $P1D_ALLOWED_SOURCES && $P1D_ALLOWED_SOURCES != any ]]; then
    local w
    for w in $P1D_ALLOWED_SOURCES; do
      is_ipv4_cidr "$w" || die "P1D_ALLOWED_SOURCES: \"$w\" is not an IPv4 address or CIDR such as 10.10.10.0/24"
    done
  fi
  if [[ $need_config == yes ]]; then
    is_node "${P1D_NODE-}" || die 'P1D_NODE must be the Proxmox node name (e.g. pve1)'
    [[ -n $P1D_TLS_FINGERPRINT || -n $P1D_PVE_HOST || -n $P1D_TLS_CA ]] ||
      die 'P1D_TLS_FINGERPRINT (or P1D_TLS_CA or P1D_PVE_HOST) is required for a new config'
    is_email "${P1D_VAPID_EMAIL-}" || die 'P1D_VAPID_EMAIL must be your email address (Web Push contact)'
  fi
}

# ───────────────────────────────────────────────────────────────────────── system

apt_packages() {
  export DEBIAN_FRONTEND=noninteractive
  say 'installing packages: ca-certificates curl git xz-utils openssh-client ...'
  apt-get update -qq || die 'apt-get update failed (network or DNS inside the container?)'
  apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils openssh-client >/dev/null ||
    die 'apt-get install failed'
  ok 'packages installed'
}

ensure_user() {
  if id -u "$SVC_USER" >/dev/null 2>&1; then return 0; fi
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin \
    --comment 'pve1-dash dashboard' "$SVC_USER"
  ok "created system user $SVC_USER"
}

setup_dirs() {
  install -d -o root -g "$SVC_USER" -m 0750 "$CONF_DIR"
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$SSH_DIR"
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR"
}

is_pve1_dash_source() { [[ -f $1/package.json ]] && grep -qE '^[[:space:]]*"name":[[:space:]]*"pve1-dash"' "$1/package.json"; }

# Shallow checkout of REPO at REF (or exactly COMMIT, when given) into DIR (the same steps as fetch_source in
# update.sh, needed before it exists). Fails fast when the result is not pve1-dash.
checkout() {
  local repo=$1 ref=$2 dir=$3 commit=${4-} head
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "$repo"
  git -C "$dir" fetch -q --depth 1 origin "${commit:-$ref}" || die "git fetch of \"$ref\"${commit:+ (commit $commit)} from $repo failed"
  git -C "$dir" -c advice.detachedHead=false checkout -q --force FETCH_HEAD
  if [[ -n $commit ]]; then
    head=$(git -C "$dir" rev-parse HEAD)
    [[ $head == "$commit" ]] || die "checked out $head instead of $commit"
  fi
  is_pve1_dash_source "$dir" ||
    die "$repo @ $ref is not pve1-dash (its package.json is not named pve1-dash). Check PVE1_DASH_REPO / PVE1_DASH_REF, or install from main."
}

# ───────────────────────────────────────────────────────────────────────── config

# A YAML double-quoted scalar.
yq() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# The proxmox.tls lines of a new config: (P1D_PVE_HOST) a check against the public CAs, (P1D_TLS_CA) a check against
# Proxmox's own cluster CA, else a fingerprint pin.
render_tls() {
  if [[ -n ${P1D_PVE_HOST-} ]]; then
    printf '%s\n' \
      '    # No pin: the certificate is checked against the public CAs and the host name in url, like a browser does.' \
      '    # (It is an ACME certificate, renewed every 60-90 days; a pin would break at each renewal.)' \
      '    insecure: false'
  elif [[ -n ${P1D_TLS_CA-} ]]; then
    printf '%s\n' \
      "    # Proxmox's own cluster CA (a copy of /etc/pve/pve-root-ca.pem). It signs the node certificate and each of" \
      '    # its automatic renewals, so nothing needs updating when Proxmox renews it. The address in url must be on the' \
      '    # certificate (the installer checked that). To pin one certificate instead: docs/TROUBLESHOOTING.md.' \
      "    ca: $CA_FILE"
  else
    printf '%s\n' \
      '    # SHA-256 of the certificate pveproxy serves. Update it after the certificate changes' \
      '    # (docs/TROUBLESHOOTING.md "TLS fingerprint mismatch"); re-running install.sh does that for you.' \
      "    fingerprint: $(yq "$P1D_TLS_FINGERPRINT")"
  fi
}

# The initial /etc/pve1-dash/config.yaml (on stdout). Parsed by server/config.ts (ConfigSchema); every option and its
# default is documented in deploy/config.example.yaml.
render_config() {
  local public tz
  if [[ -n ${P1D_TIMEZONE-} ]]; then
    tz="timezone: $(yq "$P1D_TIMEZONE")   # clock times in alerts and notifications (the host's zone)"
  else
    tz='# timezone: "Europe/Berlin"   # IANA zone for clock times in alerts (default: the container zone, usually UTC)'
  fi
  if [[ -n ${P1D_PUBLIC_URL-} ]]; then
    public="publicUrl: $(yq "$P1D_PUBLIC_URL")"
  else
    public='# publicUrl: "https://dash.example.com"   # your HTTPS URL behind the reverse proxy (needed for push links)'
  fi
  cat <<EOF
# pve1-dash configuration, written by the installer on $(date -u +%Y-%m-%d).
# All options with their defaults and examples: /opt/pve1-dash/deploy/config.example.yaml
# Edit it with: pve1-dash-config   (checks your changes before saving them, then restarts the dashboard)
# Something wrong? pve1-dash-doctor   (read-only check of config, Proxmox API, SSH helper and push, with fixes)

title: $(yq "$P1D_NODE")
$public
$tz
dataDir: /var/lib/pve1-dash
$(render_listen)

proxmox:
  url: $(yq "https://${P1D_PVE_HOST:-$P1D_NODE_IP}:8006")
  node: $(yq "$P1D_NODE")
  tokenId: $(yq "$P1D_TOKEN_ID")
  tokenSecretFile: /etc/pve1-dash/token
  tls:
$(render_tls)

inventory:
  enabled: true
  # The Proxmox host; the dashboard key may only run /usr/local/sbin/pve1-dash-helper there.
  host:
    address: $(yq "$P1D_NODE_IP")
    port: 22
    user: root
  # VMs without the QEMU guest agent, reached directly over SSH (Settings → Data sources shows the setup command):
  guests: []
  #  - vmid: 108
  #    address: 192.168.1.60

services:
  # Launcher tiles and health checks (Docker containers with published ports are added automatically).
  # Examples in /opt/pve1-dash/deploy/config.example.yaml.
  items: []

alerts:
  # Web Push contact. Apple rejects localhost or made-up addresses (403 BadJwtToken).
  vapidSubject: $(yq "mailto:$P1D_VAPID_EMAIL")
EOF
}

# The listen section of a new config: only when P1D_ALLOWED_SOURCES restricts who may connect.
render_listen() {
  local list='' w
  [[ -n ${P1D_ALLOWED_SOURCES-} && $P1D_ALLOWED_SOURCES != any ]] || return 0
  for w in $P1D_ALLOWED_SOURCES; do list+="${list:+, }$(yq "$w")"; done
  printf '%s\n' '' 'listen:' '  port: 8080' \
    '  # Only these addresses may connect (checked on the connection itself, never on X-Forwarded-For). Your reverse' \
    "  # proxy's address must be in here: it is what connects for your phone. Loopback and /healthz always work." \
    '  # Set [] to allow everyone.' \
    "  allowedSources: [$list]"
}

# Set proxmox.tls.fingerprint in FILE to FP, keeping everything else. Returns 0 when changed, 1 when it already had
# FP, 2 when there are several "fingerprint:" lines, 3 when there is none (the config uses tls.ca or the public CAs).
set_fingerprint() {
  local file=$1 fp=$2 n current
  n=$(grep -cE '^[[:space:]]+fingerprint:' "$file") || n=0
  [[ $n != 0 ]] || return 3
  [[ $n == 1 ]] || return 2
  current=$(sed -nE 's/^[[:space:]]+fingerprint:[[:space:]]*["'"'"']?([0-9A-Fa-f:]*).*/\1/p' "$file")
  if [[ ${current^^} == "$fp" ]]; then return 1; fi
  sed -i -E "s/^([[:space:]]+fingerprint:).*/\\1 \"$fp\"/" "$file"
}

# Keep an existing config pointed at the Proxmox host. proxmox.url and inventory.host.address are moved to IP only
# when they hold an IPv4 address the host no longer has (not IP and not in HOST_IPS); host names, and other addresses
# of the host, are left alone. Uses the yaml package of the release in APPDIR, which keeps comments and layout.
# Prints "pin <address>" (where the host key must be pinned: inventory.host.address when it is one of the host's
# addresses, else IP) and one "changed <what>" line per edit; FILE is rewritten only when something changed.
sync_node_ip() {
  local file=$1 ip=$2 host_ips=$3 appdir=$4 out
  rm -f "$file.new"
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  out=$(cd "$appdir" && node -e '
    const fs = require("fs"), YAML = require("yaml");
    const [file, ip, hostIps] = process.argv.slice(1);
    const mine = new Set(String(hostIps || "").split(/\s+/).filter(Boolean));
    mine.add(ip);
    const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
    if (doc.errors.length) { console.error(doc.errors[0].message); process.exit(2); }
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/;
    const out = [];
    let pin = ip;
    const url = doc.getIn(["proxmox", "url"], true);
    if (url && typeof url.value === "string") {
      const m = /^(https?:\/\/)(\d{1,3}(?:\.\d{1,3}){3})(?=[:/]|$)/.exec(url.value);
      if (m && !mine.has(m[2])) {
        out.push(`proxmox.url ${m[2]} -> ${ip}`);
        url.value = m[1] + ip + url.value.slice(m[0].length);
      }
    }
    const addr = doc.getIn(["inventory", "host", "address"], true);
    if (addr && typeof addr.value === "string" && v4.test(addr.value)) {
      if (mine.has(addr.value)) pin = addr.value;
      else {
        out.push(`inventory.host.address ${addr.value} -> ${ip}`);
        addr.value = ip;
      }
    }
    if (out.length) fs.writeFileSync(file + ".new", String(doc));
    process.stdout.write(`pin ${pin}\n` + out.map((c) => `changed ${c}\n`).join(""));' "$file" "$ip" "$host_ips") || {
    rm -f "$file.new"
    return 1
  }
  if [[ -f $file.new ]]; then mv -f "$file.new" "$file" || return 1; fi
  printf '%s\n' "$out"
}

# Set publicUrl and/or listen.allowedSources in an existing FILE, keeping comments and layout (yaml package of the
# release in APPDIR). URL empty: publicUrl is left alone; SOURCES empty: allowedSources is left alone, "any" sets [].
# A commented-out "# publicUrl: ..." line (as the installer writes it) is replaced in place. Prints one "changed <what>"
# line per edit; FILE is rewritten only when something changed.
set_config_values() {
  local file=$1 url=$2 sources=$3 appdir=$4 out
  rm -f "$file.new"
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  out=$(cd "$appdir" && node -e '
    const fs = require("fs"), YAML = require("yaml");
    const [file, url, sources] = process.argv.slice(1);
    const orig = fs.readFileSync(file, "utf8");
    let doc = YAML.parseDocument(orig);
    if (doc.errors.length) { console.error(doc.errors[0].message); process.exit(2); }
    const out = [];
    const commented = /^#[ \t]*publicUrl:.*$/m;
    if (url && !doc.has("publicUrl") && commented.test(orig)) {
      const d = YAML.parseDocument(orig.replace(commented, `publicUrl: ${JSON.stringify(url)}`));
      if (!d.errors.length && d.get("publicUrl") === url) { doc = d; out.push(`publicUrl ${url}`); }
    }
    if (url && doc.get("publicUrl") !== url) {
      const node = doc.get("publicUrl", true);
      out.push(`publicUrl ${YAML.isScalar(node) ? `${node.value} -> ` : ""}${url}`);
      if (YAML.isScalar(node)) node.value = url; else doc.set("publicUrl", url);
    }
    if (sources) {
      const list = sources === "any" ? [] : sources.split(/\s+/).filter(Boolean);
      const cur = doc.getIn(["listen", "allowedSources"]);
      const now = YAML.isSeq(cur) ? cur.toJSON() : cur === undefined ? [] : cur;
      if (JSON.stringify(now) !== JSON.stringify(list)) {
        const seq = doc.createNode(list);
        seq.flow = true;
        doc.setIn(["listen", "allowedSources"], seq);
        out.push(`listen.allowedSources [${list.join(", ")}]`);
      }
    }
    if (out.length) fs.writeFileSync(file + ".new", String(doc));
    process.stdout.write(out.map((c) => `changed ${c}\n`).join(""));' "$file" "$url" "$sources") || {
    rm -f "$file.new"
    return 1
  }
  if [[ -f $file.new ]]; then mv -f "$file.new" "$file" || return 1; fi
  printf '%s' "$out"
}

# Proxmox's cluster CA, for a config that verifies with tls.ca (see render_tls). Public data: readable by everyone.
write_ca() {
  [[ -n ${P1D_TLS_CA-} ]] || return 0
  local tmp
  tmp=$(mktemp "$CONF_DIR/.ca.XXXXXX")
  printf '%s\n' "$P1D_TLS_CA" >"$tmp"
  chmod 0644 "$tmp"
  if cmp -s "$tmp" "$CA_FILE"; then
    rm -f "$tmp"
  else
    mv -f "$tmp" "$CA_FILE"
    ok "stored the Proxmox cluster CA in $CA_FILE"
  fi
}

write_config() {
  PIN_ADDR=$P1D_NODE_IP
  write_ca
  if [[ -f $CONFIG_FILE ]]; then
    ok "keeping $CONFIG_FILE"
    if [[ -n $P1D_TLS_FINGERPRINT ]]; then
      local rc=0
      set_fingerprint "$CONFIG_FILE" "$P1D_TLS_FINGERPRINT" || rc=$?
      case $rc in
        0) ok 'updated proxmox.tls.fingerprint (the Proxmox certificate changed)' ;;
        1) : ;;
        3) ok 'the config pins no certificate (tls.ca or the public CAs): TLS settings left alone' ;;
        *) warn "could not update proxmox.tls.fingerprint automatically; set it to \"$P1D_TLS_FINGERPRINT\" if API calls fail" ;;
      esac
    fi
    local out line
    if out=$(sync_node_ip "$CONFIG_FILE" "$P1D_NODE_IP" "$P1D_NODE_IPS" "$APP_DIR"); then
      while IFS= read -r line; do
        case $line in
          'pin '*) PIN_ADDR=${line#pin } ;;
          'changed '*) ok "updated ${line#changed } (the Proxmox host no longer has the old address)" ;;
        esac
      done <<<"$out"
      is_ipv4 "$PIN_ADDR" || PIN_ADDR=$P1D_NODE_IP
    else
      warn "could not check the Proxmox address in $CONFIG_FILE; if the host's IP changed, update proxmox.url and inventory.host.address"
    fi
    if [[ -n $P1D_PUBLIC_URL || -n $P1D_ALLOWED_SOURCES ]]; then
      if out=$(set_config_values "$CONFIG_FILE" "$P1D_PUBLIC_URL" "$P1D_ALLOWED_SOURCES" "$APP_DIR"); then
        while IFS= read -r line; do
          if [[ $line == 'changed '* ]]; then ok "set ${line#changed }"; fi
        done <<<"$out"
      else
        warn "could not update $CONFIG_FILE; set publicUrl / listen.allowedSources by hand: pve1-dash-config"
      fi
    fi
  else
    local tmp
    tmp=$(mktemp "$CONF_DIR/.config.XXXXXX")
    render_config >"$tmp"
    mv -f "$tmp" "$CONFIG_FILE"
    ok "wrote $CONFIG_FILE"
  fi
  chown root:"$SVC_USER" "$CONFIG_FILE"
  chmod 0640 "$CONFIG_FILE"
}

# Store a new secret (written next to the old file, then renamed over it), or check the stored one's permissions.
write_token() {
  if [[ -n ${P1D_TOKEN_SECRET-} ]]; then
    install -o root -g "$SVC_USER" -m 0640 /dev/null "$TOKEN_FILE.new"
    printf '%s\n' "$P1D_TOKEN_SECRET" >"$TOKEN_FILE.new"
    mv -f "$TOKEN_FILE.new" "$TOKEN_FILE"
    ok "stored the API token secret in $TOKEN_FILE"
  elif [[ -s $TOKEN_FILE ]]; then
    chown root:"$SVC_USER" "$TOKEN_FILE"
    chmod 0640 "$TOKEN_FILE"
  elif [[ -f $CONFIG_FILE ]]; then
    warn "$TOKEN_FILE is missing; the existing config must provide the token secret itself (proxmox.tokenSecret)"
  else
    die "no API token secret: $TOKEN_FILE is missing and P1D_TOKEN_SECRET is empty (re-run install.sh and let it rotate the token)"
  fi
}

# ───────────────────────────────────────────────────────────────────────── SSH

# Pin HOST's key in FILE: drop earlier entries for exactly that host name (alone or in a comma list) and keep
# everything else: guest keys the dashboard learned on first use, and @revoked / @cert-authority lines.
write_known_hosts() {
  local file=$1 host=$2 key=$3 tmp
  tmp=$(mktemp "$file.XXXXXX")
  if [[ -f $file ]]; then
    awk -v h="$host" '
      $1 ~ /^@/ { print; next }
      { n = split($1, hs, ","); for (i = 1; i <= n; i++) if (hs[i] == h) next; print }' "$file" >"$tmp"
  fi
  printf '%s %s\n' "$host" "$key" >>"$tmp"
  mv -f "$tmp" "$file"
}

setup_ssh() {
  local key=$SSH_DIR/id_ed25519 host=${PIN_ADDR:-$P1D_NODE_IP}
  if [[ ! -s $key ]]; then
    rm -f "$key" "$key.pub"
    ssh-keygen -q -t ed25519 -N '' -C "pve1-dash@ct${P1D_CTID:-0}" -f "$key"
    ok "created the dashboard SSH key $key"
  fi
  if [[ ! -s $key.pub ]]; then ssh-keygen -y -f "$key" >"$key.pub"; fi
  write_known_hosts "$SSH_DIR/known_hosts" "$host" "$P1D_HOST_KEY"
  chown "$SVC_USER:$SVC_USER" "$key" "$key.pub" "$SSH_DIR/known_hosts"
  chmod 0600 "$key" "$SSH_DIR/known_hosts"
  chmod 0644 "$key.pub"
  ok "pinned the Proxmox host key for $host in $SSH_DIR/known_hosts"
}

# ───────────────────────────────────────────────────────────────────────── main

lxc_setup_main() {
  trap 'lxc_on_error $LINENO' ERR
  [[ $EUID -eq 0 ]] || die 'run this as root inside the pve1-dash container.'
  umask 022
  load_settings "${1-}"
  local need_config=no staging=$APP_DIR.new upgrade=no
  if [[ ! -f $CONFIG_FILE ]]; then need_config=yes; fi
  if [[ -d $APP_DIR ]]; then upgrade=yes; fi
  validate_settings "$need_config"
  export HOME=${HOME:-/root}

  # The settings file is already deleted: store a new token secret first, it exists nowhere else.
  ensure_user
  setup_dirs
  write_token

  apt_packages
  say "fetching $PVE1_DASH_REPO @ $PVE1_DASH_REF${P1D_COMMIT:+ (${P1D_COMMIT:0:12})} ..."
  checkout "$PVE1_DASH_REPO" "$PVE1_DASH_REF" "$staging" "$P1D_COMMIT"
  [[ -f $staging/deploy/update.sh ]] || die "$PVE1_DASH_REF has no deploy/update.sh"
  # shellcheck source=deploy/update.sh
  source "$staging/deploy/update.sh"

  # Older update.sh versions (an explicit old PVE1_DASH_REF) have no space check.
  if declare -F check_free_space >/dev/null; then check_free_space "${APP_DIR%/*}"; fi
  try_update_node
  build_release "$staging"
  activate_release "$staging"
  ok "pve1-dash $(git -C "$APP_DIR" rev-parse --short=12 HEAD) is in $APP_DIR"

  write_config
  setup_ssh
  install_system_files
  systemctl daemon-reload
  if ! start_service; then
    # Like pve1-dash-update: an upgrade that does not come up restores the version that ran before.
    if [[ $upgrade == yes ]] && rollback_release; then
      warn 'the new version did not start; restoring the previous one'
      install_system_files
      start_service || warn 'the previous version did not come back healthy either'
      die "the new version ($PVE1_DASH_REF) did not become healthy and was rolled back; the failed build is in $APP_DIR.failed. See the log lines above; to stay on a known-good version, re-run with PVE1_DASH_REF=<tag>."
    fi
    die 'the service did not become healthy (see the log lines above).'
  fi
  # Recorded only once the new version runs, so a rolled-back run keeps the previous source.
  save_install_env "$PVE1_DASH_REPO" "$PVE1_DASH_REF" "${P1D_CTID-}"
  ok 'setup complete'
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  lxc_setup_main "$@"
fi
