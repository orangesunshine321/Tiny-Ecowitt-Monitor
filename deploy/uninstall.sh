#!/usr/bin/env bash
# pve1-dash uninstaller. Run as root ON THE PROXMOX VE HOST:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/uninstall.sh)"
#
# Removes what install.sh added to the host for ONE dashboard container (the one tagged pve1-dash on this node, or
# --ctid N). Other pve1-dash dashboards in the cluster keep working:
#   - that container's line in /root/.ssh/authorized_keys (= /etc/pve/priv/authorized_keys, shared by all nodes if clustered),
#     plus lines of pve1-dash containers that no longer exist;
#   - /usr/local/sbin/pve1-dash-helper, unless another pve1-dash container on this node still needs it;
#   - (asks, default yes) that container's API token; the user pve1dash@pve too when no other dashboard is left;
#   - (asks, default NO) the container itself, including its disk. Back it up first if you care. A container that is
#     kept is stopped and taken off autostart (asks, default yes): without its key and token it could only show
#     errors and send false "unreachable" alerts.
# lm-sensors stays installed (apt remove lm-sensors if you want it gone).
#
# The functions are sourceable for tests (tests/deploy-uninstall.test.ts); main only runs when executed.

set -Eeuo pipefail

readonly PVE_USER='pve1dash@pve'
readonly DEFAULT_TOKEN_NAME='dashboard'
readonly CT_TAG='pve1-dash'
readonly HELPER_PATH='/usr/local/sbin/pve1-dash-helper'
readonly AUTHORIZED_KEYS='/root/.ssh/authorized_keys'
readonly CT_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

ASSUME_YES=0
C_B='' C_G='' C_Y='' C_R='' C_0=''

usage() {
  cat <<'EOF'
pve1-dash uninstaller (run as root on the Proxmox VE host)

Usage:
  uninstall.sh [--yes] [--ctid N]
  uninstall.sh --help

Removes the dashboard container's SSH key line, the host helper (unless another pve1-dash container on this node
uses it) and, after asking, its API token (and the user pve1dash@pve when no other dashboard is left) and the
container. Other pve1-dash dashboards in the cluster keep working.

Options:
  -y, --yes   no questions: remove the host pieces and the API token, stop the container and keep it
              (PVE1_DASH_DESTROY_CT=yes destroys it)
  --ctid N    the dashboard container (default: the one tagged pve1-dash on this node)

Environment (each one answers its question):
  PVE1_DASH_CONFIRM=yes|no       go ahead (default with --yes: yes)
  PVE1_DASH_REMOVE_USER=yes|no   remove the API token (and the user when unused); default yes
  PVE1_DASH_DESTROY_CT=yes|no    destroy the container and its disk; default no
  PVE1_DASH_STOP_CT=yes|no       when the container is kept: stop it and turn off start on boot; default yes
  PVE1_DASH_CTID                 same as --ctid
  NO_COLOR                       disable colours
EOF
}

setup_colors() {
  if [[ -t 1 && -z ${NO_COLOR:-} && ${TERM:-dumb} != dumb ]]; then
    C_B=$'\e[1m' C_G=$'\e[32m' C_Y=$'\e[33m' C_R=$'\e[31m' C_0=$'\e[0m'
  fi
}
say() { printf '  %s\n' "$*"; }
ok() { printf '  %s✔%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die() {
  printf '\n%serror:%s %s\n' "$C_R" "$C_0" "$*" >&2
  exit 1
}

