/**
 * The inner guest inventory script (helper protocol v1, docs/HELPER_PROTOCOL.md) as TypeScript constants.
 *
 * The same text lives in three places and must stay byte-identical (tests/inventory-scripts.test.ts checks it):
 *  - deploy/helpers/pve1-dash-guest-inventory  (GUEST_WRAPPER + INNER_SCRIPT, installed in VMs without the agent)
 *  - deploy/helpers/pve1-dash-helper           (INNER_SCRIPT in a quoted heredoc, run via pct exec / qm guest exec)
 *  - this file                                 (used by guestSetup.ts to render GET /setup/guest.sh)
 * Edit deploy/helpers/pve1-dash-guest-inventory first, then copy the changes here and into pve1-dash-helper.
 */

export const HELPER_PROTOCOL_VERSION = 1;
export const INNER_BEGIN_MARKER = '# >>> pve1-dash inner v1 >>>';
export const INNER_END_MARKER = '# <<< pve1-dash inner v1 <<<';

/** POSIX sh; prints the ##pve1-dash: sections. Runs as `sh -c "$INNER"` or inline after GUEST_WRAPPER. */
export const INNER_SCRIPT = `# >>> pve1-dash inner v1 >>>
# Inventory of this guest for pve1-dash (helper protocol v1). Read-only and POSIX sh, so it runs under dash, bash and
# busybox. Every section is optional: a missing tool leaves its section empty. This exact text is also embedded in
# pve1-dash-helper (run via pct exec / qm guest exec) and in server/inventory/innerScript.ts; keep all three identical.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
LC_ALL=C
export PATH LC_ALL
# Bound every probe so a hung daemon (docker, systemd, ...) cannot stall the whole inventory.
p1d_t=''
if command -v timeout >/dev/null 2>&1 && timeout 5 true >/dev/null 2>&1; then p1d_t='timeout 15'; fi
p1d_has() { command -v "$1" >/dev/null 2>&1; }
p1d_sec() { printf '##pve1-dash:section %s\\n' "$1"; }
# Print text followed by exactly one newline; print nothing for empty text.
p1d_put() { if [ -n "$1" ]; then printf '%s\\n' "$1"; fi; }
# Run a probe (stderr dropped) and print its stdout.
# shellcheck disable=SC2086 # $p1d_t is intentionally split into "timeout 15"
p1d_run() { p1d_o=$($p1d_t "$@" 2>/dev/null) || :; p1d_put "$p1d_o"; }

printf '##pve1-dash:inventory v1\\n'

p1d_sec os-release
for p1d_f in /etc/os-release /usr/lib/os-release; do
  if [ -r "$p1d_f" ]; then
    p1d_put "$(cat "$p1d_f" 2>/dev/null)"
    break
  fi
done

p1d_sec kernel
p1d_run uname -r

p1d_sec uptime
p1d_put "$(cat /proc/uptime 2>/dev/null)"

p1d_sec loadavg
p1d_put "$(cat /proc/loadavg 2>/dev/null)"

p1d_sec init
if [ -d /run/systemd/system ]; then
  p1d_init=systemd
elif [ -d /run/openrc ] || p1d_has openrc-run || p1d_has rc-status; then
  p1d_init=openrc
else
  p1d_init=unknown
fi
printf '%s\\n' "$p1d_init"

p1d_sec services
case $p1d_init in
  systemd)
    p1d_run systemctl list-units --type=service --state=running --no-legend --no-pager --plain
    ;;
  openrc)
    # shellcheck disable=SC2086
    p1d_o=$($p1d_t rc-status --servicelist 2>/dev/null) || p1d_o=''
    # shellcheck disable=SC2086
    [ -n "$p1d_o" ] || p1d_o=$($p1d_t rc-status -s 2>/dev/null) || p1d_o=''
    p1d_put "$p1d_o"
    ;;
esac

p1d_sec docker
if p1d_has docker; then
  echo present
  p1d_run docker ps -a --no-trunc --format '{{json .}}'
else
  echo absent
fi

p1d_sec ip
p1d_o=''
# shellcheck disable=SC2086
if p1d_has ip; then p1d_o=$($p1d_t ip -o addr show 2>/dev/null) || p1d_o=''; fi
# shellcheck disable=SC2086
if [ -z "$p1d_o" ] && p1d_has ifconfig; then p1d_o=$($p1d_t ifconfig 2>/dev/null) || p1d_o=''; fi
p1d_put "$p1d_o"

p1d_sec listen
p1d_o=''
if p1d_has ss; then
  # shellcheck disable=SC2086
  p1d_o=$($p1d_t ss -Hltnp 2>/dev/null) || p1d_o=''
  # old iproute2 has no -H; the parser skips the header line
  # shellcheck disable=SC2086
  [ -n "$p1d_o" ] || p1d_o=$($p1d_t ss -ltnp 2>/dev/null) || p1d_o=''
fi
if [ -z "$p1d_o" ] && p1d_has netstat; then
  # shellcheck disable=SC2086
  p1d_o=$($p1d_t netstat -ltnp 2>/dev/null) || p1d_o=''
  # some busybox builds have no -p
  # shellcheck disable=SC2086
  [ -n "$p1d_o" ] || p1d_o=$($p1d_t netstat -ltn 2>/dev/null) || p1d_o=''
fi
p1d_put "$p1d_o"

printf '##pve1-dash:end\\n'
exit 0
# <<< pve1-dash inner v1 <<<
`;

/** Header of pve1-dash-guest-inventory: validates SSH_ORIGINAL_COMMAND ("inventory" | "version"). */
export const GUEST_WRAPPER = `#!/bin/sh
# pve1-dash-guest-inventory: read-only forced-command helper for pve1-dash (helper protocol v1, docs/HELPER_PROTOCOL.md).
#
# Install at /usr/local/sbin/pve1-dash-guest-inventory (root:root, 0755) inside a VM WITHOUT the QEMU guest agent and
# authorize the dashboard key for root, pinned to this script:
#   restrict,command="/usr/local/sbin/pve1-dash-guest-inventory" ssh-ed25519 AAAA... pve1-dash
# The dashboard serves an installer that does both: curl -fsSL https://<dashboard>/setup/guest.sh | sh
#
# sshd ignores the command the client asked for and passes it here as SSH_ORIGINAL_COMMAND (never evaluated).
# Allowed: "inventory" (the default) and "version". Anything else prints "denied" on stderr and exits 1.
# Root can also run it by hand: pve1-dash-guest-inventory [inventory|version]
set -u

p1d_cmd=\${SSH_ORIGINAL_COMMAND:-\${1:-inventory}}
case $p1d_cmd in
  inventory) ;;
  version)
    echo 'pve1-dash-guest-inventory 1'
    exit 0
    ;;
  *)
    echo 'denied' >&2
    exit 1
    ;;
esac

`;

/** The complete /usr/local/sbin/pve1-dash-guest-inventory script. */
export const GUEST_INVENTORY_SCRIPT = GUEST_WRAPPER + INNER_SCRIPT;
