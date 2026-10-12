#!/usr/bin/env bash
# pve1-dash-doctor: read-only self-test of a pve1-dash install. Installed as /usr/local/bin/pve1-dash-doctor inside the
# dashboard container (by pve1-dash-update and deploy/lxc-setup.sh). Run it as root in the container, or from the
# Proxmox host:  pct exec <ctid> -- pve1-dash-doctor
#
# It checks the config, the Proxmox API (reachability, TLS, token, permissions), the SSH helper, push and the system,
# also while the service is down, and prints a copy-paste fix for everything that is not right. Exit code 0: nothing
# failed. Options go to the doctor itself (dist/server/doctor.js), e.g. --json for the raw report.
#
# It runs as the service user (pve1dash) with the service's environment (PVE1_DASH_CONFIG, /etc/pve1-dash/env), so it
# sees exactly what the dashboard sees, file permissions included. It never changes anything.

set -euo pipefail

# Overridable for tests (tests/deploy-tools.test.ts); the defaults are the installed layout.
APP_DIR=${PVE1_DASH_APP_DIR:-/opt/pve1-dash}
CONF_DIR=${PVE1_DASH_CONF_DIR:-/etc/pve1-dash}
SVC_USER=${PVE1_DASH_USER:-pve1dash}
NODE_BIN=${PVE1_DASH_NODE:-/usr/local/bin/node}
DATA_DIR=/var/lib/pve1-dash

die() {
  printf 'pve1-dash-doctor: %s\n' "$*" >&2
  exit 3
}

# KEY=value lines of a systemd EnvironmentFile (comments, blank lines, "export" and one pair of quotes allowed), as
# NAME=VALUE words for env(1).
env_file_args() {
  local line key val
  [[ -r $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line#"${line%%[![:space:]]*}"}
    [[ -z $line || $line == '#'* || $line == ';'* ]] && continue
    [[ $line =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[2]}
    val=${BASH_REMATCH[3]}
    if [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
    printf '%s=%s\n' "$key" "$val"
  done <"$1"
}

main() {
  local doctor=$APP_DIR/dist/server/doctor.js me
  local -a envs=()
  [[ -f $doctor ]] || die "$doctor not found: this version of pve1-dash has no doctor yet (pve1-dash-update installs the current one)."
  if [[ ! -x $NODE_BIN ]]; then NODE_BIN=$(command -v node) || die 'Node.js not found (expected /usr/local/bin/node; pve1-dash-update reinstalls it).'; fi

  # The service's environment (deploy/pve1-dash.service): a clean one, plus what the terminal needs for colours.
  envs=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "HOME=$DATA_DIR" LANG=C.UTF-8 NODE_ENV=production
    "PVE1_DASH_CONFIG=$CONF_DIR/config.yaml")
  mapfile -t -O "${#envs[@]}" envs < <(env_file_args "$CONF_DIR/env")
  # An explicit PVE1_DASH_CONFIG (another file to check) wins over the service's.
  if [[ -n ${PVE1_DASH_CONFIG-} ]]; then envs+=("PVE1_DASH_CONFIG=$PVE1_DASH_CONFIG"); fi
  local v
  for v in TERM NO_COLOR FORCE_COLOR COLUMNS; do
    if [[ -n ${!v-} ]]; then envs+=("$v=${!v}"); fi
  done

  cd "$APP_DIR"
  me=$(id -un)
  if [[ $me == "$SVC_USER" ]]; then
    exec env -i "${envs[@]}" "$NODE_BIN" "$doctor" "$@"
  elif [[ $EUID -eq 0 ]]; then
    id -u "$SVC_USER" >/dev/null 2>&1 || die "the service user $SVC_USER does not exist (re-run the installer on the Proxmox host to repair)."
    exec runuser -u "$SVC_USER" -- env -i "${envs[@]}" "$NODE_BIN" "$doctor" "$@"
  else
    die "run it as root inside the container (or from the Proxmox host: pct exec <ctid> -- pve1-dash-doctor)."
  fi
}

main "$@"
