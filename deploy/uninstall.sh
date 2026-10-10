#!/usr/bin/env bash
# pve1-dash uninstaller. Run as root ON THE PROXMOX VE HOST:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/uninstall.sh)"
#
# Removes what install.sh added to the host:
#   - every pve1-dash line in /root/.ssh/authorized_keys (= /etc/pve/priv/authorized_keys, shared by the cluster);
#   - /usr/local/sbin/pve1-dash-helper;
#   - (asks, default yes) the API token pve1dash@pve!dashboard and the user pve1dash@pve, with their permissions;
#   - (asks, default NO) the dashboard container itself, including its disk. Back it up first if you care.
# lm-sensors stays installed (apt remove lm-sensors if you want it gone).
#
# Options: -y/--yes (no questions: removes host pieces and the API user, keeps the container unless
#          PVE1_DASH_DESTROY_CT=yes), --ctid N, -h/--help.
# Environment: PVE1_DASH_REMOVE_USER=yes|no, PVE1_DASH_DESTROY_CT=yes|no, PVE1_DASH_CTID, NO_COLOR.

set -Eeuo pipefail

readonly PVE_USER='pve1dash@pve'
readonly TOKEN_NAME='dashboard'
readonly TOKEN_ID='pve1dash@pve!dashboard'
readonly CT_TAG='pve1-dash'
readonly HELPER_PATH='/usr/local/sbin/pve1-dash-helper'
readonly AUTHORIZED_KEYS='/root/.ssh/authorized_keys'

ASSUME_YES=0
C_B='' C_G='' C_Y='' C_R='' C_0=''

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
      { : </dev/tty; } 2>/dev/null || die "no terminal to ask \"$q\"; use --yes and PVE1_DASH_* variables."
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

# Print FILE without pve1-dash lines (same rule as install.sh): pinned to the helper, or with a pve1-dash@ct<N> comment.
ak_filter() {
  awk -v helper="command=\"$HELPER_PATH\"" '
    index($0, helper) { next }
    $NF ~ /^pve1-dash@ct[0-9]+$/ { next }
    { print }' "$1"
}

# Remove the pve1-dash lines from FILE in place (keeps the /etc/pve/priv symlink). Returns 1 if there were none.
ak_remove() {
  local file=$1 tmp
  [[ -e $file ]] || return 1
  tmp=$(mktemp "${TMPDIR:-/tmp}/pve1-dash-ak.XXXXXX")
  ak_filter "$file" >"$tmp"
  if cmp -s "$tmp" "$file"; then
    rm -f "$tmp"
    return 1
  fi
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

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

# Listing the user's tokens fails when the user does not exist.
user_exists() {
  pveum user token list "$PVE_USER" --output-format json >/dev/null 2>&1
}

# The CLI verbs for removing tokens and users are not covered by the research notes (research §4.2 names
# "user token delete"; the pveum docs use "user token remove" and "user delete"). Both spellings are tried; which one
# is the alias on each version is UNVERIFIED.
remove_api_user() {
  local out
  if ! user_exists; then
    ok "user $PVE_USER does not exist"
    return 0
  fi
  if pveum user token list "$PVE_USER" --output-format json 2>/dev/null | grep -q "\"tokenid\":\"$TOKEN_NAME\""; then
    if out=$(pveum user token remove "$PVE_USER" "$TOKEN_NAME" 2>&1) ||
      out=$(pveum user token delete "$PVE_USER" "$TOKEN_NAME" 2>&1); then
      ok "removed token $TOKEN_ID"
    else
      warn "could not remove token $TOKEN_ID: $out"
    fi
  fi
  # Deleting the user also deletes its tokens; PVE drops ACL entries of users and tokens that no longer exist.
  if out=$(pveum user delete "$PVE_USER" 2>&1) || out=$(pveum user remove "$PVE_USER" 2>&1); then
    ok "removed user $PVE_USER"
  else
    warn "could not remove $PVE_USER: $out"
    warn 'Remove it in the web UI: Datacenter → Permissions → Users.'
  fi
}

destroy_ct() {
  local ctid=$1 status
  status=$(pct status "$ctid" 2>/dev/null | awk '$1 == "status:" { print $2 }') || status=''
  if [[ $status == running ]]; then
    say "stopping container $ctid ..."
    pct stop "$ctid" # UNVERIFIED by the research notes; the standard pct verb
  fi
  pct destroy "$ctid" # UNVERIFIED by the research notes; removes the container and its disks
  ok "destroyed container $ctid"
}

main() {
  local ctid='' ids='' out
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
        sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || :
        exit 0
        ;;
      *) die "unknown option \"$1\"" ;;
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
    ctid=$(tail -n 1 <<<"$ids")
  fi

  printf '\n%s  pve1-dash uninstaller%s\n\n' "$C_B" "$C_0"
  say "This removes the pve1-dash SSH key line and $HELPER_PATH from this host."
  ask_yn PVE1_DASH_CONFIRM 'Continue?' no
  [[ $PVE1_DASH_CONFIRM == yes ]] || die 'nothing changed.'

  if [[ -e $AUTHORIZED_KEYS ]]; then cp "$AUTHORIZED_KEYS" /root/.ssh/authorized_keys.pve1-dash.bak; fi
  if ak_remove "$AUTHORIZED_KEYS"; then
    ok "removed the pve1-dash key from $AUTHORIZED_KEYS (backup: /root/.ssh/authorized_keys.pve1-dash.bak)"
  else
    ok "no pve1-dash key in $AUTHORIZED_KEYS"
  fi
  if [[ -e $HELPER_PATH ]]; then
    rm -f "$HELPER_PATH"
    ok "removed $HELPER_PATH"
  else
    ok "$HELPER_PATH was not installed"
  fi

  ask_yn PVE1_DASH_REMOVE_USER "Remove the API token $TOKEN_ID and the user $PVE_USER?" yes
  if [[ $PVE1_DASH_REMOVE_USER == yes ]]; then remove_api_user; fi

  if [[ -n $ctid ]]; then
    out=$(pct config "$ctid" 2>/dev/null | awk -F': ' '$1 == "hostname" { print $2 }') || out=''
    warn "Destroying container $ctid${out:+ ($out)} deletes the dashboard, its settings, push devices and history."
    ask_yn PVE1_DASH_DESTROY_CT "Destroy container $ctid too?" no
    if [[ $PVE1_DASH_DESTROY_CT == yes ]]; then destroy_ct "$ctid"; else ok "kept container $ctid"; fi
  else
    ok "no container tagged $CT_TAG found on $node"
  fi
  printf '\n'
  ok 'pve1-dash is uninstalled from this host. Thanks for riding! 🚉'
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  main "$@"
fi
