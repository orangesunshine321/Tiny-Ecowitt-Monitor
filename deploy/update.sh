#!/usr/bin/env bash
# pve1-dash-update: update pve1-dash INSIDE its container. Installed as /usr/local/bin/pve1-dash-update by
# deploy/lxc-setup.sh. Run as root in the container, or from the Proxmox host: pct exec <ctid> -- pve1-dash-update
#
# Usage: pve1-dash-update [--ref REF] [--repo URL] [--force] [--no-restart] [--skip-node]
#   --ref REF      branch, tag or full commit id to deploy (default: the one recorded in /etc/pve1-dash/install.env)
#   --repo URL     git repository (default: recorded, else the GitHub repo)
#   --force        rebuild even when the ref resolves to the commit already installed
#   --no-restart   build and switch the code, but leave the service alone
#   --skip-node    don't check nodejs.org for a newer Node.js 24.x
#
# How it works: the new version is fetched and built in /opt/pve1-dash.new while the old one keeps running, then the
# directories are swapped (the old one is kept as /opt/pve1-dash.prev) and the service restarts. If the dashboard
# does not come back healthy, the previous version is restored automatically.
#
# deploy/lxc-setup.sh sources this file for try_update_node, build_release, activate_release, install_system_files,
# save_install_env and start_service, so keep those self-contained. main only runs when executed.

set -Eeuo pipefail

readonly DEFAULT_REPO='https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git'
readonly APP_DIR=/opt/pve1-dash
readonly CONF_DIR=/etc/pve1-dash
readonly INSTALL_ENV=/etc/pve1-dash/install.env
readonly SERVICE=pve1-dash
readonly UNIT_PATH=/etc/systemd/system/pve1-dash.service
readonly COMPAT_DROPIN=/etc/systemd/system/pve1-dash.service.d/10-lxc-compat.conf
readonly UPDATE_TOOL=/usr/local/bin/pve1-dash-update
readonly NODE_MAJOR=24

say() { printf 'pve1-dash: %s\n' "$*"; }
ok() { printf 'pve1-dash: ✔ %s\n' "$*"; }
warn() { printf 'pve1-dash: ! %s\n' "$*" >&2; }
die() {
  printf 'pve1-dash: error: %s\n' "$*" >&2
  exit 1
}

# ───────────────────────────────────────────────────────────────────────── Node.js

# Where Node.js versions and the node/npm links go. The variables exist for tests (tests/deploy-update.test.ts).
readonly NODE_ROOT=${PVE1_DASH_NODE_ROOT:-/opt}
readonly BIN_DIR=${PVE1_DASH_BIN_DIR:-/usr/local/bin}

