/**
 * GET /setup/guest.sh: a POSIX sh script a user pipes into `sh` inside a VM that has no QEMU guest agent.
 * It installs /usr/local/sbin/pve1-dash-guest-inventory and authorizes the dashboard key for root, pinned to that
 * script with `restrict,command="..."`. The public key is validated strictly before it is embedded, so nothing from
 * it can reach the shell.
 */
import { GUEST_INVENTORY_SCRIPT } from './innerScript.js';

export const GUEST_HELPER_PATH = '/usr/local/sbin/pve1-dash-guest-inventory';
const HEREDOC_DELIMITER = 'PVE1_DASH_GUEST_INVENTORY_EOF';

/** "ssh-ed25519 <68 base64 chars> [comment]"; the comment is limited to a conservative character set. */
const ED25519_LINE_RE = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: ([A-Za-z0-9@._+:=-]+(?: [A-Za-z0-9@._+:=-]+)*))?$/;

/**
 * Validate an OpenSSH ed25519 public key line and return it normalized ("ssh-ed25519 AAAA… [comment]").
 * Throws on anything else, including other key types, multiple lines and shell metacharacters.
 */
export function validateEd25519PublicKey(publicKey: string): { line: string; base64: string } {
  const line = publicKey.trim();
  const m = ED25519_LINE_RE.exec(line);
  if (!m || line.length > 200) throw new Error('invalid public key: expected one line "ssh-ed25519 <base64> [comment]"');
  const blob = Buffer.from(m[1]!, 'base64');
  // SSH wire format: string "ssh-ed25519" (4 + 11 bytes) || string key (4 + 32 bytes)
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString('latin1') !== 'ssh-ed25519' ||
    blob.readUInt32BE(15) !== 32 ||
    blob.toString('base64') !== m[1]
  ) {
    throw new Error('invalid public key: the base64 data is not an ssh-ed25519 key');
  }
  return { line, base64: m[1]! };
}

