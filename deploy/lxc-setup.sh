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
#   P1D_TLS_FINGERPRINT            SHA-256 of the Proxmox certificate, "AB:CD:..."      (required for a new config)
#   P1D_VAPID_EMAIL                your email address, the Web Push contact             (required for a new config)
#   P1D_PUBLIC_URL                 public HTTPS URL of the dashboard                    (optional)
#   P1D_TOKEN_ID                   API token id (default pve1dash@pve!dashboard)
#   P1D_TOKEN_SECRET               token secret; needed on the first install and after a rotation
#   P1D_CTID                       this container's id (used in the SSH key comment)
#
# Result: Node.js 24 in /opt/node, the app in /opt/pve1-dash (built from source), the system user pve1dash,
# /etc/pve1-dash/{config.yaml,token,ssh/}, state in /var/lib/pve1-dash, the systemd service pve1-dash and the
# update tool /usr/local/bin/pve1-dash-update. An existing config.yaml is kept; only its TLS fingerprint is updated
# when the Proxmox certificate changed.
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
DATA_DIR=/var/lib/pve1-dash
SVC_USER=pve1dash
DEFAULT_TOKEN_ID='pve1dash@pve!dashboard'
SETUP_REPO_DEFAULT='https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git'

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

# Defense in depth: everything below ends up in config files, so check the shapes even though install.sh did.
validate_settings() {
  local need_config=$1
  PVE1_DASH_REPO=${PVE1_DASH_REPO:-$SETUP_REPO_DEFAULT}
  PVE1_DASH_REF=${PVE1_DASH_REF:-main}
  P1D_TOKEN_ID=${P1D_TOKEN_ID:-$DEFAULT_TOKEN_ID}
  P1D_PUBLIC_URL=${P1D_PUBLIC_URL-}
  P1D_PUBLIC_URL=${P1D_PUBLIC_URL%/}
  P1D_TLS_FINGERPRINT=${P1D_TLS_FINGERPRINT-}
  P1D_TLS_FINGERPRINT=${P1D_TLS_FINGERPRINT^^}
  [[ $PVE1_DASH_REPO =~ ^(https://|git@|file:///)[A-Za-z0-9@:/._~+-]{3,300}$ ]] || die "PVE1_DASH_REPO=\"$PVE1_DASH_REPO\" is not a git URL"
  [[ $PVE1_DASH_REF =~ ^[A-Za-z0-9._/-]{1,200}$ && $PVE1_DASH_REF != *..* && $PVE1_DASH_REF != -* ]] || die "PVE1_DASH_REF=\"$PVE1_DASH_REF\" is invalid"
  is_ipv4 "${P1D_NODE_IP-}" || die 'P1D_NODE_IP must be the IPv4 address of the Proxmox host'
  is_host_key "${P1D_HOST_KEY-}" || die 'P1D_HOST_KEY must be "ssh-ed25519 AAAA..." (the host'"'"'s /etc/ssh/ssh_host_ed25519_key.pub without comment)'
  is_token_id "$P1D_TOKEN_ID" || die "P1D_TOKEN_ID=\"$P1D_TOKEN_ID\" is not user@realm!name"
  if [[ -n ${P1D_TOKEN_SECRET-} ]]; then is_token_secret "$P1D_TOKEN_SECRET" || die 'P1D_TOKEN_SECRET has an unexpected format'; fi
  [[ -z ${P1D_CTID-} || $P1D_CTID =~ ^[0-9]{1,9}$ ]] || die 'P1D_CTID must be a number'
  if [[ -n $P1D_TLS_FINGERPRINT ]]; then is_fingerprint "$P1D_TLS_FINGERPRINT" || die 'P1D_TLS_FINGERPRINT must look like AB:CD:... (32 bytes)'; fi
  if [[ $need_config == yes ]]; then
    is_node "${P1D_NODE-}" || die 'P1D_NODE must be the Proxmox node name (e.g. pve1)'
    [[ -n $P1D_TLS_FINGERPRINT ]] || die 'P1D_TLS_FINGERPRINT is required for a new config'
    is_email "${P1D_VAPID_EMAIL-}" || die 'P1D_VAPID_EMAIL must be your email address (Web Push contact)'
    [[ -z $P1D_PUBLIC_URL ]] || is_https_url "$P1D_PUBLIC_URL" || die 'P1D_PUBLIC_URL must be an https:// URL'
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

# Shallow checkout of REPO at REF into DIR (the same steps as fetch_source in update.sh, needed before it exists).
checkout() {
  local repo=$1 ref=$2 dir=$3
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "$repo"
  git -C "$dir" fetch -q --depth 1 origin "$ref" || die "git fetch of \"$ref\" from $repo failed"
  git -C "$dir" -c advice.detachedHead=false checkout -q --force FETCH_HEAD
}

# ───────────────────────────────────────────────────────────────────────── config

# A YAML double-quoted scalar.
yq() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# The initial /etc/pve1-dash/config.yaml (on stdout). Parsed by server/config.ts (ConfigSchema); every option and its
# default is documented in deploy/config.example.yaml.
render_config() {
  local public
  if [[ -n ${P1D_PUBLIC_URL-} ]]; then
    public="publicUrl: $(yq "$P1D_PUBLIC_URL")"
  else
    public='# publicUrl: "https://dash.home.lan"   # your HTTPS URL behind the reverse proxy (needed for iPhone push)'
  fi
  cat <<EOF
# pve1-dash configuration, written by the installer on $(date -u +%Y-%m-%d).
# All options with their defaults and examples: /opt/pve1-dash/deploy/config.example.yaml
# After editing: systemctl restart pve1-dash   (then check: journalctl -u pve1-dash -n 30)

title: $(yq "$P1D_NODE")
$public
dataDir: /var/lib/pve1-dash

proxmox:
  url: $(yq "https://$P1D_NODE_IP:8006")
  node: $(yq "$P1D_NODE")
  tokenId: $(yq "$P1D_TOKEN_ID")
  tokenSecretFile: /etc/pve1-dash/token
  tls:
    # SHA-256 of the certificate pveproxy serves. Update it after the certificate changes
    # (docs/TROUBLESHOOTING.md "TLS fingerprint mismatch"); re-running install.sh does that for you.
    fingerprint: $(yq "$P1D_TLS_FINGERPRINT")

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

# Set proxmox.tls.fingerprint in FILE to FP, keeping everything else. Returns 0 when changed, 1 when it already had
# FP, 2 when there is not exactly one "fingerprint:" line to update.
set_fingerprint() {
  local file=$1 fp=$2 n current
  n=$(grep -cE '^[[:space:]]+fingerprint:' "$file") || n=0
  [[ $n == 1 ]] || return 2
  current=$(sed -nE 's/^[[:space:]]+fingerprint:[[:space:]]*["'"'"']?([0-9A-Fa-f:]*).*/\1/p' "$file")
  if [[ ${current^^} == "$fp" ]]; then return 1; fi
  sed -i -E "s/^([[:space:]]+fingerprint:).*/\\1 \"$fp\"/" "$file"
}

write_config() {
  if [[ -f $CONFIG_FILE ]]; then
    ok "keeping $CONFIG_FILE"
    if [[ -n $P1D_TLS_FINGERPRINT ]]; then
      local rc=0
      set_fingerprint "$CONFIG_FILE" "$P1D_TLS_FINGERPRINT" || rc=$?
      case $rc in
        0) ok 'updated proxmox.tls.fingerprint (the Proxmox certificate changed)' ;;
        1) : ;;
        *) warn "could not update proxmox.tls.fingerprint automatically; set it to \"$P1D_TLS_FINGERPRINT\" if API calls fail" ;;
      esac
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

write_token() {
  if [[ -n ${P1D_TOKEN_SECRET-} ]]; then
    install -o root -g "$SVC_USER" -m 0640 /dev/null "$TOKEN_FILE"
    printf '%s\n' "$P1D_TOKEN_SECRET" >"$TOKEN_FILE"
    ok "stored the API token secret in $TOKEN_FILE"
  elif [[ -s $TOKEN_FILE ]]; then
    chown root:"$SVC_USER" "$TOKEN_FILE"
    chmod 0640 "$TOKEN_FILE"
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
  local key=$SSH_DIR/id_ed25519
  if [[ ! -s $key ]]; then
    rm -f "$key" "$key.pub"
    ssh-keygen -q -t ed25519 -N '' -C "pve1-dash@ct${P1D_CTID:-0}" -f "$key"
    ok "created the dashboard SSH key $key"
  fi
  if [[ ! -s $key.pub ]]; then ssh-keygen -y -f "$key" >"$key.pub"; fi
  write_known_hosts "$SSH_DIR/known_hosts" "$P1D_NODE_IP" "$P1D_HOST_KEY"
  chown "$SVC_USER:$SVC_USER" "$key" "$key.pub" "$SSH_DIR/known_hosts"
  chmod 0600 "$key" "$SSH_DIR/known_hosts"
  chmod 0644 "$key.pub"
  ok "pinned the Proxmox host key for $P1D_NODE_IP in $SSH_DIR/known_hosts"
}

# ───────────────────────────────────────────────────────────────────────── main

lxc_setup_main() {
  trap 'lxc_on_error $LINENO' ERR
  [[ $EUID -eq 0 ]] || die 'run this as root inside the pve1-dash container.'
  umask 022
  load_settings "${1-}"
  local need_config=no staging=$APP_DIR.new
  if [[ ! -f $CONFIG_FILE ]]; then need_config=yes; fi
  validate_settings "$need_config"
  export HOME=${HOME:-/root}

  apt_packages
  ensure_user
  say "fetching $PVE1_DASH_REPO @ $PVE1_DASH_REF ..."
  checkout "$PVE1_DASH_REPO" "$PVE1_DASH_REF" "$staging"
  [[ -f $staging/deploy/update.sh ]] || die "$PVE1_DASH_REF has no deploy/update.sh"
  # shellcheck source=deploy/update.sh
  source "$staging/deploy/update.sh"

  try_update_node
  build_release "$staging"
  activate_release "$staging"
  ok "pve1-dash $(git -C "$APP_DIR" rev-parse --short=12 HEAD) is in $APP_DIR"

  setup_dirs
  write_token
  write_config
  setup_ssh
  save_install_env "$PVE1_DASH_REPO" "$PVE1_DASH_REF"
  install_system_files
  systemctl daemon-reload
  start_service || die 'the service did not become healthy (see the log lines above).'
  ok 'setup complete'
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  lxc_setup_main "$@"
fi
