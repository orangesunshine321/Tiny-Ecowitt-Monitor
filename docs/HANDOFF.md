# 🤝 Handoff: pve1-dash, before the first install

This page is for whoever picks up pve1-dash next, most likely a Claude Code session running on the Proxmox host
**pve1**. It records the project's state, the decisions and their reasons, what has never touched real hardware, and
what is left to do. It links to the other docs instead of repeating them.

## 🧰 Bootstrap on pve1 (owner, host)

git and Claude Code are not on Proxmox VE by default. The owner runs this once as root in their own SSH or xterm.js
shell. The native installer needs no Node.js, so nothing Node-related lands on the hypervisor:

```bash
apt update && apt install -y git        # add gh too if the agent should push from the host (see the develop skill)
git clone https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor.git /root/Tiny-Ecowitt-Monitor
curl -fsSL https://claude.ai/install.sh | bash   # Claude Code's native installer; open a new shell if `claude` isn't found
cd /root/Tiny-Ecowitt-Monitor && claude          # log in when asked
```

If `apt update` fails with 401 from `enterprise.proxmox.com` (no subscription), enable the `pve-no-subscription`
repository first (node → Updates → Repositories), then run the first line again. Before the first commit from any
checkout, set a repo-local author identity (develop skill → GitHub credentials).

The project's `.claude/settings.json` starts sessions in **Manual** mode and sets `"disableAutoMode": "disable"` (and
`disableBypassPermissionsMode`), so auto mode is removed from the Shift+Tab cycle. That lock and the ask/deny rules
load only when `claude` starts in the checkout's root, as above; never start it in a subdirectory or `/cd` into one.
If the owner ever creates `.claude/settings.local.json` by hand, add `**/.claude/settings.local.json` to
`~/.config/git/ignore` first: the repo's `.gitignore` doesn't list it, and Claude Code excludes it automatically only
when it writes the file itself. For development in a separate container instead (recommended), see option A in the
`pve1-dash-develop` skill.

## ▶️ Start here

1. `CLAUDE.md` (loaded automatically) has the hard rules, the three places commands run, and the shipping flow. The
   skills in `.claude/skills/` cover the details: `pve1-dash-install`, `pve1-dash-troubleshoot` and `pve1-dash-develop`.
2. Check that GitHub `main` has the current code, because the one-line installer installs `main`. Both commands run
   on the host and are read-only:
   ```bash
   git fetch origin && git log --oneline -5 origin/main
   curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh | grep -c PVE1_DASH_ALLOWED_SOURCES   # must be > 0
   ```
   If the count is 0, `main` still holds the first release (`ee7818d`) without the doctor, the config tool,
   `allowedSources` and helper protocol v2. Tell the owner before anything is installed.
   Every session: if this checkout is behind `origin/main` (`git status -sb`), update it with
   `git switch main && git pull --ff-only` (ask first if it has local changes), then restart `claude` so it loads the
   current `CLAUDE.md`, skills and settings.
3. Ask the owner what they want to do: the first install, a problem, or a change. Then ask the
   [open questions](#-open-questions-for-the-owner) that the task depends on.

## 📍 State as of this handoff

- **Version:** `package.json` says `0.1.0` for every build, and there are no pve1-dash release tags. Identify a
  deployed build by its commit: `pct exec <ctid> -- git -C /opt/pve1-dash rev-parse HEAD`. The only tag in the repo,
  `1.0`, is the old Tiny Ecowitt Windows app, so never install it.
- **Code:** complete. The pre-install improvement round was developed on `claude/homelab-dashboard-pve1-dizt16`
  (last code commit `afd742a`) and went into `main` through PR #2, together with this handoff kit (step 2 above
  checks that `main` has it). PR #2 was **squash-merged**, so `main` has the whole round as one commit; the
  individual commits named below are only on that branch. That branch
  name is hard-coded as the old pre-merge branch in `deploy/install.sh` and `deploy/update.sh`, so never reuse it.
- **Tests:** 76 vitest files. The last full run had 1402 passed and 3 skipped (2 for missing shellcheck, 1 because it
  ran as root). Typecheck was clean. There is no CI.
- **Real hardware:** never installed. The first install on pve1 is the next step.

## 🏗️ What was built

