---
name: pve1-dash-troubleshoot
description: Use when something about the pve1-dash dashboard is wrong or unclear, for example the page won't load through dash.bgreen.cloud (403/421/502), live updates stall, the node shows offline or token/TLS errors, apps/services/Docker stay empty, push doesn't arrive on the iPhone, alerts look wrong, the service restart-loops, or an update/install failed. Starts with pve1-dash-doctor and goes one or two read-only steps at a time, confirming with the owner before any change. For a live problem on pve1; code fixes go to pve1-dash-develop. Also use for changing a dashboard setting with pve1-dash-config (service launcher tiles, hidden or overridden services, alert rules and thresholds, polling intervals, board title), confirming with the owner first.
---

# Troubleshooting pve1-dash

The symptom-first guide is `docs/TROUBLESHOOTING.md`. This skill is the triage method that goes with it.
**host** = pve1 as root; **CT** = run through `pct exec <ctid> -- ...` from the host; **LAN** = a machine on
10.10.10.0/24.

## How to work

1. **One or two steps at a time.** Run a read-only check, show the owner what it said in plain words, say what you
   think it means and what you would check next, then **stop and wait** for their feedback.
2. **Read-only first.** Collect evidence before proposing any fix. Never guess. If the evidence doesn't explain the
   symptom, say so.
3. **Confirm before changing anything** on the host, in the container or in any other guest (VM or CT): config
   edits, restarts, updates, helper refresh, token rotation, `pct set`, network or package changes. Name the exact
   command and what it changes.
4. **One change, then verify** by re-running the doctor (or the check that failed). If it didn't help, undo it before
   trying the next idea.
5. Never paste secrets into the chat: no token file, no private keys, no `push.json`, no owner email.

## Step 0: find the container and run the doctor

```bash
pvesh get /nodes/pve1/lxc --output-format json        # host: the CT whose tags contain pve1-dash
pct exec <ctid> -- pve1-dash-doctor --brief           # host: read-only, works while the service is down
```

If the short form can't find the tool or `runuser`, use the installer's form:
`pct exec <ctid> -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 TERM=dumb NO_COLOR=1 pve1-dash-doctor`.
(Whether plain `pct exec` sets that PATH is unverified.)

Reading the output:

- Checks are grouped CONFIG → PROXMOX → SSH INVENTORY → SERVICES → PUSH → SYSTEM. Look at the **first ✗**: in the
  Proxmox group, later checks are skipped once one fails.
- Under each problem is a `fix:` block. Read each whole comment, not only an `# On` prefix: it says where the lines
  after it run, up to the next comment. `# On the Proxmox host` runs on the host; `# On the guest` or `# On VM <id>`
  runs inside that guest, never in the CT; `# From the dashboard container`, `# In the dashboard container` and
  unlabelled lines run in the CT. Whatever comment comes before them, these always run on the **host**: the installer
  one-liner (`bash -c "$(curl ... install.sh)"`, with or without `--update-helper`, with any `PVE1_DASH_*=` prefix;
  the owner runs it in their own terminal) and `pveum`, `pct`, `qm` and `pvecm` commands. Known case: the `pve.auth`
  (HTTP 401) block's comment says "Create a new secret and store it in the container (the installer does both)", but
  its installer line runs on the host; inside the CT it stops with "pveversion not found". A fix is a proposal for
  the owner, not something to run unasked.
- Exit 0 means nothing failed (warnings allowed), 1 means a check failed, 2 is a usage error, 3 means the doctor crashed.
- Options: `--json` (raw), `--quick` (skip the reverse-proxy and push round trips), `--no-live` (don't ask the running
  service).
- Doctor-only checks: `proxy.*` (needs an https `publicUrl`, and the CT must resolve dash.bgreen.cloud),
  `config.running`, `system.service`, `system.version`. `system.version` only compares the version 0.1.0, so use the
  commit (see below) to tell builds apart.

## Evidence commands (all read-only)