# ask_yn VAR QUESTION DEFAULT(yes|no): a preset value wins, --yes takes the default; stores "yes" or "no".
ask_yn() {
  local var=$1 q=$2 def=$3 ans hint
  hint=${def/yes/Y\/n}
  hint=${hint/no/y\/N}
  while :; do
    if [[ -n ${!var-} ]]; then
      ans=${!var}
    elif ((ASSUME_YES)); then
      ans=$def
    else
      { : </dev/tty; } 2>/dev/null || die "no terminal to ask \"$q\"; use --yes and the PVE1_DASH_* variables (see --help)."
      read -r -p "  ${C_B}?${C_0} $q ($hint): " ans </dev/tty || die 'input aborted'
      ans=${ans:-$def}
    fi
    case ${ans,,} in
      y | yes | 1 | true | on)
        printf -v "$var" yes
        return 0
        ;;
      n | no | 0 | false | off)
        printf -v "$var" no
        return 0
        ;;
    esac
    if [[ -n ${!var-} ]] || ((ASSUME_YES)); then die "$var: expected yes or no, got \"$ans\""; fi
    warn 'please answer yes or no'
  done
}

# The first question. --yes means "go ahead" (PVE1_DASH_CONFIRM=no still stops it).
confirm() {
  local def=no
  if ((ASSUME_YES)); then def=yes; fi
  ask_yn PVE1_DASH_CONFIRM 'Continue?' "$def"
  [[ $PVE1_DASH_CONFIRM == yes ]]
}

# ───────────────────────────────────────────────────────────────────────── authorized_keys

# Print FILE without the pve1-dash lines that go: those of container RM_ID (comment "pve1-dash@ct<RM_ID>"), any line
# carrying BLOB (that container's key), and, unless KEEP is "*", the pve1-dash lines (forced to the helper, or with a
# pve1-dash@ct<N> comment) of containers not listed in KEEP (space separated ids of the dashboards that still exist).
# KEEP "*" (the cluster list could not be read) keeps every other line.
ak_filter() {
  awk -v helper="command=\"$HELPER_PATH\"" -v rm_id="${2-}" -v keep=" ${3-} " -v blob="${4-}" '
    {
      id = ($NF ~ /^pve1-dash@ct[0-9]+$/) ? substr($NF, 13) : ""
      ours = index($0, helper) || id != ""
      if (blob != "" && index($0, blob)) next
      if (ours && id != "" && id == rm_id) next
      if (ours && keep != " * ") {
        if (id == "" ? keep ~ /^ *$/ : index(keep, " " id " ") == 0) next
      }
      print
    }' "$1"
}

ak_fail() {
  rm -f -- "$1"
  printf 'authorized_keys: %s\n' "$2" >&2
}

# Replace FILE's content with NEW's, through a symlink (same rule as install.sh: a copy renamed over the target,
# else an in-place rewrite that is read back).
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

# ak_remove FILE RM_ID KEEP BLOB: remove the lines ak_filter drops, in place (keeps the /etc/pve/priv symlink).
# 0 = removed, 1 = nothing to remove, 2 = error (FILE unchanged; message on stderr). Every step checks itself,
# because callers use it in a condition (errexit off there); the new content is built next to FILE, not in /tmp.
ak_remove() {
  local file=$1 tmp expect got rc=0
  [[ -e $file ]] || return 1
  if ! tmp=$(mktemp "$(dirname -- "$file")/.pve1-dash-ak.XXXXXX" 2>/dev/null); then
    printf 'authorized_keys: cannot create a temporary file next to %s\n' "$file" >&2
    return 2
  fi
  if ! ak_filter "$file" "${2-}" "${3-}" "${4-}" >"$tmp"; then
    ak_fail "$tmp" "could not read $file or write $tmp (disk full?)"
    return 2
  fi
  if ! expect=$(ak_filter "$file" "${2-}" "${3-}" "${4-}" | awk 'END { print NR }') ||
    ! got=$(awk 'END { print NR }' "$tmp") || [[ $got != "$expect" ]]; then
    ak_fail "$tmp" "the new content came out incomplete (disk full?)"
    return 2
  fi
  cmp -s -- "$tmp" "$file" || rc=$?
  if ((rc == 0)); then
    rm -f -- "$tmp"
    return 1
  fi
  if ((rc != 1)); then
    ak_fail "$tmp" "could not compare $tmp with $file"
    return 2
  fi
  if ! ak_replace "$file" "$tmp"; then
    ak_fail "$tmp" "could not write $file"
    return 2
  fi
  rm -f -- "$tmp"
}