# Node.js <major> LTS from the official tarball, verified against SHASUMS256.txt, unpacked to
# /opt/node-v<version>-linux-<arch>, with /opt/node pointing at it and node/npm/npx/corepack linked into
# /usr/local/bin. Does nothing when that version is already active.
#
# Every step checks its own result: try_update_node runs this where errexit is off (a failed step there would
# otherwise go unnoticed). The working version is only touched once the new one is unpacked and runs, and older
# versions are only deleted after the switch is verified.
install_node() {
  local major=${1:-$NODE_MAJOR} dist arch sums line sha file version dest tmp current='' got prev old
  dist="${PVE1_DASH_NODE_DIST:-https://nodejs.org/dist}/latest-v${major}.x"
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU architecture $(uname -m) (Node.js binaries exist for x64 and arm64)" ;;
  esac
  sums=$(curl -fsSL --retry 3 --max-time 60 "$dist/SHASUMS256.txt") || die "cannot download $dist/SHASUMS256.txt"
  line=$(node_tarball_line "$sums" "$major" "$arch") || die "no node-v${major}.x linux-$arch tarball listed in $dist/SHASUMS256.txt"
  sha=${line%% *}
  file=${line##* }
  version=${file#node-}
  version=${version%%-linux-*}
  if [[ -x $NODE_ROOT/node/bin/node ]]; then current=$("$NODE_ROOT/node/bin/node" --version 2>/dev/null) || current=''; fi
  if [[ $current == "$version" ]]; then
    ok "Node.js $version is current"
    link_node_bins || die "could not link node/npm into $BIN_DIR"
    return 0
  fi
  say "installing Node.js $version ($arch) ..."
  tmp=$(mktemp -d) || die 'cannot create a temporary directory'
  if ! curl -fsSL --retry 3 --max-time 600 -o "$tmp/$file" "$dist/$file"; then
    rm -rf "$tmp"
    die "cannot download $dist/$file"
  fi
  if ! (cd "$tmp" && printf '%s  %s\n' "$sha" "$file" | sha256sum --check --status); then
    rm -rf "$tmp"
    die "checksum mismatch for $file (expected $sha from SHASUMS256.txt)"
  fi
  dest=$NODE_ROOT/${file%.tar.xz}
  if ! { rm -rf "$dest.tmp" && mkdir -p "$dest.tmp"; }; then
    rm -rf "$tmp"
    die "cannot create $dest.tmp"
  fi
  if ! tar -xJf "$tmp/$file" -C "$dest.tmp" --strip-components=1 --no-same-owner; then
    rm -rf "$tmp" "$dest.tmp"
    die "could not unpack $file (disk full?); Node.js was not changed"
  fi
  rm -rf "$tmp"
  got=$("$dest.tmp/bin/node" --version 2>/dev/null) || got=''
  if [[ $got != "$version" ]]; then
    rm -rf "$dest.tmp"
    die "the unpacked Node.js $version does not run (it printed \"$got\"); Node.js was not changed"
  fi
  # Switch. /opt/node is a symlink to the active version; a real directory there (manual install) is replaced.
  prev=$(readlink "$NODE_ROOT/node" 2>/dev/null) || prev=''
  if ! { rm -rf "$dest" && mv "$dest.tmp" "$dest"; }; then
    rm -rf "$dest.tmp"
    die "cannot move the new Node.js to $dest"
  fi
  if [[ -d $NODE_ROOT/node && ! -L $NODE_ROOT/node ]]; then rm -rf "$NODE_ROOT/node" || die "cannot replace the directory $NODE_ROOT/node"; fi
  # A new link renamed over the old one: /opt/node is never missing.
  if ! { ln -sfn "$dest" "$NODE_ROOT/node.new" && mv -Tf "$NODE_ROOT/node.new" "$NODE_ROOT/node"; }; then
    die "could not point $NODE_ROOT/node at $dest"
  fi
  got=''
  if link_node_bins; then got=$("$BIN_DIR/node" --version 2>/dev/null) || got=''; fi
  if [[ $got != "$version" ]]; then
    if [[ -n $prev && -d $prev ]]; then
      ln -sfn "$prev" "$NODE_ROOT/node.new" && mv -Tf "$NODE_ROOT/node.new" "$NODE_ROOT/node" && link_node_bins || :
    fi
    die "$BIN_DIR/node does not run Node.js $version after the switch (it printed \"$got\")${prev:+; switched back to $prev}"
  fi
  # Only now remove older versions installed by this script.
  for old in "$NODE_ROOT"/node-v*-linux-*; do
    if [[ -d $old && $old != "$dest" ]]; then rm -rf "$old" || warn "could not remove $old"; fi
  done
  ok "Node.js $version installed"
}

# Keep Node.js current within its major line; a nodejs.org hiccup (or a full disk) must not block an app update when
# a working Node.js exists.
try_update_node() {
  local rc=0
  (install_node) || rc=$?
  if ((rc == 0)); then return 0; fi
  [[ -x $BIN_DIR/node ]] || die 'Node.js is not installed and could not be installed'
  warn "could not install a newer Node.js; keeping $("$BIN_DIR/node" --version 2>/dev/null || echo 'the current one')"
}

# The "<sha256>  node-v<major>.<minor>.<patch>-linux-<arch>.tar.xz" line from SHASUMS256.txt text.
node_tarball_line() {
  local sums=$1 major=$2 arch=$3
  grep -E "^[0-9a-f]{64}  node-v${major}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz\$" <<<"$sums" | head -n 1 | grep .
}

link_node_bins() {
  local b
  for b in node npm npx corepack; do
    if [[ -e $NODE_ROOT/node/bin/$b ]]; then ln -sfn "$NODE_ROOT/node/bin/$b" "$BIN_DIR/$b" || return 1; fi
  done
}

# ───────────────────────────────────────────────────────────────────────── code

# Shallow-fetch REPO at REF (branch, tag or full commit id) into a fresh DIR.
fetch_source() {
  local repo=$1 ref=$2 dir=$3
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "$repo"
  git -C "$dir" fetch -q --depth 1 origin "$ref" || die "git fetch of \"$ref\" from $repo failed"
  git -C "$dir" -c advice.detachedHead=false checkout -q --force FETCH_HEAD
}

# npm ci (with dev dependencies, without install scripts: nothing here needs them and ssh2's optional native addon
# would otherwise try to compile), build web + server, then drop the dev dependencies.
build_release() {
  local dir=$1
  export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
  say 'installing dependencies (npm ci) ...'
  (cd "$dir" && npm ci --include=dev --ignore-scripts --no-audit --no-fund --loglevel=error) || die 'npm ci failed'
  say 'building the web app and the server ...'
  (cd "$dir" && npm run build) || die 'npm run build failed (1 GiB of memory is recommended for the build)'
  (cd "$dir" && npm prune --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) || die 'npm prune failed'
  [[ -f $dir/dist/server/index.js ]] || die "the build did not produce $dir/dist/server/index.js"
  [[ -f $dir/dist/web/index.html ]] || warn 'the build has no dist/web/index.html; the dashboard will show a placeholder page'
}

# Swap DIR into place as /opt/pve1-dash; the previous version becomes /opt/pve1-dash.prev.
activate_release() {
  local dir=$1
  rm -rf "$APP_DIR.prev"
  if [[ -e $APP_DIR ]]; then mv "$APP_DIR" "$APP_DIR.prev"; fi
  mv "$dir" "$APP_DIR"
}

rollback_release() {
  [[ -d $APP_DIR.prev ]] || return 1
  rm -rf "$APP_DIR.failed"
  mv "$APP_DIR" "$APP_DIR.failed"
  mv "$APP_DIR.prev" "$APP_DIR"
}

# The systemd unit and this update tool, from the active release.
install_system_files() {
  local reload=0
  if ! cmp -s "$APP_DIR/deploy/pve1-dash.service" "$UNIT_PATH"; then
    install -m 0644 "$APP_DIR/deploy/pve1-dash.service" "$UNIT_PATH"
    reload=1
  fi
  if ! cmp -s "$APP_DIR/deploy/update.sh" "$UPDATE_TOOL"; then
    # install(1) writes a new file, so a running copy of this script keeps reading its old inode.
    install -m 0755 "$APP_DIR/deploy/update.sh" "$UPDATE_TOOL"
  fi
  if ((reload)); then systemctl daemon-reload; fi
}

# ───────────────────────────────────────────────────────────────────────── service

# "<host> <port>" from listen.host / listen.port in config FILE (defaults 0.0.0.0 and 8080), read with the yaml
# package of the release in APPDIR. Prints nothing when it cannot be read.
config_listen() {
  local file=$1 appdir=$2
  [[ -f $file && -d $appdir/node_modules/yaml ]] || return 0
  (cd "$appdir" && node -e '
    const y = require("yaml"), fs = require("fs");
    const c = y.parse(fs.readFileSync(process.argv[1], "utf8")) || {};
    const l = (c && typeof c.listen === "object" && c.listen) || {};
    process.stdout.write(String(l.host || "") + " " + String(l.port || "") + "\n");' "$file" 2>/dev/null) || :
}

# "<host> <port>" the server listens on. PVE1_DASH_PORT in /etc/pve1-dash/env overrides the port, like the server.
listen_endpoint() {
  local host='' port='' cport=''
  if [[ -f $CONF_DIR/env ]]; then port=$(sed -n 's/^PVE1_DASH_PORT=//p' "$CONF_DIR/env" | tr -d "\"' " | tail -n 1); fi
  read -r host cport <<<"$(config_listen "$CONF_DIR/config.yaml" "$APP_DIR")" || :
  port=${port:-$cport}
  [[ $host =~ ^[A-Za-z0-9.:_-]{1,253}$ ]] || host=0.0.0.0
  [[ $port =~ ^[0-9]{1,5}$ ]] || port=8080
  printf '%s %s\n' "$host" "$port"
}

# The /healthz URL for a listen address: a wildcard address is probed on loopback, a specific one (e.g. the
# container's LAN address) on that address.
health_url() {
  local host=$1 port=$2
  case $host in
    '' | 0.0.0.0 | '::' | '[::]') host=127.0.0.1 ;;
  esac
  if [[ $host == *:* && $host != \[* ]]; then host="[$host]"; fi
  printf 'http://%s:%s/healthz\n' "$host" "$port"
}

wait_healthy() {
  local url=$1 deadline=$((SECONDS + ${2:-60}))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 3 "$url" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    if [[ $(systemctl show -p ActiveState --value "$SERVICE" 2>/dev/null) == failed ]]; then return 1; fi
    sleep 2
  done
  return 1
}

# Systemd's sandboxing (ProtectSystem, PrivateTmp, ...) needs mount namespaces, which an unprivileged container only
# allows with nesting=1. Without them the unit fails with status 226/NAMESPACE; this drop-in turns those options off.
write_compat_dropin() {
  mkdir -p "${COMPAT_DROPIN%/*}"
  cat >"$COMPAT_DROPIN" <<'EOF'
# Written by pve1-dash because the service failed with 226/NAMESPACE: this container cannot create the mount
# namespaces the sandbox options need (enable "nesting" in the container's Options, delete this file and run
# "systemctl daemon-reload && systemctl restart pve1-dash" to get them back).
[Service]
ProtectSystem=no
ProtectHome=no
PrivateTmp=no
ProtectKernelTunables=no
ProtectKernelModules=no
ProtectControlGroups=no
ReadWritePaths=
EOF
  systemctl daemon-reload
}

# (Re)start the service and wait for /healthz; falls back to the compat drop-in on 226/NAMESPACE.
start_service() {
  local host port url
  read -r host port <<<"$(listen_endpoint)"
  url=$(health_url "$host" "$port")
  systemctl enable "$SERVICE" >/dev/null 2>&1 || :
  systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || :
  systemctl restart "$SERVICE" || :
  if wait_healthy "$url" 60; then
    ok "service running, $url answers"
    return 0
  fi
  if [[ $(systemctl show -p ExecMainStatus --value "$SERVICE" 2>/dev/null) == 226 && ! -f $COMPAT_DROPIN ]]; then
    warn 'the service sandbox is not available in this container (226/NAMESPACE); retrying without it'
    write_compat_dropin
    systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || :
    systemctl restart "$SERVICE" || :
    if wait_healthy "$url" 60; then
      ok "service running without the namespace sandbox ($COMPAT_DROPIN)"
      return 0
    fi
  fi
  warn "the service is not healthy ($url does not answer). Last log lines:"
  journalctl -u "$SERVICE" -n 25 --no-pager >&2 2>/dev/null || :
  return 1
}

# ───────────────────────────────────────────────────────────────────────── helpers for main

file_sum() {
  if [[ -f $1 ]]; then sha256sum "$1" | cut -d ' ' -f 1; else echo missing; fi
}

# https://raw.githubusercontent.com/<owner>/<repo>/<ref> for a GitHub repo URL (same rule as install.sh).
raw_base() {
  local repo=$1 ref=$2 path
  case $repo in
    https://github.com/*) path=${repo#https://github.com/} ;;
    git@github.com:*) path=${repo#git@github.com:} ;;
    *) return 1 ;;
  esac
  path=${path%/}
  path=${path%.git}
  [[ $path =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  printf 'https://raw.githubusercontent.com/%s/%s\n' "$path" "$ref"
}

# Commit id that REF names in REPO (peeled for annotated tags); empty when it cannot be resolved.
remote_commit() {
  local repo=$1 ref=$2 out
  if [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' "$ref"
    return 0
  fi
  out=$(git ls-remote "$repo" "refs/heads/$ref" "refs/tags/$ref" "refs/tags/$ref^{}" 2>/dev/null) || return 1
  awk '$2 ~ /\^\{\}$/ { peeled = $1 } !first { first = $1 } END { print (peeled ? peeled : first) }' <<<"$out"
}

is_ref() { [[ $1 =~ ^[A-Za-z0-9._/-]{1,200}$ && $1 != *..* && $1 != -* ]]; }
is_repo() { [[ $1 =~ ^(https://|git@|file:///)[A-Za-z0-9@:/._~+-]{3,300}$ ]]; }

# Read PVE1_DASH_REPO / PVE1_DASH_REF from install.env (KEY=value lines; values never contain spaces or quotes).
recorded() {
  [[ -f $INSTALL_ENV ]] || return 0
  sed -n "s/^$1=//p" "$INSTALL_ENV" | tail -n 1 | tr -d "\"'"
}

save_install_env() {
  local repo=$1 ref=$2
  umask 022
  printf '# Written by pve1-dash setup/update. Read by pve1-dash-update and install.sh --update-helper.\nPVE1_DASH_REPO=%s\nPVE1_DASH_REF=%s\n' \
    "$repo" "$ref" >"$INSTALL_ENV.tmp"
  mv -f "$INSTALL_ENV.tmp" "$INSTALL_ENV"
}

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

on_error() {
  local code=$?
  if ((BASH_SUBSHELL > 0)); then exit "$code"; fi
  trap - ERR
  warn "the update stopped at line ${1:-?} (exit $code). Unless a step above says otherwise, the installed version is unchanged."
  exit "$code"
}

main() {
  local repo='' ref='' force=0 restart=1 node=1 staging=$APP_DIR.new
  while (($#)); do
    case $1 in
      --ref)
        [[ $# -ge 2 ]] || die '--ref needs a value'
        ref=$2
        shift
        ;;
      --ref=*) ref=${1#*=} ;;
      --repo)
        [[ $# -ge 2 ]] || die '--repo needs a value'
        repo=$2
        shift
        ;;
      --repo=*) repo=${1#*=} ;;
      --force) force=1 ;;
      --no-restart) restart=0 ;;
      --skip-node) node=0 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown option \"$1\" (see --help)" ;;
    esac
    shift
  done
  trap 'on_error $LINENO' ERR
  [[ $EUID -eq 0 ]] || die 'run this as root inside the pve1-dash container.'
  [[ -d $APP_DIR ]] || die "$APP_DIR not found: pve1-dash is not installed here (run deploy/install.sh on the Proxmox host)."
  repo=${repo:-${PVE1_DASH_REPO:-$(recorded PVE1_DASH_REPO)}}
  repo=${repo:-$DEFAULT_REPO}
  ref=${ref:-${PVE1_DASH_REF:-$(recorded PVE1_DASH_REF)}}
  ref=${ref:-main}
  is_repo "$repo" || die "\"$repo\" does not look like a git URL"
  is_ref "$ref" || die "\"$ref\" is not a valid branch, tag or commit"
  exec 9>/run/pve1-dash-update.lock
  flock -n 9 || die 'another update is running'

  local current target
  current=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null) || current=''
  target=$(remote_commit "$repo" "$ref") || target=''
  if ((!force)) && [[ -n $target && $target == "$current" ]]; then
    ok "already up to date ($ref = ${current:0:12})"
    if ((node)); then try_update_node; fi
    exit 0
  fi

  say "updating from ${current:0:12} to $ref${target:+ (${target:0:12})} ..."
  if ((node)); then try_update_node; fi
  fetch_source "$repo" "$ref" "$staging"
  build_release "$staging"

  local helper_before helper_after guest_before guest_after
  helper_before=$(file_sum "$APP_DIR/deploy/helpers/pve1-dash-helper")
  helper_after=$(file_sum "$staging/deploy/helpers/pve1-dash-helper")
  guest_before=$(file_sum "$APP_DIR/deploy/helpers/pve1-dash-guest-inventory")
  guest_after=$(file_sum "$staging/deploy/helpers/pve1-dash-guest-inventory")

  activate_release "$staging"
  install_system_files
  local now version
  now=$(git -C "$APP_DIR" rev-parse --short=12 HEAD)
  version=$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' "$APP_DIR/package.json" | head -n 1)

  if ((restart)); then
    if ! start_service; then
      warn "the new version did not start; restoring ${current:0:12}"
      if rollback_release; then
        install_system_files
        start_service || :
      fi
      die "update to $ref failed and was rolled back. The failed build is kept in $APP_DIR.failed."
    fi
  fi
  # Recorded only once the new version runs, so a rolled-back update keeps the old ref.
  save_install_env "$repo" "$ref"
  ok "pve1-dash ${version:-?} ($now) is installed"

  local base prefix=''
  base=$(raw_base "$repo" "$ref") || base='<raw URL of the repo>'
  # install.sh --update-helper compares the helper with the repo at PVE1_DASH_REF; it reads branch and tag names from
  # install.env itself, but a commit id has to be passed explicitly.
  if [[ $ref =~ ^[0-9a-fA-F]{7,40}$ ]]; then prefix="PVE1_DASH_REF=$ref "; fi
  if [[ $repo != "$DEFAULT_REPO" ]]; then prefix+="PVE1_DASH_REPO=$repo "; fi
  if [[ $helper_before != "$helper_after" ]]; then
    printf '\n'
    warn 'The Proxmox host helper (deploy/helpers/pve1-dash-helper) changed in this update.'
    warn 'Refresh it on the Proxmox host, as root:'
    warn "  ${prefix}bash -c \"\$(curl -fsSL $base/deploy/install.sh)\" -- --update-helper"
  fi
  if [[ $guest_before != "$guest_after" ]]; then
    printf '\n'
    warn 'The guest inventory helper changed. In each VM you added without the guest agent, run again:'
    warn '  curl -fsSL <your dashboard URL>/setup/guest.sh | sh'
  fi
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  main "$@"
fi