| Where | Command | Shows |
|---|---|---|
| host | `pct exec <ctid> -- systemctl status pve1-dash --no-pager` | service state, restarts |
| host | `pct exec <ctid> -- journalctl -u pve1-dash -n 100 --no-pager` | log lines `[warn]/[error] pve1-dash/<scope>:` (scopes: http, proxmox, inventory, host-helper, ssh, health, alerts, push) |
| host | `pct exec <ctid> -- curl -s http://127.0.0.1:8080/healthz` | `{"ok":true}` means the process is listening, nothing more |
| host | `pct exec <ctid> -- cat /etc/pve1-dash/install.env` | recorded repo, ref and CTID |
| host | `pct exec <ctid> -- git -C /opt/pve1-dash rev-parse HEAD` | exact deployed commit |
| host | `pct exec <ctid> -- pve1-dash-config --check` | config validity with line numbers (runs as root, so it misses files pve1dash can't read; the doctor catches those). It prompts every time because it matches an ask rule; that's expected |
| host | `pct exec <ctid> -- ls -la /etc/pve1-dash /etc/pve1-dash/ssh /var/lib/pve1-dash` | owners and modes (config and token `root:pve1dash 0640`, key and known_hosts `pve1dash 0600`) |
| host | `tail -n 200 /var/log/pve1-dash-install.log` · `head -n 120 /var/log/pve1-dash-helper.diff` | installer log (incl. in-CT setup; thousands of lines, so never dump it whole), last helper diff |
| host | `SSH_ORIGINAL_COMMAND=version /usr/local/sbin/pve1-dash-helper` | `pve1-dash-helper 2` |
| host | `journalctl -t pve1-dash-helper` | commands the helper denied (unverified invocation) |
| host | `grep -n 'pve1-dash' /root/.ssh/authorized_keys` | one line per dashboard, containing `restrict` and `command="/usr/local/sbin/pve1-dash-helper"` (options the owner added, such as `from=`, may come first) |
| host | `pveum user token permissions pve1dash@pve dashboard --path /` | token privileges (unverified on a real host) |
| host | `openssl s_client -connect 127.0.0.1:8006 </dev/null 2>/dev/null \| openssl x509 -noout -fingerprint -sha256` | the cert pveproxy serves (for TLS pin mismatches) |
| LAN | `curl -s -o /dev/null -w '%{http_code}\n' https://dash.bgreen.cloud/api/snapshot` | 200 ok · 403 allowedSources or NPM's Access List (read the body) · 421 host gate · 502 NPM can't reach the CT |

Notes:

- The container has no `jq`. Parse JSON on the **host** with Perl (JSON::PP is part of core Perl, and the installer
  needs Perl anyway), or in the CT with `/usr/local/bin/node -e`.
- At the default log level a repeating collector error is logged **once**, so a quiet journal doesn't mean it
  recovered. Check Settings → Data sources in the app (`/settings#data-sources`).
- `.claude/settings.json` **denies on purpose** any `pct exec` command that names `/etc/pve1-dash/token`,
  `/var/lib/pve1-dash/push.json` or ends with `/etc/pve1-dash/ssh/id_ed25519`, even read-only ones such as the
  doctor's `ls -l /etc/pve1-dash/token` fix line. Use the `ls -la` row above and the doctor's `config.file`,
  `ssh.keys` and `push.devices` checks instead. The TROUBLESHOOTING helper test
  (`pct exec <ctid> -- runuser -u pve1dash -- ssh -i /etc/pve1-dash/ssh/id_ed25519 ...`) prompts every time. Repairs on
  those files, such as the `push.json` `chown`/`chmod`, go to the owner (`pct enter <ctid>`). Don't work around the
  denials.

## Reading /api/diagnostics

This is the same check engine as the doctor plus the live-only checks (`collectors.*`, `http.hosts`, `http.sources`,
`http.request`). Loopback always passes the access gates:

```bash
# host: list everything that is not ok
pct exec <ctid> -- curl -s --max-time 40 'http://127.0.0.1:8080/api/diagnostics?fresh=1' \
  | perl -CO -MJSON::PP -0777 -ne 'for (@{decode_json($_)->{checks}}) { print "$_->{status}\t$_->{id}\t$_->{detail}\n" unless $_->{status} eq "ok" }'
```

- The report is `{generatedAt, appVersion, checks: [{id, group, title, status: ok|warn|fail|skip, detail, fix?, docs?}]}`.
- Results are cached for 15 s. `?fresh=1` still reuses a report less than 3 s old. A run longer than 30 s returns 504.
- `http.request` is omitted for loopback requests. To see how NPM's requests arrive, use the web page instead:
  Settings → Diagnostics (`https://dash.bgreen.cloud/settings#diagnostics`), which also has "This device" checks and
  Copy Report.

## Symptom map

| Symptom | First evidence | Section in `docs/TROUBLESHOOTING.md` |
|---|---|---|
| 403 through dash.bgreen.cloud | 403 body / `journalctl ... \| grep 'refused a connection'`: a body naming `listen.allowedSources` or "Not allowed from this network" means NPM's IP isn't in it; any other 403 page comes from NPM's Access List | `#-forbidden-http-403` |
| 421 "Unknown host" | `pct exec <ctid> -- grep -n -e publicUrl -e allowedHosts /etc/pve1-dash/config.yaml` (must be `https://dash.bgreen.cloud`) | `#-unknown-host-http-421` |
| 502 from NPM | CT IP changed (DHCP)? `pct exec <ctid> -- ip -4 addr show eth0` vs the NPM forward | `#-installer-problems` (502 after a reboot) |
| Live dot not green, "Can't reach the dashboard" | LAN: `curl -sN --max-time 5 https://dash.bgreen.cloud/api/stream \| head -c 300`; NPM Cache Assets / Advanced tab | `#-live-updates-stop-or-never-start-sse-through-the-proxy` |
| Node offline, 401/403 from Proxmox | doctor `pve.auth`, `pve.permissions`; (host) `pveum user token list pve1dash@pve`; the token file's size, owner and mode in `pct exec <ctid> -- ls -la /etc/pve1-dash` (never print the file). Token steps 2-3 in that section show or use the secret, so they are owner-only | `#-token-401403` |
| TLS errors after a cert renewal | doctor `pve.tls`; fingerprint command above. If `:8006` now has an ACME cert, a re-run pins it again and that breaks at the next renewal, and `PVE1_DASH_PVE_HOST` only applies to a new config: use the manual switch in the install skill, section 7 (remove `ca:` or `fingerprint:`, not only `fingerprint:` as the doc says). For an ACME cert, the doctor's `fix:` block (its `sed`, and its installer re-run) pins the cert too, so use it only as a temporary pin with the owner's OK while the switch is finished (install skill, section 7) | `#-tls-fingerprint-mismatch-after-a-certificate-renewal` |
| Apps / services / Docker empty | doctor `ssh.host`; helper self-test; `journalctl -t pve1-dash-helper`. That section's step 1 expects `pve1-dash-helper 1`, but the correct answer is `pve1-dash-helper 2` (doc drift), so `2` means the SSH side is fine: go to its step 4, not to an `--update-helper`. In `pve1-dash-helper inventory <vmid>`, a stopped guest or a VM without the agent enabled prints no block at all (only the header and `@@pve1-dash:done`), so check `qm config <vmid> \| grep ^agent` next | `#-helper-denied-or-apps--services-stay-empty` |
| Guest host key mismatch | doctor `ssh.guests` | `#-ssh-host-key-changed` (run `ssh-keygen -R` as `runuser -u pve1dash --`, or `chown pve1dash:pve1dash` afterwards; as root it leaves `known_hosts` root-owned) |
| VM shows no IP or no apps | guest agent enabled? PVE 8 vs 9; `qm guest cmd <vmid> ping` is read-only but prompts every time | `#-guest-agent-vm-shows-no-ip-or-no-apps` |
| No push on the iPhone | doctor `push.*`; Home Screen app?; Settings → Notifications → Send test. If the test arrives but real alerts don't, check this device's filters in Settings → Notifications (alert kinds, where `updates_available` is off by default; Minimum severity, default warning; Recoveries; Quiet hours, which let only fresh critical alerts through), whether the alert was snoozed, whether it is still in a post-restart grace window, and whether it shows on the Alerts page at all. The test skips all of these | `#-push-notifications-dont-arrive-on-iphone` |
| "config INVALID" / running on last good config | `pve1-dash-config --check` | `#-a-config-mistake-config-invalid-or-running-with-the-last-good-configuration` |
| Service restart-loops every 5 s | journal: a missing `config.yaml` or a bad/unreadable token file is **not** covered by the last-good fallback | `#-first-checks` |
| `status=226/NAMESPACE` or `EPERM` | journal; `/etc/systemd/system/pve1-dash.service.d/10-lxc-compat.conf` | `#-installer-problems` |
| Alert times off by hours | `timezone:` in the config (only set on a new config) | `#-times-in-alerts-are-off-by-some-hours` |
| Temperatures missing | lm-sensors installed on the host? | `#-temperatures-are-missing` |
| Update failed / "only N MiB free" | update output; `/opt/pve1-dash.failed` | `#-installer-problems` |
| Alerts seem late right after a restart | not a bug: grace windows. After a dashboard restart: discovered services 10 min, backup coverage 30 min. After pve1 boots: onboot guests get 10 min before a stop is judged. After a guest boots: health checks don't count it down for 120 s | `docs/HANDOFF.md` |

## Changes that come up often (each one needs the owner's OK)

- **Config edit** (CT), also for routine setting changes (launcher tiles in `services.items`,
  `services.hide`/`overrides`, `alerts.rules`, `polling`, `board`; every key is in `deploy/config.example.yaml`): the
  owner runs `pct enter <ctid>` and then `pve1-dash-config`. It validates before saving and restarts. To do it without a terminal (host): write a
  script that edits the file path given as its first argument, copy it in with
  `pct push <ctid> <host file> /root/p1d-edit.sh --perms 0755`, run
  `pct exec <ctid> -- env VISUAL=/root/p1d-edit.sh EDITOR=/root/p1d-edit.sh setsid -w pve1-dash-config`, then
  `pct exec <ctid> -- rm /root/p1d-edit.sh`. Set both variables: the tool prefers `$VISUAL`, and `pct exec` passes the
  host's through. `setsid -w` avoids the "edit again?" loop on a failed check.
- **Restart** (CT): `pct exec <ctid> -- systemctl restart pve1-dash`.
- **Manual rollback** (only one generation is kept, in `/opt/pve1-dash.prev`):
  `pct exec <ctid> -- git -C /opt/pve1-dash.prev rev-parse HEAD`, then
  `pct exec <ctid> -- pve1-dash-update --ref <that full sha>` (an unverified sequence; give it the Bash tool's maximum
  timeout, see `CLAUDE.md` → Gotchas). There is no rollback command.
  This pins the container to that commit (later plain updates say "already up to date"); once main is fixed, move it
  back with `pct exec <ctid> -- pve1-dash-update --ref main`.
- Before `pct exec <ctid> -- pve1-dash-update`, make sure `PVE1_DASH_REF` and `PVE1_DASH_REPO` are not exported in the
  host shell, because `pct exec` passes the host environment through. Run every update with the Bash tool's maximum
  timeout or in the background (`CLAUDE.md` → Gotchas).
- **Restore `authorized_keys`** (host, destructive, **owner-run**): first show the difference (read-only):
  `diff /root/.ssh/authorized_keys.pve1-dash.bak /root/.ssh/authorized_keys`. The backup is from the last installer
  or uninstaller run, and every run overwrites it, so restoring it drops every key added since, the owner's included,
  in the cluster-wide file. If the owner still wants it, they run
  `cat /root/.ssh/authorized_keys.pve1-dash.bak > /root/.ssh/authorized_keys` in their own SSH/xterm.js shell (it
  writes through the symlink; never replace the link itself). Claude must not run it: it is owner-only, and the Edit
  deny rules for `/root/.ssh` and `/etc/pve` in `.claude/settings.json` show the intent, although they don't
  technically block a Bash redirection. Don't work around that.

## Collecting a log bundle for the owner

Run these and summarize the results. Don't attach raw secrets:

- `pct exec <ctid> -- pve1-dash-doctor --brief --no-color`
- `pct exec <ctid> -- journalctl -u pve1-dash -n 300 --no-pager`
- `pct exec <ctid> -- cat /etc/pve1-dash/install.env`
- `pct exec <ctid> -- git -C /opt/pve1-dash rev-parse HEAD`
- the tail of `/var/log/pve1-dash-install.log`
- `pveversion`

Check all of it for the owner's email (`vapidSubject`, a `mailto:` line; the full doctor shows it in the PUSH group)
and redact it wherever it appears before quoting.

If a fix needs a code change, switch to the `pve1-dash-develop` skill.
