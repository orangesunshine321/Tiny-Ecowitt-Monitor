#!/usr/bin/env bash
# pve1-dash installer. Run as root ON THE PROXMOX VE HOST (PVE 8.x or 9.x):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)"
#
# Until the pve1-dash branch is merged, "main" of that repository still holds the old Tiny Ecowitt app. Install from
# the branch instead: name it in the URL and in PVE1_DASH_REF (README.md has the full command):
#
#   PVE1_DASH_REF=claude/homelab-dashboard-pve1-dizt16 bash -c "$(curl -fsSL \
#     https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/claude/homelab-dashboard-pve1-dizt16/deploy/install.sh)"
#
# What it does (details in docs/SETUP.md, the security model in docs/SECURITY.md):
#   1. creates an unprivileged Debian LXC (tag "pve1-dash", no root password, nesting on, start on boot);
#   2. creates the read-only API user pve1dash@pve and token pve1dash@pve!dashboard (role PVEAuditor on /; a second
#      dashboard in the same cluster gets its own token, pve1dash@pve!dashboard-ct<id>);
#   3. installs Node.js 24 LTS and pve1-dash inside the container (deploy/lxc-setup.sh) as the systemd service
#      pve1-dash, listening on http://<container-ip>:8080;
#   4. installs the read-only forced-command helper /usr/local/sbin/pve1-dash-helper on the host and authorizes the
#      dashboard's SSH key for it (and nothing else) in /root/.ssh/authorized_keys.
#
# It is idempotent: run it again to upgrade or repair an existing install (it finds the container by its tag and
# keeps the source the container was installed from). Refresh only the host helper after a dashboard update:
#   bash -c "$(curl -fsSL .../deploy/install.sh)" -- --update-helper
#
# Every question can be answered up front with an environment variable (see --help) and --yes accepts the defaults,
# so it also runs unattended.
#
# Facts about pct/pveam/pvesm/pveum/pvesh used here come from docs/research/pve-perms-cli.md. Commands that are not
# covered there are marked "UNVERIFIED" next to their use.
#
# The functions are sourceable for tests (tests/deploy-install.test.ts); main only runs when executed.

set -Eeuo pipefail

# ───────────────────────────────────────────────────────────────────────── constants

readonly DEFAULT_REPO='https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git'
readonly DEFAULT_REF='main'
# Until it is merged, pve1-dash lives on this branch of DEFAULT_REPO ("main" still holds the old Tiny Ecowitt app).
readonly PREMERGE_REF='claude/homelab-dashboard-pve1-dizt16'
readonly PVE_USER='pve1dash@pve'
readonly DEFAULT_TOKEN_NAME='dashboard'
readonly CT_TAG='pve1-dash'
readonly HELPER_PATH='/usr/local/sbin/pve1-dash-helper'
readonly AUTHORIZED_KEYS='/root/.ssh/authorized_keys'
readonly DEFAULT_LISTEN_PORT=8080
readonly INSTALL_LOG='/var/log/pve1-dash-install.log'
readonly HELPER_DIFF='/var/log/pve1-dash-helper.diff'
readonly CT_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
readonly STEP_TOTAL=9

ASSUME_YES=0
STEP_NO=0
CURRENT_STEP='startup'
WORK_DIR=''
CT_TOUCHED=''
MODE=''
CTID=''
NEED_CONFIG=yes
# This dashboard's API token. Tokens are cluster-wide: the first dashboard uses "dashboard", another one in the same
# cluster gets "dashboard-ct<id>" (choose_token_name). TOKEN_MANAGED=no: the config names a token of someone else.
TOKEN_NAME=$DEFAULT_TOKEN_NAME
TOKEN_ID="$PVE_USER!$DEFAULT_TOKEN_NAME"
TOKEN_MANAGED=yes
TOKEN_SECRET=''
ROTATE_LATE=no
REF_COMMIT=''
REF_EXPLICIT=''
REPO_EXPLICIT=''
DEBIAN_EXPLICIT=''
DEBIAN_NOTE=''
PVE_HOST=''
NET0_CURRENT=''
NET0_NEW=''
C_B='' C_DIM='' C_G='' C_Y='' C_R='' C_C='' C_0=''

# ───────────────────────────────────────────────────────────────────────── output

setup_colors() {
  if [[ -t 1 && -z ${NO_COLOR:-} && ${TERM:-dumb} != dumb ]]; then
    C_B=$'\e[1m' C_DIM=$'\e[2m' C_G=$'\e[32m' C_Y=$'\e[33m' C_R=$'\e[31m' C_C=$'\e[36m' C_0=$'\e[0m'
  fi
}

step() {
  STEP_NO=$((STEP_NO + 1))
  CURRENT_STEP=$*
  printf '\n%s[%d/%d] %s%s\n' "$C_B$C_C" "$STEP_NO" "$STEP_TOTAL" "$*" "$C_0"
}
say() { printf '  %s\n' "$*"; }
ok() { printf '  %s✔%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die() {
  printf '\n%serror:%s %s\n' "$C_R" "$C_0" "$*" >&2
  exit 1
}

# Log the output of a long command to the install log and the screen; keeps the command's exit status (pipefail).
logged() {
  {
    printf '\n### %s: %s\n' "$(date -Is 2>/dev/null || date)" "$*"
  } >>"$INSTALL_LOG" 2>/dev/null || :
  "$@" 2>&1 | tee -a "$INSTALL_LOG"
}

on_error() {
  local code=$? line=${1:-?}
  # Command substitutions and pipelines are subshells: leave quietly, the parent reports the failure once.
  if ((BASH_SUBSHELL > 0)); then exit "$code"; fi
  trap - ERR
  printf '\n%s✘ The installer stopped during "%s"%s (line %s, exit code %s).\n' "$C_R" "$CURRENT_STEP" "$C_0" "$line" "$code" >&2
  printf '  Everything done so far is kept, and the installer is safe to run again once the cause is fixed.\n' >&2
  if [[ -n $CT_TOUCHED ]]; then
    printf '  Container %s: look inside with "pct enter %s" (journalctl -u pve1-dash, /var/log/apt/term.log).\n' "$CT_TOUCHED" "$CT_TOUCHED" >&2
  fi
  printf '  Install log: %s  ·  Help: docs/TROUBLESHOOTING.md\n' "$INSTALL_LOG" >&2
  exit "$code"
}

cleanup() {
  if [[ -n $WORK_DIR && -d $WORK_DIR ]]; then rm -rf "$WORK_DIR"; fi
}

usage() {
  cat <<'EOF'
pve1-dash installer (run as root on the Proxmox VE host)

Usage:
  install.sh [--yes] [--ctid N]       install, upgrade or repair
  install.sh --update-helper [--ctid N]
                                       only refresh /usr/local/sbin/pve1-dash-helper and the authorized_keys line
  install.sh --help

Options:
  -y, --yes          never ask; use environment values, then defaults (PVE1_DASH_VAPID_EMAIL is required)
  --ctid N           the container to create, or the existing dashboard container to use
  --update-helper    see above (use after "pve1-dash-update" in the container says the helper changed)

Before the pve1-dash branch is merged into main, "main" still holds the old Tiny Ecowitt app: install with
PVE1_DASH_REF=claude/homelab-dashboard-pve1-dizt16 (README.md shows the whole command).

Environment (each one also skips its question):
  PVE1_DASH_REPO, PVE1_DASH_REF     git source (default: the GitHub repo, ref "main"; an existing container keeps
                                    the source it was installed from)
  PVE1_DASH_USE_RECORDED_REPO       yes/no: keep a non-default repository recorded in the existing container
  PVE1_DASH_CTID                    container id (default: next free id)
  PVE1_DASH_HOSTNAME                container hostname (pve1-dash)
  PVE1_DASH_STORAGE                 storage for the container disk (content rootdir)
  PVE1_DASH_DISK                    disk size in GiB (6)
  PVE1_DASH_TEMPLATE_STORAGE        storage for the Debian template (content vztmpl)
  PVE1_DASH_DEBIAN                  Debian release of the template: 13 (default; 12 when pve-container is too old) or 12
  PVE1_DASH_BRIDGE, PVE1_DASH_VLAN  network bridge (vmbr0) and optional VLAN tag
  PVE1_DASH_IP, PVE1_DASH_GATEWAY   "dhcp" (default) or a static CIDR such as 192.168.1.60/24, plus its gateway.
                                    With an existing container, the network settings given here are applied to it.
  PVE1_DASH_BRIDGE_MISSING_OK       yes: use a bridge that does not exist on this host (yet)
  PVE1_DASH_CORES, PVE1_DASH_MEMORY, PVE1_DASH_SWAP   1 core, 1024 MiB, 512 MiB
  PVE1_DASH_NODE_IP                 IP of this host that the dashboard connects to (auto-detected)
  PVE1_DASH_PVE_HOST                host name on a publicly trusted (ACME) certificate of this host: verify it with
                                    the public CAs instead of pinning it (asked when pveproxy-ssl.pem is in use)
  PVE1_DASH_PUBLIC_URL              public HTTPS URL behind your reverse proxy, e.g. https://dash.home.lan
  PVE1_DASH_VAPID_EMAIL             your real email address (Web Push contact; Apple rejects localhost)
  PVE1_DASH_SENSORS                 yes/no: install lm-sensors on this host for temperatures (no)
  PVE1_DASH_ROTATE_TOKEN            yes/no: replace an existing API token
  PVE1_DASH_EXISTING                update/new: what to do when a pve1-dash container already exists (update)
  PVE1_DASH_TRUST_CT_HELPER         yes: install the container's helper even if it differs from the repo copy
  PVE1_DASH_RAW_BASE                base URL for raw repo files (default: derived from a GitHub PVE1_DASH_REPO;
                                    file:///path/to/checkout works for local testing)
  PVE1_DASH_SKIP_NETCHECK           1: skip the internet reachability check
  NO_COLOR                          disable colours
EOF
}

# ───────────────────────────────────────────────────────────────────────── questions

# ask VAR QUESTION [DEFAULT]: a preset (environment) value wins; --yes takes the default; otherwise ask on the
# terminal. Reads /dev/tty, so it also works when the script itself arrives on stdin.
ask() {
  local __var=$1 __q=$2 __def=${3-} __ans=''
  if [[ -n ${!__var-} ]]; then return 0; fi
  if ((ASSUME_YES)); then
    printf -v "$__var" '%s' "$__def"
    return 0
  fi
  if ! { : </dev/tty; } 2>/dev/null; then
    die "no terminal to ask \"$__q\". Re-run with --yes and the PVE1_DASH_* variables (see --help)."
  fi
  read -r -p "  ${C_B}?${C_0} ${__q}${__def:+ ${C_DIM}[$__def]${C_0}}: " __ans </dev/tty || die 'input aborted'
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_valid VAR QUESTION DEFAULT CHECK_FUNCTION HINT: like ask, but repeats until CHECK_FUNCTION accepts the answer.
# A preset or --yes value that fails the check is fatal.
ask_valid() {
  local var=$1 q=$2 def=$3 check=$4 hint=$5 preset=${!1-}
  while :; do
    ask "$var" "$q" "$def"
    if "$check" "${!var}"; then return 0; fi
    if [[ -n $preset ]] || ((ASSUME_YES)); then die "$var=\"${!var}\": $hint"; fi
    warn "$hint"
    printf -v "$var" '%s' ''
  done
}

# ask_yn VAR QUESTION DEFAULT(yes|no): stores "yes" or "no".
ask_yn() {
  local var=$1 q=$2 def=$3
  local hint=${def/yes/Y\/n}
  hint=${hint/no/y\/N}
  while :; do
    ask "$var" "$q ($hint)" "$def"
    case ${!var,,} in
      y | yes | 1 | true | on)
        printf -v "$var" yes
        return 0
        ;;
      n | no | 0 | false | off)
        printf -v "$var" no
        return 0
        ;;
    esac
    if ((ASSUME_YES)); then die "$var=\"${!var}\": expected yes or no"; fi
    warn 'please answer yes or no'
    printf -v "$var" '%s' ''
  done
}

# ───────────────────────────────────────────────────────────────────────── validators

