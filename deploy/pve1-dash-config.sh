#!/usr/bin/env bash
# pve1-dash-config: edit /etc/pve1-dash/config.yaml safely, like visudo. Installed as /usr/local/bin/pve1-dash-config
# inside the dashboard container. Run it as root in the container, or from the Proxmox host:
#   pct exec <ctid> -- pve1-dash-config          (pct enter <ctid> first if your editor needs a full terminal)
#
# Usage: pve1-dash-config [--no-restart]     edit a copy in $VISUAL / $EDITOR (default nano), check it with the
#                                            dashboard's own config loader, save it and restart the dashboard
#        pve1-dash-config --check [FILE]     only check FILE (default: the live config); exit 0 = usable
#
# A copy with a mistake is never saved: you get the error with its line number and can edit again or leave the live
# config untouched. All options, with their defaults: /opt/pve1-dash/deploy/config.example.yaml

set -euo pipefail

# Overridable for tests (tests/deploy-tools.test.ts); the defaults are the installed layout.
APP_DIR=${PVE1_DASH_APP_DIR:-/opt/pve1-dash}
CONF_DIR=${PVE1_DASH_CONF_DIR:-/etc/pve1-dash}
SVC_USER=${PVE1_DASH_USER:-pve1dash}
NODE_BIN=${PVE1_DASH_NODE:-/usr/local/bin/node}
SERVICE=pve1-dash
CONFIG=$CONF_DIR/config.yaml
TMP=''

say() { printf 'pve1-dash-config: %s\n' "$*"; }
die() {
  printf 'pve1-dash-config: %s\n' "$*" >&2
  exit 1
}
cleanup() { if [[ -n $TMP ]]; then rm -f "$TMP"; fi; }

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

node_bin() {
  if [[ -x $NODE_BIN ]]; then printf '%s\n' "$NODE_BIN"; else command -v node || die 'Node.js not found (pve1-dash-update reinstalls it).'; fi
}

# check FILE: the server's own validation (YAML, schema, token file), with the file name and line in every error.
# Prints its verdict and warnings; returns its exit code (0 = the dashboard would start with it).
check() {
  local server=$APP_DIR/dist/server/index.js node
  [[ -f $server ]] || die "$server not found: is pve1-dash installed here?"
  node=$(node_bin)
  (cd "$APP_DIR" && "$node" "$server" --check-config "$1")
}

pick_editor() {
  local e
  for e in "${VISUAL-}" "${EDITOR-}" nano vi; do
    if [[ -n $e ]] && command -v "${e%% *}" >/dev/null 2>&1; then
      printf '%s\n' "$e"
      return 0
    fi
  done
  die 'no editor found: set EDITOR, or apt install nano'
}

have_tty() { { : </dev/tty; } 2>/dev/null; }

# Ask on the terminal; fails when there is none.
ask() {
  local answer=''
  have_tty || return 1
  read -r -p "$1" answer </dev/tty || return 1
  printf '%s\n' "$answer"
}

restart_service() {
  say "restarting $SERVICE ..."
  systemctl restart "$SERVICE" || :
  # pve1-dash-update knows the listen address and how to wait for /healthz (in a subshell: it sets its own options).
  if [[ -x /usr/local/bin/pve1-dash-update ]] &&
    bash -c 'source /usr/local/bin/pve1-dash-update && read -r h p <<<"$(listen_endpoint)" && wait_healthy "$(health_url "$h" "$p")" 45'; then
    say 'the dashboard is running with the new config'
    return 0
  fi
  if systemctl is-active --quiet "$SERVICE"; then
    say "$SERVICE is active; check the dashboard in a minute"
    return 0
  fi
  printf 'pve1-dash-config: %s did not come up. Last log lines:\n' "$SERVICE" >&2
  journalctl -u "$SERVICE" -n 20 --no-pager >&2 2>/dev/null || :
  return 1
}

edit() {
  local restart=$1 editor answer
  [[ $EUID -eq 0 ]] || die 'run it as root inside the container (or from the host: pct exec <ctid> -- pve1-dash-config).'
  [[ -f $CONFIG ]] || die "$CONFIG not found: is pve1-dash installed here?"
  editor=$(pick_editor)
  # The copy lives next to the config, so saving is one rename on the same file system.
  TMP=$(mktemp --suffix=.yaml "$CONF_DIR/.config.edit.XXXXXX")
  trap cleanup EXIT
  cp "$CONFIG" "$TMP"
  while :; do
    # shellcheck disable=SC2086 # EDITOR may carry options, e.g. "code --wait"
    if have_tty; then
      $editor "$TMP" </dev/tty || die "the editor ($editor) failed; nothing was changed"
    else
      $editor "$TMP" || die "the editor ($editor) failed; nothing was changed"
    fi
    if cmp -s "$TMP" "$CONFIG"; then
      say 'no changes'
      return 0
    fi
    if check "$TMP"; then break; fi
    printf '\n'
    answer=$(ask 'The copy has a mistake (see above). [e]dit again or [q]uit without saving? [e] ') ||
      die "nothing saved; $CONFIG is unchanged"
    case ${answer,,} in
      '' | e | edit) continue ;;
      *) die "nothing saved; $CONFIG is unchanged" ;;
    esac
  done
  chown "root:$SVC_USER" "$TMP"
  chmod 0640 "$TMP"
  mv -f "$TMP" "$CONFIG"
  TMP=''
  say "saved $CONFIG"
  if [[ $restart == yes ]]; then
    restart_service || die 'the dashboard did not start with the new config (it falls back to the last good one; see the log lines above). Run pve1-dash-config again to fix it.'
  else
    say "not restarted; the change applies after: systemctl restart $SERVICE"
  fi
}

main() {
  case ${1-} in
    -h | --help) usage ;;
    --check)
      check "${2:-$CONFIG}"
      ;;
    --no-restart) edit no ;;
    '') edit yes ;;
    *) die "unknown option \"$1\" (see --help)" ;;
  esac
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  main "$@"
fi