# ───────────────────────────────────────────────────────────────────────── Proxmox

node_name() {
  local h
  h=$(hostname 2>/dev/null) || return 1
  printf '%s\n' "${h%%.*}"
}

tagged_cts() {
  pvesh get "/nodes/$1/lxc" --output-format json 2>/dev/null | TAG=$CT_TAG perl -MJSON -0777 -ne '
    my $d = eval { decode_json($_) };
    exit 0 unless ref $d eq "ARRAY";
    for my $ct (sort { $a->{vmid} <=> $b->{vmid} } grep { ref $_ eq "HASH" && defined $_->{vmid} } @$d) {
      my @tags = split /[;,\s]+/, ($ct->{tags} // "");
      print "$ct->{vmid}\n" if grep { lc($_) eq $ENV{TAG} } @tags;
    }'
}

# pve1-dash containers in the whole cluster, "<vmid>@<node>" per line. Fails when the list cannot be read.
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

ct_status() { pct status "$1" 2>/dev/null | awk '$1 == "status:" { print $2; exit }'; }

ct_cat() { pct exec "$1" -- env -i PATH="$CT_PATH" cat "$2" 2>/dev/null; }

# The token name container CTID uses (from proxmox.tokenId in its config), when it is one of pve1dash@pve's.
ct_token_name() {
  local id re='^pve1dash@pve!([A-Za-z][A-Za-z0-9._-]{0,63})$'
  id=$(ct_cat "$1" /etc/pve1-dash/config.yaml | sed -nE 's/^[[:space:]]+tokenId:[[:space:]]*["'\'']?([^"'\''[:space:]#]+).*/\1/p' | head -n 1)
  [[ $id =~ $re ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

# The key blob of container CTID's dashboard key, to also remove copies of it.
ct_key_blob() {
  local t k
  read -r t k _ <<<"$(ct_cat "$1" /etc/pve1-dash/ssh/id_ed25519.pub | head -n 1)" || return 1
  [[ $t == ssh-ed25519 && ${k-} =~ ^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$ ]] || return 1
  printf '%s\n' "$k"
}

# Token names of the user, one per line (nothing when the user does not exist).
user_tokens() {
  pveum user token list "$PVE_USER" --output-format json 2>/dev/null | perl -MJSON -0777 -ne '
    my $d = eval { decode_json($_) };
    exit 0 unless ref $d eq "ARRAY";
    print "$_->{tokenid}\n" for grep { ref $_ eq "HASH" && defined $_->{tokenid} } @$d;'
}

# Listing the user's tokens fails when the user does not exist.
user_exists() { pveum user token list "$PVE_USER" --output-format json >/dev/null 2>&1; }

# The CLI verbs for removing tokens and users are not covered by the research notes (research §4.2 names
# "user token delete"; the pveum docs use "user token remove" and "user delete"). Both spellings are tried; which one
# is the alias on each version is UNVERIFIED.
remove_token() {
  local out
  if out=$(pveum user token remove "$PVE_USER" "$1" 2>&1) || out=$(pveum user token delete "$PVE_USER" "$1" 2>&1); then
    ok "removed token $PVE_USER!$1"
  else
    warn "could not remove token $PVE_USER!$1: $out"
  fi
}

remove_user() {
  local out
  # Deleting the user also deletes its tokens; PVE drops ACL entries of users and tokens that no longer exist.
  if out=$(pveum user delete "$PVE_USER" 2>&1) || out=$(pveum user remove "$PVE_USER" 2>&1); then
    ok "removed user $PVE_USER"
  else
    warn "could not remove $PVE_USER: $out"
    warn 'Remove it in the web UI: Datacenter → Permissions → Users.'
  fi
}

# remove_api_access TOKEN_NAME LAST: remove this dashboard's token; with LAST=yes (no other dashboard is left) the
# user too, with all its tokens. TOKEN_NAME may be empty (unknown): then only the user can go.
remove_api_access() {
  local name=$1 last=$2 left
  if ! user_exists; then
    ok "user $PVE_USER does not exist"
    return 0
  fi
  if [[ -n $name ]] && user_tokens | grep -qxF -- "$name"; then remove_token "$name"; fi
  left=$(user_tokens | tr '\n' ' ')
  if [[ $last == yes ]]; then
    remove_user
  elif [[ -n ${left// /} ]]; then
    ok "kept user $PVE_USER: other dashboards use its tokens (${left% })"
  else
    ok "kept user $PVE_USER (other pve1-dash containers exist); remove it later in Datacenter → Permissions → Users"
  fi
  if [[ -z $name && $last != yes ]]; then
    warn "could not tell which token this container used; remove it in Datacenter → Permissions → API Tokens if it is left over."
  fi
}

# handle_container CTID: destroy it (asks, default no), or stop it and turn off start on boot (asks, default yes).
# Runs before the key and token go, so the dashboard cannot send a false "unreachable" alert in between.
handle_container() {
  local ctid=$1 name
  name=$(pct config "$ctid" 2>/dev/null | awk -F': ' '$1 == "hostname" { print $2 }') || name=''
  warn "Destroying container $ctid${name:+ ($name)} deletes the dashboard, its settings, push devices and history."
  ask_yn PVE1_DASH_DESTROY_CT "Destroy container $ctid too?" no
  if [[ $PVE1_DASH_DESTROY_CT == yes ]]; then
    destroy_ct "$ctid"
    return 0
  fi
  say "Without its SSH key and API token, the dashboard in container $ctid can only show errors and send false"
  say '"unreachable" alerts to your devices.'
  ask_yn PVE1_DASH_STOP_CT "Stop container $ctid and keep it from starting on boot?" yes
  if [[ $PVE1_DASH_STOP_CT == yes ]]; then
    if [[ $(ct_status "$ctid") == running ]]; then
      pct stop "$ctid" # UNVERIFIED by the research notes; the standard pct verb
    fi
    pct set "$ctid" --onboot 0 >/dev/null || warn "could not turn off start on boot for $ctid"
    ok "kept container $ctid, stopped and without start on boot (pct start $ctid to look inside)"
  else
    ok "kept container $ctid (still running)"
  fi
}

destroy_ct() {
  local ctid=$1
  if [[ $(ct_status "$ctid") == running ]]; then
    say "stopping container $ctid ..."
    pct stop "$ctid" # UNVERIFIED by the research notes; the standard pct verb
  fi
  pct destroy "$ctid" # UNVERIFIED by the research notes; removes the container and its disks
  ok "destroyed container $ctid"
}

main() {
  local ctid='' ids='' all='' listing=ok others='' keep='' local_others='' token='' blob='' last=no rc=0
  local -a idlist=()
  while (($#)); do
    case $1 in
      -y | --yes) ASSUME_YES=1 ;;
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
  setup_colors
  [[ $EUID -eq 0 ]] || die 'please run this as root on the Proxmox VE host.'
  command -v pveum >/dev/null 2>&1 || die 'pveum not found: run this on the Proxmox VE host.'

  local node
  node=$(node_name) || die 'could not read the host name.'
  if [[ -n ${PVE1_DASH_CTID-} ]]; then
    [[ $PVE1_DASH_CTID =~ ^[0-9]{3,9}$ ]] || die "invalid container id \"$PVE1_DASH_CTID\""
    ctid=$PVE1_DASH_CTID
  else
    ids=$(tagged_cts "$node") || ids=''
    if [[ -n $ids ]]; then mapfile -t idlist <<<"$ids"; fi
    if ((${#idlist[@]} > 1)); then die "several pve1-dash containers on $node (${idlist[*]}); pass --ctid N."; fi
    ctid=${idlist[0]-}
  fi
  # The other dashboards decide what is shared and must stay: the user, the helper on this node, their key lines.
  if all=$(cluster_tagged_cts); then
    others=$(awk -F@ -v me="$ctid" 'NF && $1 != me' <<<"$all")
    keep=$(cut -d@ -f1 <<<"$others" | tr '\n' ' ')
    local_others=$(awk -F@ -v n="$node" '$2 == n' <<<"$others")
    if [[ -z $others ]]; then last=yes; fi
  else
    listing=failed keep='*'
    local_others=$(tagged_cts "$node" | grep -vxF -- "$ctid" || :)
    warn 'could not list the pve1-dash containers of the cluster; only this container'"'"'s pieces are removed.'
  fi
  if [[ -n $ctid && $(ct_status "$ctid") == running ]]; then
    token=$(ct_token_name "$ctid") || token=''
    blob=$(ct_key_blob "$ctid") || blob=''
  fi
  if [[ -z $token && $last != yes ]] && [[ -n $ctid ]]; then
    # The installer's naming for a dashboard next to others.
    if user_tokens | grep -qxF -- "$DEFAULT_TOKEN_NAME-ct$ctid"; then token=$DEFAULT_TOKEN_NAME-ct$ctid; fi
  fi
  if [[ -z $token && $last == yes ]]; then token=$DEFAULT_TOKEN_NAME; fi

  printf '\n%s  pve1-dash uninstaller%s\n\n' "$C_B" "$C_0"
  if [[ -n $ctid ]]; then say "Dashboard container: $ctid"; else say "No pve1-dash container found on $node."; fi
  say "This removes its SSH key line${keep:+ (and those of pve1-dash containers that no longer exist)} from $AUTHORIZED_KEYS."
  if [[ -z $local_others ]]; then
    say "It removes $HELPER_PATH from this host."
  else
    say "$HELPER_PATH stays: other pve1-dash containers on $node use it (${local_others//$'\n'/, })."
  fi
  if [[ -n $others ]]; then say "Other dashboards keep working: ${others//$'\n'/, }."; fi
  confirm || die 'nothing changed.'
  ask_yn PVE1_DASH_REMOVE_USER "Remove the API token${token:+ $PVE_USER!$token}$([[ $last == yes ]] && printf ' and the user %s' "$PVE_USER")?" yes

  if [[ -n $ctid ]]; then handle_container "$ctid"; else ok "no container tagged $CT_TAG found on $node"; fi

  if [[ -e $AUTHORIZED_KEYS ]]; then
    cp -- "$AUTHORIZED_KEYS" "$AUTHORIZED_KEYS.pve1-dash.bak" || die "could not back up $AUTHORIZED_KEYS; it was not changed."
  fi
  ak_remove "$AUTHORIZED_KEYS" "$ctid" "$keep" "$blob" || rc=$?
  case $rc in
    0) ok "removed the pve1-dash key line(s) from $AUTHORIZED_KEYS (backup: $AUTHORIZED_KEYS.pve1-dash.bak)" ;;
    1) ok "no pve1-dash key line to remove in $AUTHORIZED_KEYS" ;;
    *) die "could not update $AUTHORIZED_KEYS (see above). If it looks wrong now, restore it with: cat $AUTHORIZED_KEYS.pve1-dash.bak > $AUTHORIZED_KEYS" ;;
  esac
  if [[ -n $local_others ]]; then
    ok "kept $HELPER_PATH for the other pve1-dash containers on $node"
  elif [[ -e $HELPER_PATH ]]; then
    rm -f "$HELPER_PATH"
    ok "removed $HELPER_PATH"
  else
    ok "$HELPER_PATH was not installed"
  fi

  if [[ $PVE1_DASH_REMOVE_USER == yes ]]; then remove_api_access "$token" "$last"; fi
  if [[ $listing == failed ]]; then warn "the user $PVE_USER was kept because the cluster list could not be read."; fi
  printf '\n'
  ok 'pve1-dash is uninstalled from this host. Thanks for riding! 🚉'
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  main "$@"
fi