is_ctid() { [[ $1 =~ ^[1-9][0-9]{2,8}$ ]]; }
is_hostname() { [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; }
is_disk_gb() { [[ $1 =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 4)); }
is_cores() { [[ $1 =~ ^[0-9]{1,4}$ ]] && ((10#$1 >= 1)); }
is_memory() { [[ $1 =~ ^[0-9]{1,7}$ ]] && ((10#$1 >= 512)); }
is_swap() { [[ $1 =~ ^[0-9]{1,7}$ ]]; }
is_vlan() { [[ -z $1 ]] || { [[ $1 =~ ^[0-9]{1,4}$ ]] && ((10#$1 >= 1 && 10#$1 <= 4094)); }; }
is_bridge() { [[ $1 =~ ^[A-Za-z][A-Za-z0-9_.-]{0,14}$ ]]; }
is_storage_id() { [[ $1 =~ ^[A-Za-z][A-Za-z0-9._-]{0,63}$ ]]; }
is_debian() { [[ $1 == 13 || $1 == 12 ]]; }

is_ipv4() {
  local ip=$1 o
  [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do ((10#$o <= 255)) || return 1; done
}

# "dhcp" or an IPv4 CIDR such as 192.168.1.60/24 (the net0 "ip=" syntax).
is_ip_setting() {
  [[ $1 == dhcp ]] && return 0
  [[ $1 == */* ]] || return 1
  is_ipv4 "${1%/*}" || return 1
  local len=${1#*/}
  [[ $len =~ ^[0-9]{1,2}$ ]] && ((10#$len >= 1 && 10#$len <= 32))
}

is_gateway() { [[ -z $1 ]] || is_ipv4 "$1"; }

# A fully qualified host name (at least one dot), not an IP address.
is_dns_name() {
  [[ ${#1} -le 253 && $1 =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] && ! is_ipv4 "$1"
}
is_dns_name_or_empty() { [[ -z $1 ]] || is_dns_name "$1"; }

# Empty (no reverse proxy yet) or an https:// URL with a plain host name and optional port/path.
is_public_url() {
  [[ -z $1 ]] && return 0
  [[ $1 =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]
}

# The VAPID contact must be a real, deliverable address: Apple's push service answers 403 BadJwtToken for localhost
# subjects, and reportedly for reserved TLDs too (docs/research/web-pwa-push.md §3.2; the reserved-TLD part is
# UNVERIFIED, so this check errs on the strict side).
is_vapid_email() {
  local e=${1,,} domain tld
  [[ $e =~ ^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || return 1
  domain=${e#*@}
  tld=${domain##*.}
  case $tld in
    localhost | local | lan | home | internal | invalid | test | example | arpa | localdomain | corp) return 1 ;;
  esac
  [[ $domain != localhost* ]]
}

is_ref() { [[ $1 =~ ^[A-Za-z0-9._/-]{1,200}$ && $1 != *..* && $1 != -* ]]; }
is_repo() { [[ $1 =~ ^(https://|git@|file:///)[A-Za-z0-9@:/._~+-]{3,300}$ ]]; }

# ───────────────────────────────────────────────────────────────────────── network math

# 192.168.1.10 -> 3232235786
ip_to_int() {
  local -a o
  IFS=. read -r -a o <<<"$1"
  printf '%s\n' "$(((10#${o[0]} << 24) | (10#${o[1]} << 16) | (10#${o[2]} << 8) | 10#${o[3]}))"
}

# ip_in_cidr IP CIDR: is IP inside the network of CIDR (a.b.c.d/len)?
ip_in_cidr() {
  local ip=$1 net=${2%/*} len=${2#*/} a b mask
  if ! is_ipv4 "$ip" || ! is_ipv4 "$net" || [[ ! $len =~ ^[0-9]{1,2}$ ]] || ((10#$len > 32)); then return 1; fi
  a=$(ip_to_int "$ip")
  b=$(ip_to_int "$net")
  mask=$(((0xFFFFFFFF << (32 - 10#$len)) & 0xFFFFFFFF))
  (((a & mask) == (b & mask)))
}

# net0_merge CURRENT KEY=VALUE...: the net0 property string CURRENT with each KEY set to VALUE (an empty VALUE removes
# KEY). Other keys (hwaddr, type, firewall, ...) keep their values and order, so the MAC address (and a DHCP
# reservation for it) survives.
net0_merge() {
  local cur=$1 kv k item out=''
  shift
  local -A want=()
  local -a order=() items=()
  for kv in "$@"; do
    k=${kv%%=*}
    want[$k]=${kv#*=}
    order+=("$k")
  done
  IFS=, read -r -a items <<<"$cur"
  for item in "${items[@]}"; do
    [[ -n $item ]] || continue
    k=${item%%=*}
    if [[ -v "want[$k]" ]]; then
      if [[ -n ${want[$k]} ]]; then out+=",$k=${want[$k]}"; fi
      unset "want[$k]"
    else
      out+=",$item"
    fi
  done
  for k in "${order[@]}"; do
    if [[ -v "want[$k]" ]]; then
      if [[ -n ${want[$k]} ]]; then out+=",$k=${want[$k]}"; fi
      unset "want[$k]"
    fi
  done
  printf '%s\n' "${out#,}"
}

# ───────────────────────────────────────────────────────────────────────── host facts

# Major version from `pveversion` ("pve-manager/9.0.10/0123456789abcdef (running kernel: ...)", research §8).
pve_major() {
  local out
  out=$(pveversion 2>/dev/null) || return 1
  sed -nE 's#^pve-manager/([0-9]+)\..*#\1#p' <<<"$out" | head -n 1
}

pve_version() { pveversion 2>/dev/null | sed -nE 's#^pve-manager/([0-9.]+)/.*#\1#p' | head -n 1; }

# PVE's node name is the short host name.
node_name() {
  local h
  h=$(hostname 2>/dev/null) || return 1
  h=${h%%.*}
  [[ -n $h ]] && printf '%s\n' "$h"
}

# The IPv4 address of this host on its default route (ip route), else the first IPv4 from `hostname -I`.
detect_node_ip() {
  local ip='' w
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }') || ip=''
  if is_ipv4 "${ip:-x}"; then
    printf '%s\n' "$ip"
    return 0
  fi
  for w in $(hostname -I 2>/dev/null); do
    if is_ipv4 "$w"; then
      printf '%s\n' "$w"
      return 0
    fi
  done
  return 1
}

# All IPv4 addresses of this host, space separated (lxc-setup keeps a config that points at one of them).
host_ipv4s() {
  local w out=''
  for w in $(hostname -I 2>/dev/null); do
    if is_ipv4 "$w"; then out+=" $w"; fi
  done
  printf '%s\n' "${out# }"
}

default_gateway() { ip -4 route show default 2>/dev/null | awk '$1 == "default" && $2 == "via" { print $3; exit }'; }

host_arch() {
  local a
  a=$(dpkg --print-architecture 2>/dev/null) || a=$(uname -m)
  case $a in
    amd64 | x86_64) echo amd64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) echo "$a" ;;
  esac
}

# Next free guest id: `pvesh get /cluster/nextid` prints the bare integer (research §5.8).
next_ctid() {
  local id
  id=$(pvesh get /cluster/nextid 2>/dev/null | tr -d '[:space:]"') || return 1
  is_ctid "$id" && printf '%s\n' "$id"
}

# `pvesh get /cluster/nextid --vmid N` fails with "VM N already exists" when N is taken (research §5.8).
ctid_free() { pvesh get /cluster/nextid --vmid "$1" >/dev/null 2>&1; }

# Active storages allowing a content type, one id per line. `pvesm status` prints a header line, then
# "<name> <type> <status> <total> <used> <avail> <pct>" (research §5.7).
list_storages() {
  pvesm status --content "$1" 2>/dev/null | awk 'NR > 1 && $3 == "active" && $1 ~ /^[A-Za-z][A-Za-z0-9._-]*$/ { print $1 }'
}

# pick_default "PREFERRED..." < candidates: the first preferred id present, else the first candidate.
pick_default() {
  local want c
  local -a cands=() prefs=()
  mapfile -t cands
  read -r -a prefs <<<"$1"
  for want in "${prefs[@]}"; do
    for c in "${cands[@]}"; do
      if [[ $c == "$want" ]]; then
        printf '%s\n' "$c"
        return 0
      fi
    done
  done
  if ((${#cands[@]})); then printf '%s\n' "${cands[0]}"; fi
}

# member WORD LIST...: is WORD one of LIST?
member() {
  local w=$1 x
  shift
  for x in "$@"; do [[ $x == "$w" ]] && return 0; done
  return 1
}

bridge_exists() { [[ -d /sys/class/net/$1 ]]; }

# version_lt A B: is version A older than B (dpkg-style dotted numbers)?
version_lt() { [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1) == "$1" ]]; }

# Debian 13.1+ templates need pve-container 6.0.10 (PVE 9) or 5.3.1 (PVE 8); older ones fail in pct create with
# "unsupported debian version" (research §5.5). Is pve-container VERSION on PVE MAJOR older than that?
pve_container_too_old_for_13() {
  local v=$1 major=$2
  [[ -n $v ]] || return 1
  case $major in
    8) version_lt "$v" 5.3.1 ;;
    9) version_lt "$v" 6.0.10 ;;
    *) return 1 ;;
  esac
}

# ───────────────────────────────────────────────────────────────────────── templates

# Newest Debian "standard" template in the appliance index. `pveam available --section system` prints
# "<section> <template>" on PVE 8 and "<section> <template> <arch>" on PVE >= 9.2.7; the name is field 2 in both
# (research §5.6).
newest_template() {
  local major=$1 arch=$2
  pveam available --section system 2>/dev/null |
    awk -v re="^debian-${major}-standard_[0-9][^_]*_${arch}[.]tar[.](zst|gz|xz)\$" '$2 ~ re { print $2 }' |
    sort -V | tail -n 1
}

# Template volumes on a storage, as "<template file name>" (from `pveam list <storage>`, "<storage>:vztmpl/<name>").
local_templates() {
  pveam list "$1" 2>/dev/null | awk 'NR > 1 { n = $1; sub(/^[^:]*:vztmpl\//, "", n); print n }'
}

# Newest already-downloaded Debian template (used when the index is unavailable).
newest_local_template() {
  local storage=$1 major=$2 arch=$3
  local_templates "$storage" |
    awk -v re="^debian-${major}-standard_[0-9][^_]*_${arch}[.]tar[.](zst|gz|xz)\$" '$0 ~ re' |
    sort -V | tail -n 1
}

template_present() { local_templates "$1" | grep -qxF -- "$2"; }

# `pveam update` exits 0 even when it fails, so check its text (research §5.6).
refresh_template_index() {
  local out
  out=$(pveam update 2>&1) || :
  if grep -q 'update successful' <<<"$out"; then
    return 0
  fi
  warn "pveam update did not succeed (${out:-no output}); using the cached index. Details: /var/log/pveam.log"
  return 1
}

# ───────────────────────────────────────────────────────────────────────── containers

# Containers on this node tagged pve1-dash, one vmid per line, ascending. Uses the JSON list (tags is a ";" separated
# string and only present when set; research pve-api-guests.md §1/§2.2).
tagged_cts() {
  pvesh get "/nodes/$1/lxc" --output-format json 2>/dev/null | TAG=$CT_TAG perl -MJSON -0777 -ne '
    my $d = eval { decode_json($_) };
    exit 0 unless ref $d eq "ARRAY";
    for my $ct (sort { $a->{vmid} <=> $b->{vmid} } grep { ref $_ eq "HASH" && defined $_->{vmid} } @$d) {
      my @tags = split /[;,\s]+/, ($ct->{tags} // "");
      print "$ct->{vmid}\n" if grep { lc($_) eq $ENV{TAG} } @tags;
    }'
}

# pve1-dash containers in the whole cluster, "<vmid>@<node>" per line (/cluster/resources lists every node's guests
# with their tags; research pve-api-guests.md §7). Fails when the list cannot be read.
cluster_tagged_cts() {
  local out
  out=$(pvesh get /cluster/resources --type vm --output-format json 2>/dev/null) || return 1
  TAG=$CT_TAG perl -MJSON -0777 -ne '
    my $d = eval { decode_json($_) };
    exit 1 unless ref $d eq "ARRAY";
    for my $g (sort { $a->{vmid} <=> $b->{vmid} } grep { ref $_ eq "HASH" && ($_->{type} // "") eq "lxc" && defined $_->{vmid} } @$d) {
      my @tags = split /[;,\s]+/, ($g->{tags} // "");
      print "$g->{vmid}\@", ($g->{node} // "?"), "\n" if grep { lc($_) eq $ENV{TAG} } @tags;
    }' <<<"$out"
}

# Other pve1-dash containers in the cluster than CTID ("<vmid>@<node>" lines). Fails when the list cannot be read.
other_dashboards() {
  local list
  list=$(cluster_tagged_cts) || return 1
  awk -F@ -v me="$1" 'NF && $1 != me' <<<"$list"
}

# "running" / "stopped" from `pct status` ("status: running", research §5.3).
ct_status() { pct status "$1" 2>/dev/null | awk '$1 == "status:" { print $2; exit }'; }

# Run a shell snippet in a container with a clean environment (pct exec keeps the host environment by default).
ct_sh() {
  local ctid=$1
  shift
  pct exec "$ctid" -- env -i PATH="$CT_PATH" HOME=/root LANG=C.UTF-8 sh -c "$@"
}

ct_ipv4() {
  pct exec "$1" -- env -i PATH="$CT_PATH" ip -4 -o addr show dev eth0 scope global 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "inet") { split($(i + 1), a, "/"); print a[1]; exit } }'
}

# The net0 property string of a container, from `pct config` ("net0: name=eth0,bridge=vmbr0,hwaddr=...,ip=dhcp,...").
ct_net0() { pct config "$1" 2>/dev/null | sed -n 's/^net0: //p' | head -n 1 | grep .; }

# Wait until the container has an IPv4 address and working DNS; prints the address.
wait_ct_network() {
  local ctid=$1 deadline=$((SECONDS + ${2:-120})) ip=''
  while ((SECONDS < deadline)); do
    ip=$(ct_ipv4 "$ctid") || ip=''
    if [[ -n $ip ]] && pct exec "$ctid" -- getent ahostsv4 deb.debian.org >/dev/null 2>&1; then
      printf '%s\n' "$ip"
      return 0
    fi
    sleep 2
  done
  return 1
}

# Does NAME resolve to IP inside the container?
ct_resolves_to() {
  ct_sh "$1" "getent ahostsv4 $2" 2>/dev/null | awk -v ip="$3" '$1 == ip { found = 1 } END { exit !found }'
}

# ───────────────────────────────────────────────────────────────────────── API token

set_token_name() {
  TOKEN_NAME=$1
  TOKEN_ID="$PVE_USER!$1"
}

# "pve1dash@pve!NAME" -> NAME; fails for tokens of other users.
token_name_from_id() {
  local re='^pve1dash@pve!([A-Za-z][A-Za-z0-9._-]{0,63})$'
  [[ $1 =~ $re ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

# proxmox.tokenId from the container's config.yaml (untrusted text: callers validate it).
ct_config_token_id() {
  ct_sh "$1" 'cat /etc/pve1-dash/config.yaml' 2>/dev/null |
    sed -nE 's/^[[:space:]]+tokenId:[[:space:]]*["'\'']?([^"'\''[:space:]#]+).*/\1/p' | head -n 1 | grep .
}

# Which token this dashboard uses (TOKEN_NAME/TOKEN_ID). Tokens are cluster-wide, so a second dashboard must never
# take over the first one's: an existing container keeps the token its config names; a new one gets "dashboard"
# unless that token exists and another pve1-dash container in the cluster (or an unreadable cluster list) may hold
# its secret, then "dashboard-ct<id>". A config naming another user's token is left alone (TOKEN_MANAGED=no).
choose_token_name() {
  local ctid=$1 configured name others rc=0
  TOKEN_MANAGED=yes
  if [[ $MODE == update && $NEED_CONFIG == no ]]; then
    configured=$(ct_config_token_id "$ctid") || configured=''
    if [[ -n $configured ]]; then
      if name=$(token_name_from_id "$configured"); then
        set_token_name "$name"
      else
        TOKEN_MANAGED=no
        TOKEN_ID=$configured
        [[ $TOKEN_ID =~ ^[A-Za-z0-9._@!-]{3,200}$ ]] || TOKEN_ID='(unreadable)'
      fi
      return 0
    fi
    warn "could not read proxmox.tokenId from container $ctid's config; assuming the installer's token naming."
  fi
  if ! token_exists "$DEFAULT_TOKEN_NAME"; then
    set_token_name "$DEFAULT_TOKEN_NAME"
    return 0
  fi
  others=$(other_dashboards "$ctid") || rc=$?
  if ((rc != 0)) || [[ -n $others ]]; then
    set_token_name "$DEFAULT_TOKEN_NAME-ct$ctid"
    if ((rc != 0)); then
      say "could not list the cluster's pve1-dash containers; to be safe this one gets its own token, $TOKEN_ID."
    else
      say "other pve1-dash containers (${others//$'\n'/, }) may use $PVE_USER!$DEFAULT_TOKEN_NAME; this one gets its own token, $TOKEN_ID."
    fi
  else
    set_token_name "$DEFAULT_TOKEN_NAME"
  fi
}

# `pveum user add` fails with "... already exists" on a second run (research §4.1).
ensure_pve_user() {
  local out
  if out=$(pveum user add "$PVE_USER" --comment 'pve1-dash read-only dashboard' 2>&1); then
    ok "created user $PVE_USER (no password: it cannot log in to the web UI)"
  elif grep -q 'already exists' <<<"$out"; then
    ok "user $PVE_USER exists"
  else
    die "pveum user add failed: $out"
  fi
  # With privilege separation the token gets user ∩ token privileges, so both need the ACL (research §3.2).
  pveum acl modify / --users "$PVE_USER" --roles PVEAuditor >/dev/null
}

# Does the user have a token named NAME? `pveum user token list <user> --output-format json` prints
# [{"tokenid":"dashboard","privsep":1,...}] (research §4.2).
token_exists() {
  pveum user token list "$PVE_USER" --output-format json 2>/dev/null | TOKEN=${1:-$TOKEN_NAME} perl -MJSON -0777 -ne '
    my $d = eval { decode_json($_) };
    exit 1 unless ref $d eq "ARRAY";
    exit((grep { ref $_ eq "HASH" && ($_->{tokenid} // "") eq $ENV{TOKEN} } @$d) ? 0 : 1);'
}

# Read the secret from `pveum user token add ... --output-format json` on stdin:
#   {"full-tokenid":"pve1dash@pve!dashboard","info":{"privsep":1},"value":"<uuid>"}   (research §4.2)
# Exit 2: no JSON; 3: no usable "value"; 4: "full-tokenid" differs from $EXPECT_ID (when set).
parse_token_secret() {
  perl -MJSON -0777 -ne '
    /(\{.*\})/s or exit 2;
    my $d = eval { decode_json($1) };
    exit 2 unless ref $d eq "HASH";
    exit 4 if length($ENV{EXPECT_ID} // "") && ($d->{"full-tokenid"} // "") ne $ENV{EXPECT_ID};
    my $v = $d->{value} // "";
    exit 3 unless $v =~ /\A[A-Za-z0-9-]{8,128}\z/;
    print $v;'
}

# Create the token (privilege separated) and print its secret. The secret is shown only once by PVE.
create_token() {
  local out secret
  out=$(pveum user token add "$PVE_USER" "$TOKEN_NAME" --privsep 1 --comment 'pve1-dash' --output-format json 2>&1) ||
    die "pveum user token add failed: $out"
  secret=$(EXPECT_ID=$TOKEN_ID parse_token_secret <<<"$out") || die "could not read the token secret from: $out"
  printf '%s\n' "$secret"
}

# Remove the token. research §4.2 names the CLI verb "delete"; current pveum docs say "remove". Try both (UNVERIFIED
# which one is the alias on each version).
delete_token() {
  local out
  out=$(pveum user token remove "$PVE_USER" "$TOKEN_NAME" 2>&1) && return 0
  out=$(pveum user token delete "$PVE_USER" "$TOKEN_NAME" 2>&1) && return 0
  die "could not remove token $TOKEN_ID: $out"
}

grant_token_acl() { pveum acl modify / --tokens "$TOKEN_ID" --roles PVEAuditor >/dev/null; }

# Check a secret against the local API: 200 = good, 401 = bad secret, 403 = ACL missing (research §2.2, §3.1).
verify_token() {
  local node=$1 secret=$2 hdr code
  [[ $secret =~ ^[A-Za-z0-9-]{8,128}$ ]] || {
    printf '000\n'
    return 0
  }
  hdr=$(mktemp "${WORK_DIR:-/tmp}/hdr.XXXXXX")
  # The secret goes through a header file, never the command line (visible in ps).
  printf 'Authorization: PVEAPIToken=%s=%s\n' "$TOKEN_ID" "$secret" >"$hdr"
  code=$(curl -ksS -o /dev/null -w '%{http_code}' --max-time 15 -H @"$hdr" \
    "https://127.0.0.1:8006/api2/json/nodes/$node/status" 2>/dev/null) || code=000
  rm -f "$hdr"
  printf '%s\n' "$code"
}

# The secret the container holds, if it looks like one.
ct_token_secret() {
  local s
  s=$(ct_sh "$1" 'head -n 1 /etc/pve1-dash/token' 2>/dev/null) || return 1
  [[ $s =~ ^[A-Za-z0-9-]{8,128}$ ]] || return 1
  printf '%s\n' "$s"
}

check_new_secret() {
  local code
  code=$(verify_token "$NODE" "$1")
  case $code in
    200) ok 'token works against the local API' ;;
    401) die 'the new token was rejected (401). See docs/TROUBLESHOOTING.md "Token 401/403".' ;;
    403) die 'the token is valid but lacks Sys.Audit (403): the ACL did not apply. See docs/TROUBLESHOOTING.md.' ;;
    *) warn "could not test the token against https://127.0.0.1:8006 (HTTP $code); continuing" ;;
  esac
}

# Makes sure the user, the token and its ACL exist. Sets TOKEN_SECRET when lxc-setup must store a new secret, or
# ROTATE_LATE=yes to replace a token whose secret the container already holds. That replacement waits until the new
# version runs (rotate_token_late): a run that fails half-way never leaves the dashboard with a revoked secret.
setup_token() {
  local current='' code
  TOKEN_SECRET='' ROTATE_LATE=no
  if [[ $TOKEN_MANAGED == no ]]; then
    ok "the config uses $TOKEN_ID, which the installer does not manage: left alone"
    return 0
  fi
  ensure_pve_user
  if ! token_exists "$TOKEN_NAME"; then
    TOKEN_SECRET=$(create_token)
    ok "created token $TOKEN_ID (privilege separated)"
  else
    if [[ $MODE == update ]]; then current=$(ct_token_secret "$CTID") || current=''; fi
    if [[ -n $current ]]; then
      # Check the secret the container really has: a revoked one must not be kept just because the file exists.
      code=$(verify_token "$NODE" "$current")
      case $code in
        200)
          say "token $TOKEN_ID exists and the container's secret works."
          ask_yn PVE1_DASH_ROTATE_TOKEN 'Rotate it anyway (new secret)?' no
          ;;
        401)
          warn "Proxmox rejects the container's secret for $TOKEN_ID (401): it was revoked or replaced."
          ask_yn PVE1_DASH_ROTATE_TOKEN 'Replace it with a new token? (the dashboard cannot read Proxmox without it)' yes
          [[ $PVE1_DASH_ROTATE_TOKEN == yes ]] || warn 'keeping the rejected secret: the dashboard will show Proxmox as unreachable.'
          ;;
        *)
          warn "could not check the container's secret against https://127.0.0.1:8006 (HTTP $code)."
          ask_yn PVE1_DASH_ROTATE_TOKEN 'Rotate it anyway (new secret)?' no
          ;;
      esac
      if [[ $PVE1_DASH_ROTATE_TOKEN == yes ]]; then
        ROTATE_LATE=yes
        ok 'the token is replaced at the end, once the new version runs (the current secret works until then)'
      else
        ok "keeping token $TOKEN_ID"
      fi
    else
      say "token $TOKEN_ID exists, but its secret is shown only once and this container does not have it."
      ask_yn PVE1_DASH_ROTATE_TOKEN 'Replace it with a new token? (the old secret stops working)' yes
      [[ $PVE1_DASH_ROTATE_TOKEN == yes ]] || die "the dashboard needs the token secret. Re-run and allow the rotation, or remove the token in Datacenter → Permissions → API Tokens."
      delete_token
      TOKEN_SECRET=$(create_token)
      ok "token $TOKEN_ID rotated"
    fi
  fi
  # Removing a token does not delete its ACL, but PVE drops ACLs of missing tokens, so always (re)grant: idempotent.
  grant_token_acl
  ok 'PVEAuditor on / for the user and the token (read-only)'
  if [[ $PVE_MAJOR == 8 ]]; then
    say 'PVE 8: guest-agent API calls would need VM.Monitor, which also allows running commands in guests.'
    say 'pve1-dash does NOT ask for it; guest IPs come from the SSH helper instead (docs/SECURITY.md).'
  fi
  if [[ -n $TOKEN_SECRET ]]; then check_new_secret "$TOKEN_SECRET"; fi
}

# Write SECRET into the container's token file: a new file renamed over the old one, never a half-written file.
store_ct_secret() {
  # shellcheck disable=SC2016 # expanded by the shell in the container
  printf '%s\n' "$2" | ct_sh "$1" 'umask 077; f=/etc/pve1-dash/token; cat >"$f.new" && chown root:pve1dash "$f.new" && chmod 0640 "$f.new" && mv -f "$f.new" "$f"'
}

# Replace a token whose secret the container holds, in one short step after the setup succeeded: revoke, create,
# store the new secret in the container and restart the service (a few seconds without a valid secret).
rotate_token_late() {
  local ctid=$1 secret i
  delete_token
  secret=$(create_token)
  grant_token_acl
  for i in 1 2 3; do
    if store_ct_secret "$ctid" "$secret"; then break; fi
    if ((i == 3)); then
      die "token $TOKEN_ID was replaced, but the new secret could not be stored in container $ctid. Run the installer again: it sees the rejected secret and replaces the token once more."
    fi
    sleep 2
  done
  ok "token $TOKEN_ID rotated; container $ctid has the new secret"
  check_new_secret "$secret"
  ct_sh "$ctid" 'systemctl restart pve1-dash' || warn "could not restart pve1-dash in container $ctid; do it with: pct exec $ctid -- systemctl restart pve1-dash"
}

# ───────────────────────────────────────────────────────────────────────── TLS + SSH facts

# The certificate pveproxy serves: pveproxy-ssl.pem (custom/ACME) when it and its key exist, else pve-ssl.pem
# (research §9.1).
pve_cert_file() {
  local dir=${1:-/etc/pve/local}
  if [[ -f $dir/pveproxy-ssl.pem && -f $dir/pveproxy-ssl.key ]]; then
    printf '%s\n' "$dir/pveproxy-ssl.pem"
  else
    printf '%s\n' "$dir/pve-ssl.pem"
  fi
}

# Normalize openssl's "sha256 Fingerprint=ab:cd:..." (OpenSSL 3) or "SHA256 Fingerprint=AB:CD:..." (1.1) to the
# PVE UI format: uppercase hex pairs joined by ":" (research §9.3).
normalize_fingerprint() {
  local line fp
  IFS= read -r line || [[ -n $line ]] || return 1
  fp=${line#*=}
  fp=${fp//[[:space:]]/}
  fp=${fp^^}
  [[ $fp =~ ^([0-9A-F]{2}:){31}[0-9A-F]{2}$ ]] || return 1
  printf '%s\n' "$fp"
}

cert_fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null | normalize_fingerprint; }

# Fingerprint of the certificate actually served on :8006 (covers TLS_KEY_FILE overrides and not-yet-restarted
# pveproxy). Optional cross-check.
served_fingerprint() {
  timeout 10 openssl s_client -connect 127.0.0.1:8006 </dev/null 2>/dev/null |
    openssl x509 -noout -fingerprint -sha256 2>/dev/null | normalize_fingerprint
}

# Does the certificate on :8006 verify for NAME against the public CAs, as a browser checks it? Then the dashboard can
# check it the same way and needs no pin.
cert_trusted_for() {
  local out
  out=$(timeout 10 openssl s_client -connect 127.0.0.1:8006 -servername "$1" -verify_hostname "$1" \
    -verify_return_error -CAfile /etc/ssl/certs/ca-certificates.crt </dev/null 2>&1) || return 1
  grep -q 'Verify return code: 0 (ok)' <<<"$out"
}

# The first ACME domain in a node config file (/etc/pve/nodes/<node>/config), best effort: the entry formats
# "acmedomain0: <domain>[,plugin=...]", "acmedomain0: domain=<domain>,..." and "acme: domains=<a>;<b>" are UNVERIFIED,
# so callers check the certificate itself before relying on the name.
acme_domain() {
  [[ -r $1 ]] || return 1
  awk -F': *' '
    $1 ~ /^acmedomain[0-9]+$/ {
      n = split($2, kv, ",")
      for (i = 1; i <= n; i++) {
        if (kv[i] ~ /^domain=/) { print substr(kv[i], 8); exit }
        if (kv[i] !~ /=/) { print kv[i]; exit }
      }
    }
    $1 == "acme" && match($2, /domains=[^,;]+/) { print substr($2, RSTART + 8, RLENGTH - 8); exit }' "$1" | head -n 1 | grep .
}

# "ssh-ed25519 <base64>" of this host's ed25519 key (the ssh2 client negotiates ed25519 first; server-stack.md §4.1).
host_key_line() {
  local f=${1:-/etc/ssh/ssh_host_ed25519_key.pub} t k
  read -r t k _ <"$f" || [[ -n ${k-} ]] || return 1
  [[ $t == ssh-ed25519 && $k =~ ^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$ ]] || return 1
  printf '%s %s\n' "$t" "$k"
}

# The dashboard's public key comes from inside the container, so it is untrusted: accept exactly one
# "ssh-ed25519 <68 base64 chars> [comment]" line and print "ssh-ed25519 <base64>" (the comment is dropped).
# Every ed25519 key blob starts with the encoded "\0\0\0\x0bssh-ed25519\0\0\0\x20" header (AAAAC3NzaC1lZDI1NTE5AAAAI).
validate_pubkey() {
  local line=$1 t k
  [[ $line != *$'\n'* && $line != *$'\r'* && ${#line} -le 300 ]] || return 1
  read -r t k _ <<<"$line"
  [[ $t == ssh-ed25519 && ${k-} =~ ^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$ ]] || return 1
  printf '%s %s\n' "$t" "$k"
}

# ───────────────────────────────────────────────────────────────────────── authorized_keys

# The forced-command line: the key can only run the helper (no shell, PTY, forwarding or ~/.ssh/rc).
authorized_line() { printf 'restrict,command="%s" %s pve1-dash@ct%s\n' "$HELPER_PATH" "$1" "$2"; }

# Print FILE without the lines of container CTID (comment "pve1-dash@ct<CTID>") and without any other line carrying
# BLOB (e.g. an unrestricted copy of the key). Lines of other pve1-dash containers stay: the file is shared by the
# whole cluster (research §7.1), and every dashboard has its own line.
ak_filter() {
  local file=$1 blob=${2-} ctid=${3-}
  awk -v blob="$blob" -v me="pve1-dash@ct$ctid" '
    blob != "" && index($0, blob) { next }
    me != "pve1-dash@ct" && $NF == me { next }
    { print }' "$file"
}

# The options (everything before the key type) of container CTID's last line in FILE, when that line is a forced
# command for the helper: "restrict", our command="..." and whatever the admin added, such as from="192.168.1.60".
ak_prev_options() {
  local file=$1 ctid=$2 line opts rest
  [[ -f $file ]] || return 1
  line=$(awk -v me="pve1-dash@ct$ctid" '$NF == me { l = $0 } END { if (l != "") print l }' "$file") || return 1
  [[ $line == *' ssh-ed25519 '* ]] || return 1
  opts=${line%% ssh-ed25519 *}
  [[ $opts =~ (^|,)restrict(,|$) && $opts == *"command=\"$HELPER_PATH\""* ]] || return 1
  rest=${opts/"command=\"$HELPER_PATH\""/}
  [[ $rest != *command=* ]] || return 1
  printf '%s\n' "$opts"
}

# Replace FILE's content with that of NEW. A symlink is resolved and its target replaced, so
# /root/.ssh/authorized_keys stays a link to /etc/pve/priv/authorized_keys (never replace that link; research §7.1).
# A copy is written next to the target and renamed over it, so the file is never seen half-written. Should the rename
# fail (pmxcfs rename semantics are UNVERIFIED), the target is rewritten in place and read back.
ak_replace() {
  local file=$1 new=$2 target stage
  target=$(readlink -f -- "$file") || target=''
  [[ -n $target ]] || target=$file
  if stage=$(mktemp "$(dirname -- "$target")/.pve1-dash-ak.XXXXXX" 2>/dev/null); then
    if cat -- "$new" >"$stage" && cmp -s -- "$new" "$stage" && mv -f -- "$stage" "$target"; then return 0; fi
    rm -f -- "$stage"
  fi
  cat -- "$new" >"$target" && cmp -s -- "$new" "$target"
}

ak_fail() {
  rm -f -- "$1"
  printf 'authorized_keys: %s\n' "$2" >&2
}

# Install the forced-command line for KEY ("ssh-ed25519 <base64>") of container CTID into FILE, replacing that
# container's earlier line but keeping options the admin added to it (e.g. from="...").
# Returns 0 when FILE changed, 1 when it already had exactly this content, 2 on any error (FILE is then unchanged,
# unless the in-place fallback of ak_replace failed half-way; the caller keeps a backup). Callers use it in a
# condition, where errexit is off, so every step checks its own result; the new content is built next to FILE
# (/root/.ssh is on the root file system, unlike a possibly full tmpfs /tmp) and its line count is verified.
ak_install() {
  local file=$1 key=$2 ctid=$3 tmp line opts expect=0 got rc=0
  if opts=$(ak_prev_options "$file" "$ctid"); then line="$opts $key pve1-dash@ct$ctid"; else line=$(authorized_line "$key" "$ctid"); fi
  if ! tmp=$(mktemp "$(dirname -- "$file")/.pve1-dash-ak.XXXXXX" 2>/dev/null); then
    printf 'authorized_keys: cannot create a temporary file next to %s\n' "$file" >&2
    return 2
  fi
  if [[ -e $file ]]; then
    if ! ak_filter "$file" "${key#* }" "$ctid" >"$tmp"; then
      ak_fail "$tmp" "could not read $file or write $tmp (disk full?)"
      return 2
    fi
    if ! expect=$(ak_filter "$file" "${key#* }" "$ctid" | awk 'END { print NR }'); then
      ak_fail "$tmp" "could not read $file"
      return 2
    fi
  fi
  if ! printf '%s\n' "$line" >>"$tmp"; then
    ak_fail "$tmp" "could not write $tmp (disk full?)"
    return 2
  fi
  got=$(awk 'END { print NR }' "$tmp") || got=-1
  if [[ $got != "$((expect + 1))" || $(tail -n 1 "$tmp" 2>/dev/null) != "$line" ]]; then
    ak_fail "$tmp" "the new content came out incomplete ($got lines instead of $((expect + 1)); disk full?)"
    return 2
  fi
  if [[ -e $file ]]; then
    cmp -s -- "$tmp" "$file" || rc=$?
    if ((rc == 0)); then
      rm -f -- "$tmp"
      return 1
    fi
    if ((rc != 1)); then
      ak_fail "$tmp" "could not compare $tmp with $file"
      return 2
    fi
  fi
  if ! ak_replace "$file" "$tmp"; then
    ak_fail "$tmp" "could not write $file"
    return 2
  fi
  rm -f -- "$tmp"
  return 0
}

# Authorize KEY of container CTID in FILE, after a backup to FILE.pve1-dash.bak. Dies when FILE could not be updated.
authorize_key_file() {
  local file=$1 key=$2 ctid=$3 rc=0 opts others
  local bak=$file.pve1-dash.bak
  if [[ -e $file ]]; then cp -- "$file" "$bak" || die "could not back up $file to $bak; nothing changed."; fi
  opts=$(ak_prev_options "$file" "$ctid") || opts=''
  ak_install "$file" "$key" "$ctid" || rc=$?
  case $rc in
    0) ok "authorized the key of container $ctid for $HELPER_PATH only (backup: $bak)" ;;
    1) ok 'authorized_keys already up to date' ;;
    *) die "could not update $file (see above). If it looks wrong now, restore it with: cat $bak > $file" ;;
  esac
  if [[ -n $opts && $opts != "restrict,command=\"$HELPER_PATH\"" ]]; then
    ok "kept the options you added to the key line: $opts"
  fi
  others=$(awk -v me="pve1-dash@ct$ctid" '$NF ~ /^pve1-dash@ct[0-9]+$/ && $NF != me { print substr($NF, 11) }' "$file" 2>/dev/null | sort -u | tr '\n' ' ') || others=''
  if [[ -n ${others// /} ]]; then
    say "kept the key lines of other pve1-dash containers: ${others% } (uninstall.sh --ctid <id> removes one)"
  fi
}

# ───────────────────────────────────────────────────────────────────────── source

# "owner/repo" of a GitHub repository URL.
github_path() {
  local path
  case $1 in
    https://github.com/*) path=${1#https://github.com/} ;;
    git@github.com:*) path=${1#git@github.com:} ;;
    *) return 1 ;;
  esac
  path=${path%/}
  path=${path%.git}
  [[ $path =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  printf '%s\n' "$path"
}

# https://raw.githubusercontent.com/<owner>/<repo>/<ref> for a GitHub repo URL, or $PVE1_DASH_RAW_BASE.
raw_base() {
  if [[ -n ${PVE1_DASH_RAW_BASE-} ]]; then
    printf '%s\n' "${PVE1_DASH_RAW_BASE%/}"
    return 0
  fi
  local path
  path=$(github_path "$1") || return 1
  printf 'https://raw.githubusercontent.com/%s/%s\n' "$path" "$2"
}

# download_repo_file REL_PATH DEST: fetch a file of the source this install uses, at the resolved commit when known
# (a commit URL is immutable, while raw.githubusercontent.com caches branch URLs for minutes).
download_repo_file() {
  local base
  base=$(raw_base "$PVE1_DASH_REPO" "${REF_COMMIT:-$PVE1_DASH_REF}") || return 1
  curl -fsSL --retry 3 --max-time 60 -o "$2" "$base/$1"
}

# "<commit> <ref>" lines read from a git smart-HTTP ref advertisement on stdin (what `git ls-remote` reads), for
# branches and tags only (pull-request refs and the like are dropped).
parse_ref_advertisement() {
  LC_ALL=C perl -0777 -ne '
    my ($p, $s, $n) = (0, $_, 0);
    while ($p + 4 <= length $s) {
      my $h = substr($s, $p, 4);
      last unless $h =~ /\A[0-9a-f]{4}\z/;
      my $len = hex $h;
      $p += 4;
      next if $len == 0;
      last if $len < 4;
      my $line = substr($s, $p, $len - 4);
      $p += $len - 4;
      $line =~ s/\0.*//s;
      $line =~ s/\n\z//;
      if ($line =~ m{\A([0-9a-f]{40}) (refs/(?:heads|tags)/\S+)\z}) { print "$1 $2\n"; $n++ }
    }
    exit($n ? 0 : 1);'
}

# The branches and tags of a GitHub repository (git is not installed on Proxmox VE by default, so no git ls-remote).
remote_refs() {
  local path
  path=$(github_path "$1") || return 1
  curl -fsS --retry 2 --max-time 30 "https://github.com/$path.git/info/refs?service=git-upload-pack" | parse_ref_advertisement
}

# resolve_commit REPO REF: the commit of branch or tag REF of REPO (tags first, peeled, like git fetch). Exit 1 when
# REF is not one of REPO's branches or tags (pull-request refs, and commits that GitHub also serves for forks, never
# are), 2 when the list could not be read.
resolve_commit() {
  local refs
  refs=$(remote_refs "$1") || return 2
  awk -v ref="$2" '
    { have[$2] = $1 }
    END {
      if (ref ~ /^refs\/(heads|tags)\//) n = split(ref "^{} " ref, c, " ")
      else n = split("refs/tags/" ref "^{} refs/tags/" ref " refs/heads/" ref, c, " ")
      for (i = 1; i <= n; i++) if (c[i] in have) { print have[c[i]]; exit 0 }
      exit 1
    }' <<<"$refs"
}

# Pin PVE1_DASH_REF to one commit (REF_COMMIT) for GitHub repositories: the container checks out exactly that commit
# and the helper is compared with the file at that commit, even if the branch moves during the install.
resolve_source() {
  local rc=0
  REF_COMMIT=''
  if [[ $PVE1_DASH_REF =~ ^[0-9a-fA-F]{40}$ ]]; then
    REF_COMMIT=${PVE1_DASH_REF,,}
    return 0
  fi
  github_path "$PVE1_DASH_REPO" >/dev/null || return 0
  REF_COMMIT=$(resolve_commit "$PVE1_DASH_REPO" "$PVE1_DASH_REF") || rc=$?
  case $rc in
    0) ok "source $PVE1_DASH_REPO @ $PVE1_DASH_REF (commit ${REF_COMMIT:0:12})" ;;
    1) die "\"$PVE1_DASH_REF\" is not a branch or tag of $PVE1_DASH_REPO. For one commit, give its full 40-character id.$(premerge_hint)" ;;
    *)
      REF_COMMIT=''
      warn "could not list the branches of $PVE1_DASH_REPO; using \"$PVE1_DASH_REF\" as it is."
      ;;
  esac
}

premerge_hint() {
  if [[ $PVE1_DASH_REPO == "$DEFAULT_REPO" && $PVE1_DASH_REF != "$PREMERGE_REF" ]]; then
    printf ' Installing before pve1-dash is merged into main? Use PVE1_DASH_REF=%s (README.md shows the command).' "$PREMERGE_REF"
  fi
}

# Fail fast when the source is not pve1-dash: until the pve1-dash branch is merged, "main" still holds the old
# Tiny Ecowitt app.
check_source() {
  local pkg=$WORK_DIR/package.json
  download_repo_file package.json "$pkg" 2>/dev/null ||
    die "could not download package.json of $PVE1_DASH_REPO @ $PVE1_DASH_REF (a wrong ref, or a non-GitHub repository without PVE1_DASH_RAW_BASE?).$(premerge_hint)"
  grep -qE '^[[:space:]]*"name":[[:space:]]*"pve1-dash"' "$pkg" ||
    die "$PVE1_DASH_REPO @ $PVE1_DASH_REF is not pve1-dash (its package.json has another name).$(premerge_hint)"
}

# A value recorded in the container's /etc/pve1-dash/install.env (raw and untrusted: callers validate it).
ct_recorded() {
  local v
  v=$(ct_sh "$1" "sed -n 's/^$2=//p' /etc/pve1-dash/install.env" 2>/dev/null | head -n 1) || v=''
  v=${v//\'/}
  v=${v//\"/}
  printf '%s\n' "$v"
}

# A recorded ref that may be used, or nothing. Only branch and tag names qualify, and the caller still checks with
# resolve_commit that the repository in use has them: the container is less trusted than the host, and GitHub serves
# commits of forks and pull requests (pull/<n>/head) under the original repository's URLs too.
recorded_ref_candidate() {
  local ref=$1
  is_ref "$ref" || return 0
  if [[ $ref =~ ^[0-9a-fA-F]{7,40}$ || $ref =~ (^|/)(pull|merge-requests)/ ]]; then return 0; fi
  if [[ $ref == refs/* && $ref != refs/heads/* && $ref != refs/tags/* ]]; then return 0; fi
  printf '%s\n' "$ref"
}

ct_recorded_ref() { recorded_ref_candidate "$(ct_recorded "$1" PVE1_DASH_REF)"; }

# Upgrade and --update-helper: keep the source the container was installed from rather than silently switching it
# to the defaults. That source also decides which helper may run as root on this host, so a recorded repository is
# only used when the admin agrees, and a recorded ref only when it is a branch or tag of the repository in use.
adopt_recorded_source() {
  local ctid=$1 rrepo raw rref rc=0
  if [[ -z $REPO_EXPLICIT ]]; then
    rrepo=$(ct_recorded "$ctid" PVE1_DASH_REPO)
    if [[ -n $rrepo && $rrepo != "$PVE1_DASH_REPO" ]]; then
      if ! is_repo "$rrepo"; then
        warn "ignoring an invalid PVE1_DASH_REPO recorded in container $ctid"
      else
        warn "container $ctid was installed from $rrepo, not $PVE1_DASH_REPO."
        say 'That repository decides the code in the container and the helper that runs as root on this host.'
        if ((ASSUME_YES)) && [[ -z ${PVE1_DASH_USE_RECORDED_REPO-} ]]; then
          die "re-run with PVE1_DASH_REPO=$rrepo to keep it, or with PVE1_DASH_REPO=$PVE1_DASH_REPO to switch."
        fi
        ask_yn PVE1_DASH_USE_RECORDED_REPO "Keep using $rrepo?" no
        if [[ $PVE1_DASH_USE_RECORDED_REPO == yes ]]; then
          PVE1_DASH_REPO=$rrepo
        else
          warn "switching container $ctid to $PVE1_DASH_REPO"
        fi
      fi
    fi
  fi
  [[ -z $REF_EXPLICIT ]] || return 0
  raw=$(ct_recorded "$ctid" PVE1_DASH_REF)
  [[ -n $raw && $raw != "$PVE1_DASH_REF" ]] || return 0
  rref=$(recorded_ref_candidate "$raw")
  if [[ -z $rref ]]; then
    if is_ref "$raw"; then
      warn "container $ctid records PVE1_DASH_REF=$raw; only branch and tag names are taken over. Using \"$PVE1_DASH_REF\" (pass PVE1_DASH_REF=$raw to keep it)."
    else
      warn "ignoring an invalid PVE1_DASH_REF recorded in container $ctid"
    fi
    return 0
  fi
  resolve_commit "$PVE1_DASH_REPO" "$rref" >/dev/null || rc=$?
  if ((rc == 0)); then
    PVE1_DASH_REF=$rref
    ok "keeping the ref recorded in container $ctid: $rref"
  elif ((rc == 1)); then
    warn "container $ctid records ref \"$rref\", which is not a branch or tag of $PVE1_DASH_REPO; using \"$PVE1_DASH_REF\"."
  else
    warn "could not check the ref \"$rref\" recorded in container $ctid against $PVE1_DASH_REPO; using \"$PVE1_DASH_REF\" (pass PVE1_DASH_REF=$rref to keep it)."
  fi
}

# ───────────────────────────────────────────────────────────────────────── steps

preflight() {
  local major missing=() c
  [[ $EUID -eq 0 ]] || die 'please run this as root on the Proxmox VE host.'
  command -v pveversion >/dev/null 2>&1 || die 'pveversion not found: this must run on a Proxmox VE host (not inside a container or VM).'
  major=$(pve_major) || major=''
  case $major in
    8 | 9) ok "Proxmox VE $(pve_version) (major $major)" ;;
    '') die "could not read the version from: $(pveversion 2>&1 | head -n 1)" ;;
    *)
      if ((major < 8)); then die "Proxmox VE $major is not supported (8.x or 9.x needed)."; fi
      warn "Proxmox VE $major has not been tested (8.x and 9.x are)."
      ask_yn PVE1_DASH_CONTINUE_UNTESTED 'Continue anyway?' no
      [[ $PVE1_DASH_CONTINUE_UNTESTED == yes ]] || die 'stopped.'
      ;;
  esac
  PVE_MAJOR=$major
  for c in pct pveam pvesm pveum pvesh openssl curl perl awk sed sha256sum; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  ((${#missing[@]} == 0)) || die "missing commands: ${missing[*]}"
  perl -MJSON -e 1 2>/dev/null || die 'the Perl JSON module is missing (it ships with Proxmox VE).'
  NODE=$(node_name) || die 'could not read the host name.'
  [[ -d /etc/pve/nodes/$NODE ]] || die "/etc/pve/nodes/$NODE not found: is pmxcfs (pve-cluster) running, and is \"$NODE\" the node name?"
  ok "node $NODE"
  if [[ ${PVE1_DASH_SKIP_NETCHECK-} != 1 ]]; then
    for c in https://github.com https://nodejs.org/dist/ https://registry.npmjs.org/; do
      curl -fsS -o /dev/null --max-time 15 "$c" ||
        die "cannot reach $c. The container needs internet access for Debian packages, Node.js, GitHub and npm. (PVE1_DASH_SKIP_NETCHECK=1 skips this check.)"
    done
    ok 'internet reachable (GitHub, nodejs.org, npm)'
  fi
}

# What to do about an existing pve1-dash container: sets MODE=new|update and CTID.
choose_mode() {
  local existing=() ids
  ids=$(tagged_cts "$NODE") || ids=''
  if [[ -n $ids ]]; then mapfile -t existing <<<"$ids"; fi
  if [[ -n ${PVE1_DASH_CTID-} ]] && member "$PVE1_DASH_CTID" "${existing[@]}"; then
    MODE=update CTID=$PVE1_DASH_CTID
    ok "found the pve1-dash container $CTID: upgrading it in place (its config and data are kept)"
    return 0
  fi
  if ((${#existing[@]} == 0)) || [[ -n ${PVE1_DASH_CTID-} ]]; then
    MODE=new
    return 0
  fi
  say "Found a pve1-dash container on $NODE: ${existing[*]}"
  ask PVE1_DASH_EXISTING 'Upgrade/repair it in place ("update") or create another one ("new")?' update
  case $PVE1_DASH_EXISTING in
    update)
      MODE=update CTID=${existing[-1]}
      if ((${#existing[@]} > 1)); then warn "several found; using the newest, $CTID (use --ctid to pick another)"; fi
      ;;
    new)
      MODE=new
      say 'The existing dashboard keeps working: the new one gets its own API token and its own key line.'
      ;;
    *) die 'PVE1_DASH_EXISTING must be "update" or "new"' ;;
  esac
}

# Debian 13 unless this host's pve-container is too old for current Debian 13 templates (then 12, which works the
# same for pve1-dash), or the admin chose.
choose_debian() {
  local v
  [[ $PVE1_DASH_DEBIAN == 13 ]] || return 0
  # shellcheck disable=SC2016 # a dpkg-query format, not a shell variable
  v=$(dpkg-query -W -f='${Version}' pve-container 2>/dev/null) || v=''
  pve_container_too_old_for_13 "$v" "$PVE_MAJOR" || return 0
  if [[ -n $DEBIAN_EXPLICIT ]]; then
    warn "pve-container $v is too old for current Debian 13 templates; pct create will probably fail. Update the host first (docs/TROUBLESHOOTING.md \"unsupported debian version\")."
  else
    PVE1_DASH_DEBIAN=12
    DEBIAN_NOTE="pve-container $v is too old for Debian 13.1+ templates"
    warn "this host's pve-container ($v) is too old for current Debian 13 templates: using Debian 12, which works the same for pve1-dash."
  fi
}

# The bridge question: a bridge that does not exist on this host is refused unless the admin insists.
ask_bridge() {
  local preset=${PVE1_DASH_BRIDGE-}
  while :; do
    ask_valid PVE1_DASH_BRIDGE 'Network bridge' vmbr0 is_bridge 'a bridge name such as vmbr0'
    if bridge_exists "$PVE1_DASH_BRIDGE"; then return 0; fi
    warn "bridge $PVE1_DASH_BRIDGE does not exist on this host (see node → System → Network); the container would not start."
    ask_yn PVE1_DASH_BRIDGE_MISSING_OK "Use $PVE1_DASH_BRIDGE anyway?" no
    if [[ $PVE1_DASH_BRIDGE_MISSING_OK == yes ]]; then return 0; fi
    if [[ -n $preset ]] || ((ASSUME_YES)); then
      die "bridge $PVE1_DASH_BRIDGE does not exist. Pick an existing one with PVE1_DASH_BRIDGE (e.g. vmbr0), or set PVE1_DASH_BRIDGE_MISSING_OK=yes."
    fi
    PVE1_DASH_BRIDGE='' PVE1_DASH_BRIDGE_MISSING_OK=''
  done
}

# The gateway for the static address PVE1_DASH_IP. This host's own gateway is offered only when it lies inside that
# network: with another VLAN or bridge it usually doesn't, and the container would be offline.
ask_gateway() {
  local def='' host_gw
  host_gw=$(default_gateway) || host_gw=''
  if [[ -n $host_gw ]] && ip_in_cidr "$host_gw" "$PVE1_DASH_IP"; then def=$host_gw; fi
  if [[ -z $def && -z ${PVE1_DASH_GATEWAY-} ]] && ((ASSUME_YES)); then
    die "PVE1_DASH_GATEWAY is required for the static address $PVE1_DASH_IP (this host's gateway${host_gw:+ $host_gw} is not in that network)."
  fi
  ask_valid PVE1_DASH_GATEWAY "Gateway (the router of the network of $PVE1_DASH_IP)" "$def" is_ipv4 'an IPv4 address'
  if ! ip_in_cidr "$PVE1_DASH_GATEWAY" "$PVE1_DASH_IP"; then
    warn "gateway $PVE1_DASH_GATEWAY is not inside $PVE1_DASH_IP; the container may not reach it."
  fi
}

ask_new_ct_settings() {
  local next out def
  local -a storages=() tstorages=()
  choose_debian
  next=$(next_ctid) || next=''
  ask_valid PVE1_DASH_CTID 'Container ID' "$next" is_ctid 'a number from 100 to 999999999'
  ctid_free "$PVE1_DASH_CTID" || die "ID $PVE1_DASH_CTID is already used by a VM or container (pick another, e.g. $next)."
  ask_valid PVE1_DASH_HOSTNAME 'Hostname' pve1-dash is_hostname 'letters, digits and dashes (max 63)'

  out=$(list_storages rootdir) || out=''
  [[ -n $out ]] || die 'no active storage allows container disks (content "rootdir"). Check Datacenter → Storage.'
  mapfile -t storages <<<"$out"
  def=$(pick_default 'local-lvm local-zfs' <<<"$out")
  say "Storages for the container disk: ${storages[*]}"
  ask_valid PVE1_DASH_STORAGE 'Disk storage' "$def" is_storage_id 'a storage id from the list'
  member "$PVE1_DASH_STORAGE" "${storages[@]}" || die "storage \"$PVE1_DASH_STORAGE\" is not active or does not allow container disks."
  ask_valid PVE1_DASH_DISK 'Disk size (GiB)' 6 is_disk_gb 'a whole number, at least 4'

  out=$(list_storages vztmpl) || out=''
  [[ -n $out ]] || die 'no active storage allows container templates (content "vztmpl"), e.g. enable it on "local".'
  mapfile -t tstorages <<<"$out"
  def=$(pick_default 'local' <<<"$out")
  say "Storages for templates: ${tstorages[*]}"
  ask_valid PVE1_DASH_TEMPLATE_STORAGE 'Template storage' "$def" is_storage_id 'a storage id from the list'
  member "$PVE1_DASH_TEMPLATE_STORAGE" "${tstorages[@]}" || die "storage \"$PVE1_DASH_TEMPLATE_STORAGE\" is not active or does not allow templates."

  ask_bridge
  ask_valid PVE1_DASH_VLAN 'VLAN tag (empty for none)' '' is_vlan 'empty, or 1-4094'
  ask_valid PVE1_DASH_IP 'IPv4: "dhcp" or a static address like 192.168.1.60/24' dhcp is_ip_setting 'dhcp, or an IPv4 address with /prefix'
  if [[ $PVE1_DASH_IP != dhcp ]]; then
    ask_gateway
  else
    PVE1_DASH_GATEWAY=''
  fi
  ask_valid PVE1_DASH_CORES 'CPU cores' 1 is_cores 'a whole number, at least 1'
  ask_valid PVE1_DASH_MEMORY 'Memory (MiB; 1024 recommended, the build needs it)' 1024 is_memory 'a whole number of MiB, at least 512'
  ask_valid PVE1_DASH_SWAP 'Swap (MiB)' 512 is_swap 'a whole number of MiB'
}

# Upgrade mode: network settings given as PVE1_DASH_BRIDGE/VLAN/IP/GATEWAY are applied to the existing container
# (so a re-run can fix a container that got no address). Sets NET0_NEW when its net0 changes.
plan_network_change() {
  local -a kv=()
  NET0_NEW=''
  [[ -n ${PVE1_DASH_BRIDGE-}${PVE1_DASH_VLAN+x}${PVE1_DASH_IP-}${PVE1_DASH_GATEWAY-} ]] || return 0
  NET0_CURRENT=$(ct_net0 "$CTID") || die "could not read the network settings (net0) of container $CTID"
  if [[ -n ${PVE1_DASH_BRIDGE-} ]]; then
    ask_bridge
    kv+=("bridge=$PVE1_DASH_BRIDGE")
  fi
  if [[ -n ${PVE1_DASH_VLAN+x} ]]; then
    is_vlan "$PVE1_DASH_VLAN" || die "PVE1_DASH_VLAN=\"$PVE1_DASH_VLAN\": empty, or 1-4094"
    kv+=("tag=$PVE1_DASH_VLAN")
  fi
  if [[ -n ${PVE1_DASH_IP-} ]]; then
    is_ip_setting "$PVE1_DASH_IP" || die "PVE1_DASH_IP=\"$PVE1_DASH_IP\": dhcp, or an IPv4 address with /prefix"
    kv+=("ip=$PVE1_DASH_IP")
    if [[ $PVE1_DASH_IP == dhcp ]]; then
      kv+=("gw=")
    else
      ask_gateway
      kv+=("gw=$PVE1_DASH_GATEWAY")
    fi
  elif [[ -n ${PVE1_DASH_GATEWAY-} ]]; then
    is_ipv4 "$PVE1_DASH_GATEWAY" || die "PVE1_DASH_GATEWAY=\"$PVE1_DASH_GATEWAY\": an IPv4 address"
    kv+=("gw=$PVE1_DASH_GATEWAY")
  fi
  NET0_NEW=$(net0_merge "$NET0_CURRENT" "${kv[@]}")
  if [[ $NET0_NEW == "$NET0_CURRENT" ]]; then NET0_NEW=''; fi
}

# pct set --net0 on a running container is applied live; a restart makes DHCP and routes start clean.
apply_network_change() {
  say "changing the network of container $CTID: $NET0_NEW"
  logged pct set "$CTID" --net0 "$NET0_NEW" >/dev/null || die "pct set --net0 failed (see $INSTALL_LOG)."
  if [[ $(ct_status "$CTID") == running ]]; then pct stop "$CTID" >/dev/null 2>&1 || :; fi
  ensure_running "$CTID" || die "container $CTID does not start with the new network settings ($NET0_NEW)."
  ok "container $CTID restarted with the new network settings"
}

ask_common_settings() {
  local detected need_config=$1
  detected=$(detect_node_ip) || detected=''
  ask_valid PVE1_DASH_NODE_IP "IP of this Proxmox host (the dashboard connects to https://<ip>:8006 and ssh)" "$detected" is_ipv4 'an IPv4 address of this host'
  if [[ $need_config == yes ]]; then
    say 'The public URL is where you will open the dashboard through your HTTPS reverse proxy (needed for iPhone push).'
    ask_valid PVE1_DASH_PUBLIC_URL 'Public HTTPS URL (empty if you have none yet)' '' is_public_url 'an https:// URL such as https://dash.home.lan, or empty'
    say 'Web Push needs a contact address. Use your real email: Apple rejects localhost and made-up domains.'
    if ((ASSUME_YES)) && [[ -z ${PVE1_DASH_VAPID_EMAIL-} ]]; then die 'PVE1_DASH_VAPID_EMAIL is required with --yes.'; fi
    ask_valid PVE1_DASH_VAPID_EMAIL 'Your email for Web Push (VAPID contact)' '' is_vapid_email 'a real email address (not localhost, .lan, .local, .test, ...)'
  fi
  say 'Temperatures: the dashboard can show CPU/board temperatures if lm-sensors is installed on this host.'
  say 'That is one Debian package (apt install lm-sensors); the helper then only runs "sensors -j". Skip it if unsure.'
  ask_yn PVE1_DASH_SENSORS 'Install lm-sensors on this host?' no
}

print_plan() {
  printf '\n%s  Plan%s\n' "$C_B" "$C_0"
  if [[ $MODE == new ]]; then
    say "Container       $PVE1_DASH_CTID ($PVE1_DASH_HOSTNAME), unprivileged Debian $PVE1_DASH_DEBIAN${DEBIAN_NOTE:+ ($DEBIAN_NOTE)}, tag $CT_TAG, starts on boot"
    say "Resources       $PVE1_DASH_CORES core(s), $PVE1_DASH_MEMORY MiB RAM, $PVE1_DASH_SWAP MiB swap, ${PVE1_DASH_DISK} GiB on $PVE1_DASH_STORAGE"
    say "Network         $PVE1_DASH_BRIDGE${PVE1_DASH_VLAN:+ (VLAN $PVE1_DASH_VLAN)}, ip=$PVE1_DASH_IP${PVE1_DASH_GATEWAY:+ gw=$PVE1_DASH_GATEWAY}"
  else
    say "Container       $CTID (existing; upgraded in place, config and data kept)"
    if [[ -n $NET0_NEW ]]; then say "Network         $NET0_CURRENT  →  $NET0_NEW (container restarts)"; fi
  fi
  say "Proxmox host    $NODE at $PVE1_DASH_NODE_IP"
  [[ -n ${PVE1_DASH_PUBLIC_URL-} ]] && say "Public URL      $PVE1_DASH_PUBLIC_URL"
  [[ -n ${PVE1_DASH_VAPID_EMAIL-} ]] && say "Push contact    mailto:$PVE1_DASH_VAPID_EMAIL"
  if [[ $TOKEN_MANAGED == yes ]]; then
    say "API token       $TOKEN_ID (PVEAuditor on /, read-only)"
  else
    say "API token       $TOKEN_ID (from the existing config; not managed by the installer)"
  fi
  say "Host helper     $HELPER_PATH + one forced-command line in $AUTHORIZED_KEYS"
  say "lm-sensors      $PVE1_DASH_SENSORS"
  say "Source          $PVE1_DASH_REPO @ $PVE1_DASH_REF${REF_COMMIT:+ (${REF_COMMIT:0:12})}"
}

ensure_template() {
  local arch tmpl
  arch=$(host_arch)
  if refresh_template_index; then ok 'template index updated'; fi
  tmpl=$(newest_template "$PVE1_DASH_DEBIAN" "$arch") || tmpl=''
  if [[ -z $tmpl && $PVE1_DASH_DEBIAN == 13 ]]; then
    # Whether the PVE 8 index lists Debian 13 is UNVERIFIED (research §5.6); Debian 12 works the same for us.
    tmpl=$(newest_template 12 "$arch") || tmpl=''
    [[ -n $tmpl ]] && warn "no Debian 13 template in the index; using $tmpl"
  fi
  if [[ -z $tmpl ]]; then
    tmpl=$(newest_local_template "$PVE1_DASH_TEMPLATE_STORAGE" "$PVE1_DASH_DEBIAN" "$arch") || tmpl=''
    [[ -n $tmpl ]] || die "no debian-$PVE1_DASH_DEBIAN-standard template for $arch in the index or on $PVE1_DASH_TEMPLATE_STORAGE. Try \"pveam update\" and check /var/log/pveam.log."
    warn "using the already downloaded $tmpl"
  fi
  if template_present "$PVE1_DASH_TEMPLATE_STORAGE" "$tmpl"; then
    ok "template $tmpl is on $PVE1_DASH_TEMPLATE_STORAGE"
  else
    say "downloading $tmpl to $PVE1_DASH_TEMPLATE_STORAGE ..."
    # The exit status of pveam download may be 0 on failure (research §5.6, UNVERIFIED), so check with pveam list.
    logged pveam download "$PVE1_DASH_TEMPLATE_STORAGE" "$tmpl" >/dev/null || :
    template_present "$PVE1_DASH_TEMPLATE_STORAGE" "$tmpl" || die "download of $tmpl failed (see $INSTALL_LOG)."
    ok "downloaded $tmpl"
  fi
  TEMPLATE=$tmpl
}

# The net0 property string for pct create (research §5.5: name, bridge, ip, gw, tag).
net0_value() {
  local bridge=$1 ip=$2 gw=${3-} vlan=${4-} v
  v="name=eth0,bridge=$bridge,ip=$ip"
  if [[ $ip != dhcp && -n $gw ]]; then v+=",gw=$gw"; fi
  if [[ -n $vlan ]]; then v+=",tag=$vlan"; fi
  printf '%s\n' "$v"
}

pct_create() {
  # --unprivileged 1 is explicit because PVE 8 defaults to privileged containers (research §5.5). No --password:
  # root has no password, use "pct enter <id>" from the host.
  logged pct create "$PVE1_DASH_CTID" "$PVE1_DASH_TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
    --hostname "$PVE1_DASH_HOSTNAME" \
    --cores "$PVE1_DASH_CORES" --memory "$PVE1_DASH_MEMORY" --swap "$PVE1_DASH_SWAP" \
    --rootfs "$PVE1_DASH_STORAGE:$PVE1_DASH_DISK" \
    --net0 "$1" \
    --unprivileged 1 --features nesting=1 \
    --onboot 1 --start 1 --ostype debian \
    --tags "$CT_TAG" \
    --description 'pve1-dash: read-only homelab dashboard. Update inside with pve1-dash-update.'
}

create_ct() {
  local net0 out=$WORK_DIR/pct-create.log
  net0=$(net0_value "$PVE1_DASH_BRIDGE" "$PVE1_DASH_IP" "$PVE1_DASH_GATEWAY" "$PVE1_DASH_VLAN")
  say "creating container $PVE1_DASH_CTID ..."
  if ! pct_create "$net0" >"$out"; then
    if grep -q 'unsupported debian version' "$out"; then
      if [[ $PVE1_DASH_DEBIAN == 13 ]] && ctid_free "$PVE1_DASH_CTID"; then
        warn "this host's pve-container is too old for $TEMPLATE; retrying with Debian 12 (works the same for pve1-dash)."
        PVE1_DASH_DEBIAN=12
        ensure_template
        pct_create "$net0" >"$out" || die "pct create failed (see $INSTALL_LOG)."
      else
        die "this host's pve-container is too old for this Debian template. Update the host (without a subscription, enable the pve-no-subscription repository first: node → Updates → Repositories), or re-run with PVE1_DASH_DEBIAN=12."
      fi
    else
      die "pct create failed (see $INSTALL_LOG)."
    fi
  fi
  CTID=$PVE1_DASH_CTID
  CT_TOUCHED=$CTID
  ensure_started_after_create
}

# `pct create --start 1` can exit 0 although the start failed (the start runs as its own task, whose failure is not
# passed on), e.g. with a missing bridge. Check, and show the start error.
ensure_started_after_create() {
  local i st='' out
  for ((i = 0; i < 10; i++)); do
    st=$(ct_status "$CTID") || st=''
    [[ $st == running ]] && break
    sleep 1
  done
  if [[ $st != running ]]; then
    warn "container $CTID was created but is not running (status: ${st:-unknown}); starting it to see why ..."
    if ! out=$(pct start "$CTID" 2>&1); then
      die "container $CTID was created but does not start: ${out:-no output}. Check the bridge ($PVE1_DASH_BRIDGE)${PVE1_DASH_VLAN:+ and VLAN $PVE1_DASH_VLAN}, then re-run with corrected PVE1_DASH_BRIDGE/PVE1_DASH_VLAN/PVE1_DASH_IP: they are applied to this container."
    fi
  fi
  ok "container $CTID created and started"
}

# A custom or ACME certificate (pveproxy-ssl.pem) changes at every renewal, and a pin on it breaks then. For a new
# config, offer to verify it like a browser instead (public CAs + host name), after checking that this works.
consider_public_ca() {
  local def=''
  warn 'this host serves a custom or ACME certificate (pveproxy-ssl.pem): a pin on it breaks at every renewal (Let'"'"'s Encrypt: every 60-90 days).'
  if [[ $NEED_CONFIG != yes ]]; then
    say 'The existing config is kept. To stop pinning, see docs/TROUBLESHOOTING.md "TLS fingerprint mismatch", step 3.'
    return 0
  fi
  def=$(acme_domain "/etc/pve/nodes/$NODE/config") || def=''
  is_dns_name "${def:-x}" || def=''
  say 'If it is publicly trusted (ACME), the dashboard can check it like a browser does instead, with nothing to renew.'
  ask_valid PVE1_DASH_PVE_HOST 'Host name on the certificate (empty: pin the certificate)' "$def" is_dns_name_or_empty 'a host name such as pve1.example.com, or empty'
  if [[ -z $PVE1_DASH_PVE_HOST ]]; then
    say 'pinning it; docs/TROUBLESHOOTING.md "TLS fingerprint mismatch" covers the renewal.'
  elif ! cert_trusted_for "$PVE1_DASH_PVE_HOST"; then
    warn "the certificate on :8006 does not verify for $PVE1_DASH_PVE_HOST with the public CAs; pinning it instead."
  elif ! ct_resolves_to "$CTID" "$PVE1_DASH_PVE_HOST" "$PVE1_DASH_NODE_IP"; then
    warn "$PVE1_DASH_PVE_HOST does not resolve to $PVE1_DASH_NODE_IP inside the container (add it to your local DNS); pinning the certificate instead."
  else
    PVE_HOST=$PVE1_DASH_PVE_HOST
    ok "no pin: the dashboard checks https://$PVE_HOST:8006 with the public CAs, which survives renewals"
  fi
}

collect_host_facts() {
  local cert served
  cert=$(pve_cert_file /etc/pve/local)
  TLS_FINGERPRINT=$(cert_fingerprint "$cert") || die "could not read the SHA-256 fingerprint of $cert"
  served=$(served_fingerprint) || served=''
  if [[ -n $served && $served != "$TLS_FINGERPRINT" ]]; then
    warn "pveproxy serves a different certificate than $cert; pinning the served one ($served)"
    TLS_FINGERPRINT=$served
  fi
  ok "TLS pin ${TLS_FINGERPRINT:0:23}… ($(basename "$cert"))"
  if [[ $cert == */pveproxy-ssl.pem ]]; then consider_public_ca; fi
  HOST_KEY=$(host_key_line /etc/ssh/ssh_host_ed25519_key.pub) || die '/etc/ssh/ssh_host_ed25519_key.pub is missing or not an ed25519 key.'
  ok 'host SSH key (ed25519) read for pinning'
}

# The host's IANA time zone (e.g. "Europe/Berlin"), so alert texts show local clock times. Containers default to UTC.
# Prints nothing when it can't be determined; the dashboard then falls back to the container's zone.
host_timezone() {
  local tz=''
  tz=$(timedatectl show -p Timezone --value 2>/dev/null) || tz=''
  [[ -n $tz ]] || { [[ -r /etc/timezone ]] && tz=$(head -n1 /etc/timezone); } || :
  if [[ -z $tz && -L /etc/localtime ]]; then
    tz=$(readlink /etc/localtime) || tz=''
    tz=${tz##*/zoneinfo/}
  fi
  [[ $tz =~ ^[A-Za-z][A-Za-z0-9_+./-]{0,63}$ && $tz != *..* ]] && printf '%s\n' "$tz"
  return 0
}

run_lxc_setup() {
  local ctid=$1 script=$WORK_DIR/lxc-setup.sh env=$WORK_DIR/setup.env
  download_repo_file deploy/lxc-setup.sh "$script" ||
    die "could not download deploy/lxc-setup.sh for $PVE1_DASH_REPO @ $PVE1_DASH_REF (set PVE1_DASH_RAW_BASE for non-GitHub repos)."
  bash -n "$script" || die 'the downloaded lxc-setup.sh is not a valid bash script.'
  (
    umask 077
    export P1D_CTID=$ctid P1D_NODE=$NODE P1D_NODE_IP=$PVE1_DASH_NODE_IP P1D_TLS_FINGERPRINT=$TLS_FINGERPRINT
    export P1D_PUBLIC_URL=${PVE1_DASH_PUBLIC_URL-} P1D_VAPID_EMAIL=${PVE1_DASH_VAPID_EMAIL-} P1D_HOST_KEY=$HOST_KEY
    export P1D_TOKEN_ID=$TOKEN_ID P1D_TOKEN_SECRET=${TOKEN_SECRET-} P1D_COMMIT=$REF_COMMIT P1D_PVE_HOST=$PVE_HOST
    P1D_NODE_IPS=$(host_ipv4s) || P1D_NODE_IPS=''
    P1D_TIMEZONE=${PVE1_DASH_TIMEZONE:-$(host_timezone)}
    export P1D_NODE_IPS P1D_TIMEZONE
    write_setup_env >"$env"
  )
  # pct push/pull are not covered by the research notes (UNVERIFIED flags); only the basic form is used.
  pct push "$ctid" "$script" /root/pve1-dash-lxc-setup.sh
  # The settings (with the token secret) go over stdin into a 0600 file, never onto a command line.
  ct_sh "$ctid" 'umask 077; cat > /root/pve1-dash-setup.env' <"$env"
  rm -f "$env"
  logged pct exec "$ctid" -- env -i PATH="$CT_PATH" HOME=/root LANG=C.UTF-8 TERM=dumb \
    bash /root/pve1-dash-lxc-setup.sh /root/pve1-dash-setup.env ||
    die "the setup inside container $ctid failed (see the output above and $INSTALL_LOG)."
  ct_sh "$ctid" 'rm -f /root/pve1-dash-lxc-setup.sh /root/pve1-dash-setup.env' || :
}

# KEY=value lines in bash syntax for lxc-setup.sh (printf %q quoting, read back by bash with "source").
write_setup_env() {
  local k
  for k in PVE1_DASH_REPO PVE1_DASH_REF P1D_CTID P1D_NODE P1D_NODE_IP P1D_TLS_FINGERPRINT P1D_PUBLIC_URL \
    P1D_VAPID_EMAIL P1D_HOST_KEY P1D_TOKEN_ID P1D_TOKEN_SECRET P1D_COMMIT P1D_PVE_HOST P1D_NODE_IPS P1D_TIMEZONE; do
    printf '%s=%q\n' "$k" "${!k-}"
  done
}

# Show text that comes from the container safely: every byte outside printable ASCII (terminal escape sequences,
# bidi controls, ...) is printed as \xNN, so it can neither redraw the screen nor hide lines.
sanitize() { LC_ALL=C perl -pe 's/([^\x20-\x7E\t\n])/sprintf("\\x%02X", ord $1)/ge'; }

file_sha256() { sha256sum "$1" | cut -d ' ' -f 1; }

# show_helper_diff REPO_COPY CONTAINER_COPY OUT: checksums, the first lines of the sanitized diff, and the whole diff
# in OUT (the admin decides whether a root script from the container may run on this host).
show_helper_diff() {
  local repo=$1 ct=$2 out=$3 lines=0
  say "repo copy:      sha256 $(file_sha256 "$repo")"
  say "container copy: sha256 $(file_sha256 "$ct")"
  (
    umask 077
    diff -u "$repo" "$ct" | sanitize >"$out"
  ) || :
  lines=$(wc -l <"$out" 2>/dev/null) || lines=0
  head -n 60 "$out" >&2 2>/dev/null || :
  if ((lines > 60)); then say "... $((lines - 60)) more lines. Read the whole diff before you answer: less $out"; fi
  say "(bytes outside printable ASCII are shown as \\xNN; the whole diff is in $out)"
}

# Install the host helper from the container (pct pull), cross-checked against the same file in the repo at
# PVE1_DASH_REF (at its resolved commit): the container is less trusted than the host, and this script runs as root
# via SSH.
install_host_helper() {
  local ctid=$1 pulled=$WORK_DIR/helper.ct ref_copy=$WORK_DIR/helper.repo out at
  at="$PVE1_DASH_REF${REF_COMMIT:+ (${REF_COMMIT:0:12})}"
  pct pull "$ctid" /opt/pve1-dash/deploy/helpers/pve1-dash-helper "$pulled" ||
    die "could not copy /opt/pve1-dash/deploy/helpers/pve1-dash-helper out of container $ctid."
  if [[ $(head -c 11 "$pulled") != '#!/bin/bash' ]] || ! bash -n "$pulled"; then
    die 'the helper from the container is not a valid bash script.'
  fi
  if download_repo_file deploy/helpers/pve1-dash-helper "$ref_copy"; then
    if cmp -s "$pulled" "$ref_copy"; then
      ok "helper matches $PVE1_DASH_REPO @ $at"
    else
      warn "the container's helper differs from the copy in $PVE1_DASH_REPO @ $at."
      show_helper_diff "$ref_copy" "$pulled" "$HELPER_DIFF"
      warn 'If the container runs another ref on purpose, re-run with PVE1_DASH_REF=<that ref>.'
      ask_yn PVE1_DASH_TRUST_CT_HELPER "Install the container's version anyway (it runs as root on this host)?" no
      [[ $PVE1_DASH_TRUST_CT_HELPER == yes ]] || die 'helper not installed.'
    fi
  else
    warn "could not download the repo copy of the helper to cross-check it"
    ask_yn PVE1_DASH_TRUST_CT_HELPER "Install the container's version without the cross-check (it runs as root on this host)?" no
    [[ $PVE1_DASH_TRUST_CT_HELPER == yes ]] || die 'helper not installed.'
  fi
  if [[ -f $HELPER_PATH ]] && cmp -s "$pulled" "$HELPER_PATH"; then
    ok "$HELPER_PATH is up to date"
  else
    install -o root -g root -m 0755 "$pulled" "$HELPER_PATH.new"
    mv -f "$HELPER_PATH.new" "$HELPER_PATH"
    ok "installed $HELPER_PATH"
  fi
  out=$(SSH_ORIGINAL_COMMAND=version "$HELPER_PATH" 2>&1 </dev/null) || out=''
  if [[ $out == *'pve1-dash-helper '* ]]; then ok "helper self-test: ${out##*$'\n'}"; else warn "helper self-test printed: $(sanitize <<<"${out:-nothing}")"; fi
}

authorize_dashboard_key() {
  local ctid=$1 pub key
  pub=$(ct_sh "$ctid" 'cat /etc/pve1-dash/ssh/id_ed25519.pub') || die "container $ctid has no /etc/pve1-dash/ssh/id_ed25519.pub"
  key=$(validate_pubkey "$pub") || die "the dashboard public key in container $ctid is malformed; refusing to authorize it."
  if [[ ! -d /root/.ssh ]]; then install -d -m 0700 /root/.ssh; fi
  if [[ -L $AUTHORIZED_KEYS ]]; then
    say "$AUTHORIZED_KEYS links to $(readlink "$AUTHORIZED_KEYS") (shared by all cluster nodes)"
  fi
  authorize_key_file "$AUTHORIZED_KEYS" "$key" "$ctid"
  check_sshd_root_login
}

# Forced-command keys for root need PermitRootLogin yes, prohibit-password or forced-commands-only (research §7.2).
check_sshd_root_login() {
  local v
  v=$(sshd -T 2>/dev/null | awk 'tolower($1) == "permitrootlogin" { print tolower($2); exit }') || v=''
  case $v in
    yes | prohibit-password | without-password | forced-commands-only) ok "sshd allows key logins for root (PermitRootLogin $v)" ;;
    no) warn 'sshd has "PermitRootLogin no": the helper key cannot log in. Set "PermitRootLogin forced-commands-only" (docs/TROUBLESHOOTING.md).' ;;
    *) warn 'could not read PermitRootLogin (sshd -T); make sure root may log in with keys.' ;;
  esac
}

install_sensors() {
  if command -v sensors >/dev/null 2>&1; then
    ok 'lm-sensors is already installed'
    return 0
  fi
  if ! DEBIAN_FRONTEND=noninteractive logged apt-get install -y lm-sensors >/dev/null; then
    say 'refreshing package lists and retrying ...'
    DEBIAN_FRONTEND=noninteractive logged apt-get update >/dev/null || warn 'apt-get update reported errors (enterprise repo without subscription?)'
    if ! DEBIAN_FRONTEND=noninteractive logged apt-get install -y lm-sensors >/dev/null; then
      warn 'could not install lm-sensors; install it later with "apt install lm-sensors". Temperatures stay hidden until then.'
      return 0
    fi
  fi
  ok 'installed lm-sensors'
  say 'Tip: run "sensors-detect" once to find more chips (the defaults are safe), then "sensors" to check.'
}

# "<address> <port>" to reach the dashboard from this host: listen.host / listen.port from the container's config
# (read by the installed pve1-dash-update), the container's address for a wildcard listen address.
dashboard_endpoint() {
  local ctid=$1 ct_ip=$2 out host='' port=''
  out=$(pct exec "$ctid" -- env -i PATH="$CT_PATH" HOME=/root LANG=C.UTF-8 \
    bash -c 'source /usr/local/bin/pve1-dash-update && listen_endpoint' 2>/dev/null | tail -n 1) || out=''
  read -r host port _ <<<"$out" || :
  [[ $port =~ ^[0-9]{1,5}$ ]] || port=$DEFAULT_LISTEN_PORT
  [[ $host =~ ^[A-Za-z0-9.:_-]{1,253}$ ]] || host=0.0.0.0
  case $host in
    0.0.0.0 | '::' | '[::]') host=$ct_ip ;;
  esac
  printf '%s %s\n' "$host" "$port"
}

# http://HOST:PORT (IPv6 literals in brackets).
http_base() {
  local host=$1
  if [[ $host == *:* && $host != \[* ]]; then host="[$host]"; fi
  printf 'http://%s:%s\n' "$host" "$2"
}

# Reads /api/snapshot (JSON) on stdin: "error <collector>: <message>" when a collector only failed so far with an
# authentication, permission or TLS error, "ok <collectors>" once one succeeded, nothing (exit 1) before the first poll.
collector_summary() {
  perl -MJSON -0777 -ne '
    my $d = eval { decode_json($_) } or exit 1;
    my @c = grep { ref $_ eq "HASH" } @{ (ref $d->{meta} eq "HASH" && ref $d->{meta}{collectors} eq "ARRAY") ? $d->{meta}{collectors} : [] };
    my @bad = grep { $_->{lastError} && !$_->{lastSuccess} && $_->{lastError} =~ /\b40[13]\b|fingerprint|certificate|TLS/i } @c;
    if (@bad) {
      (my $m = "$bad[0]{name}: $bad[0]{lastError}") =~ s/[^\x20-\x7E]/?/g;
      print "error ", substr($m, 0, 300), "\n";
      exit 0;
    }
    my @good = map { $_->{name} } grep { $_->{lastSuccess} } @c;
    exit 1 unless @good;
    $#good = 3 if @good > 4;
    print "ok ", join(", ", @good), "\n";'
}

# healthz of the dashboard (from the host), its first Proxmox poll, and the SSH helper round trip (from the container,
# as the service user).
smoke_test() {
  local ctid=$1 base=$2 i out healthy=no
  for ((i = 0; i < 30; i++)); do
    if out=$(curl -fsS --max-time 3 "$base/healthz" 2>/dev/null) && [[ $out == *'"ok":true'* ]]; then
      healthy=yes
      break
    fi
    sleep 2
  done
  case $base in
    http://127.* | http://localhost:* | 'http://[::1]:'*)
      warn "the dashboard listens on loopback only (listen.host in /etc/pve1-dash/config.yaml): your reverse proxy cannot reach it."
      ;;
  esac
  if [[ $healthy == yes ]]; then
    ok "$base/healthz answers"
    for ((i = 0; i < 15; i++)); do
      out=$(curl -fsS --max-time 10 "$base/api/snapshot" 2>/dev/null | collector_summary) || out=''
      [[ -z $out ]] || break
      sleep 2
    done
    case $out in
      ok*) ok "the dashboard reads Proxmox (${out#ok })" ;;
      error*) warn "the dashboard cannot read Proxmox: ${out#error } (docs/TROUBLESHOOTING.md \"Token 401/403\" / \"TLS fingerprint mismatch\")" ;;
      *) warn 'no Proxmox poll reported yet; check Settings → Data sources in the dashboard in a minute.' ;;
    esac
  else
    warn "no answer from $base/healthz yet: check \"pct exec $ctid -- journalctl -u pve1-dash -n 50\"."
  fi
  out=$(pct exec "$ctid" -- env -i PATH="$CT_PATH" runuser -u pve1dash -- \
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/pve1-dash/ssh/known_hosts \
    -o IdentitiesOnly=yes -o ConnectTimeout=10 -i /etc/pve1-dash/ssh/id_ed25519 "root@$PVE1_DASH_NODE_IP" version 2>&1) || :
  if [[ $out == *'pve1-dash-helper 1'* ]]; then
    ok 'SSH helper reachable from the dashboard (forced command)'
  else
    warn "SSH helper test failed: $(sanitize <<<"${out:-no output}")"
    warn 'Apps & services inside guests stay empty until this works (docs/TROUBLESHOOTING.md "Helper denied").'
  fi
}

print_summary() {
  local base=$1 raw update_cmd prefix=''
  raw=$(raw_base "$PVE1_DASH_REPO" "$PVE1_DASH_REF" 2>/dev/null) || raw='<raw repo URL>'
  if [[ $PVE1_DASH_REF != "$DEFAULT_REF" ]]; then prefix="PVE1_DASH_REF=$PVE1_DASH_REF "; fi
  if [[ $PVE1_DASH_REPO != "$DEFAULT_REPO" ]]; then prefix+="PVE1_DASH_REPO=$PVE1_DASH_REPO "; fi
  update_cmd="${prefix}bash -c \"\$(curl -fsSL $raw/deploy/install.sh)\" -- --update-helper"
  printf '\n%s🚉 pve1-dash is up!%s\n\n' "$C_B$C_G" "$C_0"
  say "Dashboard (LAN, plain HTTP):  $base"
  if [[ -n ${PVE1_DASH_PUBLIC_URL-} ]]; then say "Public URL (via your proxy):  $PVE1_DASH_PUBLIC_URL"; fi
  printf '\n%s  Next steps%s\n' "$C_B" "$C_0"
  say "1. Reverse proxy: forward ${PVE1_DASH_PUBLIC_URL:-your https URL} to $base with HTTP/2 on and"
  say '   asset caching off. Recipes for Nginx Proxy Manager, nginx, Caddy, Traefik: deploy/reverse-proxy/README.md'
  say '2. iPhone/iPad push: open the public URL in Safari → Share → Add to Home Screen, open the app, then'
  say '   Settings → Notifications → Enable on this device.'
  say '3. VMs without the QEMU guest agent: Settings → Data sources → "Add a VM without guest agent".'
  say "4. Update:    pct exec $CTID -- pve1-dash-update"
  say "             (if it says the host helper changed, run on this host: $update_cmd)"
  say "   Uninstall: bash -c \"\$(curl -fsSL $raw/deploy/uninstall.sh)\" -- --ctid $CTID"
  say "   Container shell: pct enter $CTID   ·   logs: pct exec $CTID -- journalctl -u pve1-dash -f"
  printf '\n'
}

# ───────────────────────────────────────────────────────────────────────── modes

find_dashboard_ct() {
  local ids=() out
  if [[ -n ${PVE1_DASH_CTID-} ]]; then
    is_ctid "$PVE1_DASH_CTID" || die "invalid container id \"$PVE1_DASH_CTID\""
    CTID=$PVE1_DASH_CTID
    return 0
  fi
  out=$(tagged_cts "$NODE") || out=''
  [[ -n $out ]] || die "no container tagged \"$CT_TAG\" on $NODE; pass --ctid N."
  mapfile -t ids <<<"$out"
  if ((${#ids[@]} > 1)); then die "several pve1-dash containers (${ids[*]}); pass --ctid N."; fi
  CTID=${ids[0]}
}

# Start the container if needed; on failure print pct's error and return 1.
ensure_running() {
  local out
  if [[ $(ct_status "$1") == running ]]; then return 0; fi
  say "starting container $1 ..."
  # UNVERIFIED by the research notes; the standard pct verb
  if out=$(pct start "$1" 2>&1); then return 0; fi
  warn "container $1 does not start: $(sanitize <<<"${out:-no output}")"
  return 1
}

update_helper_main() {
  STEP_NO=0
  [[ $EUID -eq 0 ]] || die 'please run this as root on the Proxmox VE host.'
  command -v pct >/dev/null 2>&1 || die 'pct not found: run this on the Proxmox VE host.'
  NODE=$(node_name) || die 'could not read the host name.'
  find_dashboard_ct
  ensure_running "$CTID" || die "container $CTID must run to refresh its helper key."
  adopt_recorded_source "$CTID"
  resolve_source
  printf '\n%sRefreshing the host helper for container %s%s\n' "$C_B" "$CTID" "$C_0"
  install_host_helper "$CTID"
  authorize_dashboard_key "$CTID"
  printf '\n'
  ok 'done'
}

parse_args() {
  UPDATE_HELPER=0
  while (($#)); do
    case $1 in
      -y | --yes) ASSUME_YES=1 ;;
      --update-helper) UPDATE_HELPER=1 ;;
      --ctid)
        [[ $# -ge 2 ]] || die '--ctid needs a value'
        PVE1_DASH_CTID=$2
        shift
        ;;
      --ctid=*) PVE1_DASH_CTID=${1#*=} ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown option \"$1\" (see --help)" ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  setup_colors
  umask 022
  REF_EXPLICIT=${PVE1_DASH_REF-}
  REPO_EXPLICIT=${PVE1_DASH_REPO-}
  DEBIAN_EXPLICIT=${PVE1_DASH_DEBIAN-}
  PVE1_DASH_REPO=${PVE1_DASH_REPO:-$DEFAULT_REPO}
  PVE1_DASH_REF=${PVE1_DASH_REF:-$DEFAULT_REF}
  PVE1_DASH_DEBIAN=${PVE1_DASH_DEBIAN:-13}
  is_repo "$PVE1_DASH_REPO" || die "PVE1_DASH_REPO=\"$PVE1_DASH_REPO\" does not look like a git URL"
  is_ref "$PVE1_DASH_REF" || die "PVE1_DASH_REF=\"$PVE1_DASH_REF\" is not a valid branch, tag or commit"
  is_debian "$PVE1_DASH_DEBIAN" || die 'PVE1_DASH_DEBIAN must be 13 or 12'
  WORK_DIR=$(mktemp -d /tmp/pve1-dash-install.XXXXXX)
  trap cleanup EXIT
  trap 'on_error $LINENO' ERR

  if ((UPDATE_HELPER)); then
    update_helper_main
    return 0
  fi

  printf '\n%s  pve1-dash installer%s  %s· read-only Proxmox dashboard · %s @ %s%s\n' \
    "$C_B" "$C_0" "$C_DIM" "${PVE1_DASH_REPO##*/}" "$PVE1_DASH_REF" "$C_0"

  step 'Preflight'
  preflight

  step 'Settings'
  choose_mode
  local not_started=no
  if [[ $MODE == update ]]; then
    CT_TOUCHED=$CTID
    if ! ensure_running "$CTID"; then
      # A wrong bridge or VLAN keeps it from starting: network settings given now are applied before it starts.
      [[ -n ${PVE1_DASH_BRIDGE-}${PVE1_DASH_VLAN+x}${PVE1_DASH_IP-}${PVE1_DASH_GATEWAY-} ]] ||
        die "container $CTID does not start. If its bridge or VLAN is wrong, re-run with PVE1_DASH_BRIDGE=... / PVE1_DASH_VLAN=... (applied to it), or fix it with \"pct set $CTID --net0 ...\"."
      not_started=yes
    fi
    if ct_sh "$CTID" 'test -f /etc/pve1-dash/config.yaml' 2>/dev/null; then NEED_CONFIG=no; fi
    adopt_recorded_source "$CTID"
  fi
  resolve_source
  check_source
  if [[ $MODE == new ]]; then
    ask_new_ct_settings
    choose_token_name "$PVE1_DASH_CTID"
  else
    plan_network_change
    choose_token_name "$CTID"
  fi
  ask_common_settings "$NEED_CONFIG"
  print_plan
  ask_yn PVE1_DASH_PROCEED 'Go ahead?' yes
  [[ $PVE1_DASH_PROCEED == yes ]] || die 'nothing changed.'

  step 'Container template'
  if [[ $MODE == new ]]; then ensure_template; else ok "skipped (existing container $CTID)"; fi

  step 'Container'
  if [[ $MODE == new ]]; then
    create_ct
  elif [[ -n $NET0_NEW ]]; then
    apply_network_change
  elif [[ $not_started == yes ]]; then
    ensure_running "$CTID" || die "container $CTID still does not start with these network settings ($NET0_CURRENT)."
  fi
  local ct_ip
  say 'waiting for the network inside the container ...'
  ct_ip=$(wait_ct_network "$CTID" 180) ||
    die "container $CTID got no IPv4 address or DNS within 3 minutes (DHCP, bridge, VLAN or firewall?). Re-run with the right PVE1_DASH_IP=<a.b.c.d/nn> PVE1_DASH_GATEWAY=<router> (and PVE1_DASH_BRIDGE / PVE1_DASH_VLAN): they are applied to this container. docs/TROUBLESHOOTING.md has the details."
  ok "container $CTID is online at $ct_ip"

  step 'Read-only API token'
  setup_token
  collect_host_facts

  step 'Dashboard inside the container (Node.js, build, service)'
  say 'this takes a few minutes (packages, Node.js download, npm install and build) ...'
  run_lxc_setup "$CTID"
  if [[ $ROTATE_LATE == yes ]]; then rotate_token_late "$CTID"; fi
  ok 'dashboard installed and running'

  step 'Host helper and SSH key'
  install_host_helper "$CTID"
  authorize_dashboard_key "$CTID"

  step 'Temperatures (lm-sensors)'
  if [[ $PVE1_DASH_SENSORS == yes ]]; then install_sensors; else ok 'skipped (re-run with PVE1_DASH_SENSORS=yes to add later)'; fi

  step 'Smoke test'
  local endpoint dash_host dash_port base
  endpoint=$(dashboard_endpoint "$CTID" "$ct_ip")
  read -r dash_host dash_port <<<"$endpoint"
  base=$(http_base "$dash_host" "$dash_port")
  smoke_test "$CTID" "$base"
  print_summary "$base"
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  main "$@"
fi