| Round | Commits | What |
|---|---|---|
| Rebuild | `6ace15e` → `ee7818d` (PR #1) | The repo was cleared of the old app. Scaffold, research and contract (`9034517`), the full build (`5e14b09`), fixes for 77 verified review findings (`b16cf74`), README screenshots. |
| Matrix theme | `03e0c7a` | Green-phosphor Liquid Glass theme with digital rain and a boot sequence. |
| Pre-install round | `d5d9310` → `afd742a` (PR #2) | 72 discovery findings worked through in parallel streams: S1a restart-safe alerts, snooze and new kinds; S1b SSE history ticks and the host/source gates; S2 Proxmox robustness and per-guest backup failures; S3 helper protocol v2; S4 deploy (doctor, `pve1-dash-config`, CA instead of pin, allowedSources); S5 diagnostics; W1–W3 web. Then 14 fixes from a final verification pass. |

The feature list is in [README.md](../README.md#-features). Themes are System, Light, Dark and Matrix.

## 🧭 Decisions and why

- **Read-only by design.** No power, console, snapshot or config features. Console buttons deep-link to Proxmox.
  The reasons and the threat model are in [SECURITY.md](SECURITY.md).
- **`PVEAuditor` only, never `VM.Monitor`.** On PVE 8, `VM.Monitor` allows guest-agent exec and file read/write.
  `Sys.Modify` is not read-only either. So pending updates come from `/var/lib/pve-manager/pkgupdates` through the
  SSH helper, and backup file lists come through it too, because PVE hides them from audit-only tokens.
  ([SECURITY.md → The API token](SECURITY.md#the-api-token))
- **One SSH key, pinned with `restrict,command=` to a root helper** that has a fixed allow-list (protocol v2).
  ([HELPER_PROTOCOL.md](HELPER_PROTOCOL.md))
- **No login, LAN only.** `listen.allowedSources` checks the TCP peer, never `X-Forwarded-For`. Loopback and `/healthz`
  are exempt. The Host gate (HTTP 421) only switches on when `publicUrl` or `allowedHosts` is set.
  ([SECURITY.md → LAN only](SECURITY.md#lan-only-no-login))
- **TLS to Proxmox uses the cluster CA by default**, because a fingerprint pin breaks at Proxmox's automatic renewal.
  The pin is the fallback, and a public CA is used for ACME certs. ([SETUP.md](SETUP.md#-the-one-liner))
- **Node.js 24 LTS from the nodejs.org tarball**, checked against `SHASUMS256.txt`, inside the container only (never
  on the host). The research notes had suggested Debian's `nodejs` package. The repo does not record why the tarball
  won, so ask before changing it. ([SECURITY.md → Supply chain](SECURITY.md#supply-chain-and-updates))
- **The container builds from git.** Updates fetch the recorded ref, build next to the running copy, swap, and roll
  back on a failed `/healthz`. The one-liner always comes from `main`.
- **Restart-safe alerts.** State lives in `/var/lib/pve1-dash/alerts.json`, so a restart neither re-fires nor
  resolves alerts. The grace windows are deliberate. After a dashboard restart: discovered services 10 min, backup
  coverage 30 min. After pve1 boots: onboot guests get 10 min before a stop is judged. After a guest boots: health
  checks don't count it down for 120 s.
- **Design:** Apple "Liquid Glass" (glass for chrome, not content), Safari-first, Declarative Web Push, and a
  split-flap departure board. See [DESIGN.md](DESIGN.md) (written before the Matrix theme) and `docs/research/`.
- **Demo mode** mocks PVE **9.0.10** only, so PVE 8 code paths were never run end to end.

## 🧪 Never tested on real hardware

The main list is [TROUBLESHOOTING.md → Things that could not be tested on real Proxmox](TROUBLESHOOTING.md#-things-that-could-not-be-tested-on-real-proxmox).
It covers `pct push/pull/set`, the `authorized_keys` rename inside pmxcfs, `pveum token remove` vs `delete`, systemd
sandboxing in an unprivileged LXC, and iOS details. Also unverified:

- PVE 8 end to end
- the NPM-specific advice (taken from NPM's source, not run in NPM)
- ssh2 against OpenSSH 10
- whether `pct exec <ctid> -- pve1-dash-doctor` finds `runuser` without an explicit PATH
- running the test suite as root on a Proxmox host

## 👀 First-install watch-list

1. `main` has the current code (see Start here).
2. The installer runs in the owner's SSH or xterm.js terminal, not the web Shell panel. It takes 5-10 minutes, and a
   re-run continues where it stopped.
3. `allowedSources` must include NPM's IP. If it doesn't, every page through `dash.bgreen.cloud` returns 403 while
   `/healthz` still returns 200.
4. Set `publicUrl: https://dash.bgreen.cloud`. Push links and the 421 gate depend on it.
5. The container IP must not move: use a static IP or a DHCP reservation, because NPM forwards to it.
6. NPM settings: Cache Assets OFF, HTTP/2 ON, and no `location` block in the Advanced tab
   ([recipe](../deploy/reverse-proxy/README.md#nginx-proxy-manager)). NPM trusts `X-Real-IP` from every private
   address, so a client on an IoT VLAN can claim a 10.10.10.x address and pass the Access List
   ([SECURITY.md → LAN only](SECURITY.md#lan-only-no-login)). Run the spoof test in the install skill, section 5.
7. Watch the first ✗ in the doctor output. Watch the journal for `226/NAMESPACE` or `EPERM` (the systemd sandbox),
   and for the pmxcfs `authorized_keys` rewrite (the backup is in `/root/.ssh/authorized_keys.pve1-dash.bak`).
8. On PVE 8: a missing Debian 13 template falls back to 12, and VM IPs come only through the helper.
9. If `:8006` uses an ACME cert, the installer asks for its host name, which must resolve to pve1 inside the container.
   That only applies when a new config is written. If the cert changes to ACME later, a re-run pins it (which breaks
   at the next renewal), so switch by hand: install skill, section 7.
10. iPhone push works only from the Home Screen app. Never delete `push.json`.

## 🗒️ Backlog and ideas

| Item | Source |
|---|---|
| Config hot-reload (SIGHUP); today a restart is needed | deferred (`server/index.ts` has no handler) |
| Icon image proxy (icons load from jsDelivr, so a device without internet sees monograms) | deferred |
| Push alert kind for host-service problems (today they only appear on the Overview Attention card) | deferred |
| Capacity alerts for ZFS pools that aren't PVE storages, and for LVM-thin metadata | deferred (`server/alerts/rules.ts` only loops over PVE storages) |
| Expiry check for the `publicUrl` certificate itself | improvement-round notes |
| SSE: per-guest patches and compression of `/api/stream` | deferred (partly done) |
| `services.certWarnDays` has no effect (the web hard-codes 14): wire it up or remove it | `server/config.ts:283`, `web/src/pages/services/servicesModel.ts` |
| Docs drift: helper version shown as `1` in `docs/SETUP.md:273` and `docs/TROUBLESHOOTING.md:233,237` (it is `2`) | verified; the troubleshoot skill works around it |
| Docs drift: the `SECURITY.md` helper table leaves out `hostinfo` and `inventory ... quick`, and doesn't say the 421 gate needs `publicUrl` | verified |
| Docs: the Matrix theme isn't mentioned in README or DESIGN, and `docs/screenshots/` predates it | verified |
| `pve1-dash-config --help` prints a stray `set -euo pipefail` line (usage prints lines 2-13) | verified by running it |
| The doctor's guest host-key fix runs `ssh-keygen -R` as root, which leaves `known_hosts` root-owned. Suggest `runuser -u pve1dash --` instead | `server/diagnostics/ssh.ts` |
| CSRF hardening: POST routes have no Origin or Sec-Fetch-Site check, and a bodiless POST is accepted (snooze, inventory refresh). Not browser-tested | security mapping |
| `POST /api/inventory/refresh` answers `{ok:true}` when rate-limited, without a 429 | `server/inventory/index.ts` |
| The doctor's sha256 helper comparison never fires (the helper prints no `sha256` line). No test ties `HELPER_PROTOCOL_VERSION` to `PROTOCOL=`, or the DOC anchors to the TROUBLESHOOTING headings | `server/diagnostics/ssh.ts`, `server/diagnostics/util.ts` |
| `system.version` only compares `0.1.0`. Consider bumping the version and tagging releases once the install works (README suggests `PVE1_DASH_REF=<tag>`, but there are no tags) | `server/version.ts` |
| A comment in `server/index.ts` says inventory "restores its last sweep", but inventory isn't persisted | `server/index.ts:188` |
| Docs drift in `docs/TROUBLESHOOTING.md`: the TLS step 3 says to remove `fingerprint:` only (from CA mode it is `ca:`); the push section doesn't mention the per-device filters (kinds, minimum severity, recoveries, quiet hours) that "Send test" skips; Helper denied step 4 says stopped or agent-less guests print an error line (they print no block at all); Token steps 2-3 print the secret | verified; the troubleshoot skill already works around each one |

The working notes from the build sessions (finding lists, stream reports) were never committed, so a finding number
such as `D70` in a commit message can't be looked up. Each backlog row stands on its own.

## ❓ Open questions for the owner

- What is the IP of the Nginx Proxy Manager host? Is it inside 10.10.10.0/24?
- Is any port on the NPM host forwarded from the internet, or does NPM serve any public site? Until that is known, the
  NPM Access List (`allow 10.10.10.0/24`, `deny all`) is required for dash.bgreen.cloud.
- Is pve1 on PVE 8 or 9? Does `:8006` serve the default certificate or an ACME one?
- Should the container use a static IP or a DHCP reservation, and which gateway? Is `vmbr0` the LAN bridge, without a VLAN?
- How does `dash.bgreen.cloud` resolve on the LAN (split DNS or a local record)? Can the container resolve it? (The
  doctor's proxy checks need that.)
- Where should development happen: a dev container on pve1, another machine, or (only if they want it) the host?
  Which GitHub credentials should the local agent use, and which author name and GitHub noreply address should its
  commits carry?
- Should `claude/homelab-dashboard-pve1-dizt16` be deleted on GitHub now that it is merged? No container records it
  yet, so it's safe either way.
