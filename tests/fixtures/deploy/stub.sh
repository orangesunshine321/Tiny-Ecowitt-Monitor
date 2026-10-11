#!/bin/sh
# Test stand-ins for the Proxmox host tools that deploy/install.sh and deploy/uninstall.sh call
# (tests/deploy-install.test.ts). Invoked through tiny wrappers named after each tool:
#   exec sh stub.sh <tool> "$@"
# Canned output comes from files in $STUB_DIR (the tests copy fixtures there under the names used below); state such
# as "the user exists" lives there too. Every call is appended to $STUB_DIR/calls.log.
# Output formats follow docs/research/pve-perms-cli.md (pveam §5.6, pvesm §5.7, pvesh §5.8, pveum §4, pveversion §8).
set -u
tool=$1
shift
d=${STUB_DIR:?STUB_DIR is not set}
printf '%s %s\n' "$tool" "$*" >>"$d/calls.log"

out() {
  if [ -f "$d/$1" ]; then cat "$d/$1"; else return 1; fi
}

case $tool in
  pveversion) out pveversion.txt ;;
  hostname)
    if [ "${1-}" = -I ]; then out hostname-I.txt; else out hostname.txt; fi
    ;;
  ip)
    case "$*" in
      "-4 route get "*) out ip-route-get.txt || exit 2 ;;
      "-4 route show default") out ip-route-default.txt || : ;;
      *) exit 2 ;;
    esac
    ;;
  pveam)
    case ${1-} in
      # pveam update exits 0 even when it fails; only the text differs.
      update) out pveam-update.txt || echo 'update successful' ;;
      available) out pveam-available.txt ;;
      list) out "pveam-list-$2.txt" || {
        echo "storage '$2' does not exist" >&2
        exit 255
      } ;;
      download)
        if [ -f "$d/pveam-download-fails" ]; then
          echo 'TASK ERROR: download failed'
          exit 0
        fi
        printf 'downloading ...\nTASK OK\n'
        printf '%-60s %-4.2fMB\n' "$2:vztmpl/$3" 123.00 >>"$d/pveam-list-$2.txt"
        ;;
      *) exit 2 ;;
    esac
    ;;
  pvesm)
    if [ "${1-}" != status ] || [ "${2-}" != --content ]; then exit 2; fi
    out "pvesm-status-$3.txt"
    ;;
  pvesh)
    case "$*" in
      "get /cluster/nextid") out pvesh-nextid.txt ;;
      "get /cluster/nextid --vmid "*)
        if grep -qx "$4" "$d/used-ids.txt" 2>/dev/null; then
          echo "VM $4 already exists" >&2
          exit 255
        fi
        echo "$4"
        ;;
      "get /nodes/"*"/lxc --output-format json") out pvesh-lxc.json ;;
      "get /cluster/resources --type vm --output-format json") out pvesh-resources.json || exit 2 ;;
      *)
        echo "stub pvesh: unexpected: $*" >&2
        exit 2
        ;;
    esac
    ;;
  pveum)
    case "${1-} ${2-}" in
      "user add")
        if [ -f "$d/user-exists" ]; then
          echo "create user failed: user '$3' already exists" >&2
          exit 255
        fi
        : >"$d/user-exists"
        ;;
      "user token")
        case ${3-} in
          list) out pveum-token-list.json || echo '[]' ;;
          add)
            if [ -f "$d/token-exists" ]; then
              echo 'tokenid: Token already exists.' >&2
              exit 255
            fi
            out pveum-token-add.json
            ;;
          remove)
            if [ -f "$d/no-remove-verb" ]; then
              echo "unknown command 'pveum user token remove'" >&2
              exit 255
            fi
            rm -f "$d/token-exists"
            ;;
          delete) rm -f "$d/token-exists" ;;
          *) exit 2 ;;
        esac
        ;;
      "acl modify") : ;;
      "user delete" | "user remove")
        if [ -f "$d/no-user-delete" ]; then
          echo "unknown command 'pveum user $2'" >&2
          exit 255
        fi
        rm -f "$d/user-exists" "$d/pveum-token-list.json"
        ;;
      *)
        echo "stub pveum: unexpected: $*" >&2
        exit 2
        ;;
    esac
    ;;
  openssl)
    if [ -f "$d/openssl.txt" ]; then cat "$d/openssl.txt"; else exec "${REAL_OPENSSL:?}" "$@"; fi
    ;;
  pct)
    case ${1-} in
      exec) out pct-exec.txt || exit 1 ;;
      status) out "pct-status-$2.txt" || exit 255 ;;
      config) out "pct-config-$2.txt" || exit 255 ;;
      start)
        # A failing start prints the reason, like the start task does.
        if [ -f "$d/pct-start-fails" ]; then
          cat "$d/pct-start-fails" >&2
          exit 255
        fi
        ;;
      *) : ;;
    esac
    ;;
  *)
    echo "stub: unknown tool $tool" >&2
    exit 127
    ;;
esac