/** An http(s) URL safe to place in a shell comment and a single-quoted string, or undefined. */
function safePublicUrl(publicUrl?: string): string | undefined {
  if (!publicUrl) return undefined;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const s = url.href.replace(/\/+$/, '');
    return /^[A-Za-z0-9:/?#[\]@!&()*+,;=._~%-]+$/.test(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

export function renderGuestSetupScript(opts: { publicKey: string; publicUrl?: string }): string {
  const { line: keyLine, base64 } = validateEd25519PublicKey(opts.publicKey);
  const authorizedLine = `restrict,command="${GUEST_HELPER_PATH}" ${keyLine}`;
  const url = safePublicUrl(opts.publicUrl);
  const usage = url ? `curl -fsSL '${url}/setup/guest.sh' | sh` : 'curl -fsSL https://<dashboard>/setup/guest.sh | sh';
  if (GUEST_INVENTORY_SCRIPT.split('\n').includes(HEREDOC_DELIMITER)) throw new Error('heredoc delimiter collision');

  // Everything interpolated below is either a constant or validated above (key: [A-Za-z0-9+/ @._:=-] only).
  return `#!/bin/sh
# pve1-dash guest setup: lets the dashboard see the apps and services inside this VM.
#
# Run inside a VM WITHOUT the QEMU guest agent, as root:
#   ${usage}
#
# What it does, and nothing else:
#  1. installs ${GUEST_HELPER_PATH} (root:root, 0755): a read-only script that prints the OS release,
#     running services, Docker containers, IP addresses and listening TCP ports;
#  2. authorizes the dashboard's SSH key for root, pinned to that script:
#       ${authorizedLine}
#     so the key cannot open a shell, forward ports or run any other command;
#  3. checks that sshd accepts key logins for root and prints the config snippet for the dashboard.
# Undo: rm ${GUEST_HELPER_PATH}, and delete the pve1-dash-guest-inventory line from /root/.ssh/authorized_keys.
set -eu

KEY_LINE='${authorizedLine}'
KEY_BASE64='${base64}'
HELPER=${GUEST_HELPER_PATH}
# Testing only: install below this directory instead of /.
P1D_ROOT=\${PVE1_DASH_SETUP_ROOT:-}

say() { printf 'pve1-dash: %s\\n' "$*"; }
die() {
  printf 'pve1-dash: error: %s\\n' "$*" >&2
  exit 1
}

if [ -z "$P1D_ROOT" ] && [ "$(id -u)" != 0 ]; then
  die 'please run this as root, e.g.: curl -fsSL <dashboard>/setup/guest.sh | sudo sh'
fi
umask 022
p1d_tmp=''
p1d_new=''
trap 'rm -f "$p1d_tmp" "$p1d_new"' EXIT

# ── 1. the inventory helper
mkdir -p "$P1D_ROOT/usr/local/sbin"
p1d_tmp=$(mktemp "$P1D_ROOT$HELPER.XXXXXX")
cat >"$p1d_tmp" <<'${HEREDOC_DELIMITER}'
${GUEST_INVENTORY_SCRIPT}${HEREDOC_DELIMITER}
chmod 0755 "$p1d_tmp"
if [ -z "$P1D_ROOT" ]; then chown 0:0 "$p1d_tmp"; fi
mv -f "$p1d_tmp" "$P1D_ROOT$HELPER"
say "installed $HELPER"
if p1d_v=$(SSH_ORIGINAL_COMMAND=version sh "$P1D_ROOT$HELPER" 2>&1); then
  say "self-test: $p1d_v"
else
  die "self-test of $HELPER failed: $p1d_v"
fi

# ── 2. the dashboard key, pinned to the helper
p1d_ssh="$P1D_ROOT/root/.ssh"
p1d_ak="$p1d_ssh/authorized_keys"
mkdir -p "$p1d_ssh"
chmod 700 "$p1d_ssh"
if [ ! -e "$p1d_ak" ]; then : >"$p1d_ak"; fi
chmod 600 "$p1d_ak"
if [ "$(grep -cF "$KEY_BASE64" "$p1d_ak" || :)" = 1 ] && grep -qxF "$KEY_LINE" "$p1d_ak"; then
  say 'the dashboard key is already authorized'
else
  # Drop every other line with this key (an unrestricted copy would allow a shell), then add the pinned line.
  p1d_new=$(mktemp "$p1d_ak.XXXXXX")
  grep -vF "$KEY_BASE64" "$p1d_ak" >"$p1d_new" || :
  printf '%s\\n' "$KEY_LINE" >>"$p1d_new"
  # rewrite in place: keeps owner, mode, SELinux label and symlinks
  cat "$p1d_new" >"$p1d_ak"
  say 'authorized the dashboard key for root in /root/.ssh/authorized_keys (forced command, no shell)'
fi
if [ -z "$P1D_ROOT" ] && command -v restorecon >/dev/null 2>&1; then
  restorecon -R /root/.ssh "$HELPER" >/dev/null 2>&1 || :
fi

# ── 3. sshd
p1d_port=22
p1d_sshd=''
for p1d_p in /usr/sbin/sshd /usr/bin/sshd /sbin/sshd /usr/local/sbin/sshd; do
  if [ -x "$p1d_p" ]; then
    p1d_sshd=$p1d_p
    break
  fi
done
if [ -z "$p1d_sshd" ]; then
  if command -v dropbear >/dev/null 2>&1; then
    say 'note: Dropbear detected; it must support the "restrict" and "command=" key options (2022.82 or newer).'
  else
    say 'WARNING: no OpenSSH server found. Install and enable it, for example:'
    say '  Debian/Ubuntu: apt install openssh-server'
    say '  Alpine:        apk add openssh && rc-update add sshd && rc-service sshd start'
    say '  Fedora/RHEL:   dnf install openssh-server && systemctl enable --now sshd'
  fi
else
  p1d_cfg=$("$p1d_sshd" -T 2>/dev/null || :)
  p1d_prl=$(printf '%s\\n' "$p1d_cfg" | awk 'tolower($1) == "permitrootlogin" { print tolower($2); exit }')
  p1d_pka=$(printf '%s\\n' "$p1d_cfg" | awk 'tolower($1) == "pubkeyauthentication" { print tolower($2); exit }')
  p1d_cfgport=$(printf '%s\\n' "$p1d_cfg" | awk 'tolower($1) == "port" { print $2; exit }')
  case $p1d_cfgport in
    '' | *[!0-9]*) ;;
    *) p1d_port=$p1d_cfgport ;;
  esac
  case $p1d_prl in
    yes | prohibit-password | without-password | forced-commands-only)
      say "sshd accepts key logins for root (PermitRootLogin $p1d_prl)"
      ;;
    no)
      say 'WARNING: sshd has "PermitRootLogin no", which blocks this key. To allow forced-command keys only:'
      say '  echo "PermitRootLogin forced-commands-only" > /etc/ssh/sshd_config.d/00-pve1-dash.conf'
      say '  and reload sshd (systemctl reload ssh, systemctl reload sshd or rc-service sshd reload).'
      say '  This needs "Include /etc/ssh/sshd_config.d/*.conf" near the top of /etc/ssh/sshd_config.'
      ;;
    *)
      say 'could not read the sshd configuration (sshd -T). Make sure root may log in with keys:'
      say '  PermitRootLogin prohibit-password   (or forced-commands-only)'
      ;;
  esac
  if [ "$p1d_pka" = no ]; then say 'WARNING: sshd has "PubkeyAuthentication no"; key logins will fail.'; fi
fi

p1d_addr=$(ip -o -4 addr show scope global 2>/dev/null |
  awk '$2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); print a[1]; exit }') || p1d_addr=''
if [ -z "$p1d_addr" ]; then p1d_addr=$(hostname -I 2>/dev/null | awk '{ print $1 }') || p1d_addr=''; fi
if [ -z "$p1d_addr" ]; then p1d_addr='<address of this VM>'; fi
p1d_fp=''
if command -v ssh-keygen >/dev/null 2>&1 && [ -r /etc/ssh/ssh_host_ed25519_key.pub ]; then
  p1d_fp=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{ print $2 }') || p1d_fp=''
fi

cat <<EOF

Done. Add this VM to /etc/pve1-dash/config.yaml on the dashboard (use the VM's ID from Proxmox):

inventory:
  guests:
    - vmid: <VMID>
      address: $p1d_addr
      port: $p1d_port
      user: root

Then restart the dashboard (systemctl restart pve1-dash).
EOF
if [ -n "$p1d_fp" ]; then
  say "this VM's SSH host key is $p1d_fp (ed25519); the dashboard pins it on first contact."
fi
`;
}
