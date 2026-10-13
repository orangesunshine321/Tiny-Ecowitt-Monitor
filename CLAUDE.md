# pve1-dash: notes for Claude Code

pve1-dash is a **read-only** homelab dashboard for one Proxmox VE node (pve1). It is a Node.js/Fastify server and a
React PWA. It runs in its own unprivileged LXC container, reads Proxmox through a `PVEAuditor` API token, and looks
inside guests through one SSH key that is pinned to a read-only helper script on the host. The repository is still
called Tiny-Ecowitt-Monitor for historical reasons; everything before commit `6ace15e` is the old Windows app (plus
an abandoned first scaffold, `af7fa62`).

**New here? Read `docs/HANDOFF.md` first.** It covers project state, decisions, the first-install watch-list and the backlog.

## Working with the owner

- Ask clarifying questions. Research in the repo and docs for accurate answers. Never guess or make things up: if
  you don't know, say so, and say how you would find out.
- When troubleshooting, go **one or two steps at a time**, then stop and wait for the owner's feedback.
- **Confirm before any change** on the Proxmox host, in the dashboard container or in any other guest (VM or CT), and
  before merging a PR.
- Keep a light, friendly, helpful tone, and refer to the owner as they/them.

## Where you are: three places

You are probably running on the Proxmox host **pve1** as root, in a git checkout of this repo. Commands run in one
of three places, and every command in the docs and skills says which one:

| Place | How you reach it | What lives there |
|---|---|---|
| **Proxmox host** (pve1) | your shell | `pct`, `qm`, `pvesh`, `pveum`; the installer and uninstaller; `/usr/local/sbin/pve1-dash-helper`; `/root/.ssh/authorized_keys` (a symlink to `/etc/pve/priv/authorized_keys`, which would become cluster-wide if pve1 ever joins a cluster); `/var/log/pve1-dash-install.log` |
| **Dashboard container** (tagged `pve1-dash`, hostname `pve1-dash`) | `pct exec <ctid> -- <cmd>` (`pct enter <ctid>` is interactive, so leave that to the owner) | the systemd service `pve1-dash`; `pve1-dash-doctor`, `pve1-dash-config` and `pve1-dash-update`; `/etc/pve1-dash/` (config, token, SSH key, `install.env`); `/var/lib/pve1-dash/` (state, push keys); `/opt/pve1-dash` (the app) |
| **Dev environment** (a separate dev container or another machine, **not** the host) | see the `pve1-dash-develop` skill | `npm ci`, typecheck, tests, build, demo mode |

The host has no Node.js from the installer. Do not install Node.js or npm packages on the hypervisor without the
owner's explicit OK. How the owner puts git, this checkout and Claude Code (native installer, no Node.js) on pve1 is
in `docs/HANDOFF.md` → Bootstrap on pve1.

To find the dashboard CTID (host), use `pvesh get /nodes/pve1/lxc --output-format json` and look for `pve1-dash` in
`tags`. `pct list` (exact hostname `pve1-dash`, never a substring match) and
`grep -o 'pve1-dash@ct[0-9]*' /root/.ssh/authorized_keys` also work.

## This homelab (verified on pve1, 2026-10-13)

- Single **standalone** node `pve1` (no cluster, no corosync), PVE **9.2.x**, `:8006` uses the default
  Proxmox certificate (no `pveproxy-ssl.pem`; its SAN has 10.10.20.241, so the installer's CA mode verifies).
- pve1 = **10.10.20.241/24** on `vmbr0` (untagged, not VLAN-aware, ports `bond0`), gateway **10.10.20.1** (UniFi
  UDM Pro). Networks: **Main 10.10.20.0/24** (untagged: pve1, most CTs, DNS), **VLAN 2 "Adblocker" 10.10.10.0/24**
  (NPM, the owner's iPhone, the Tailscale subnet router), VLAN 40 IoT 10.10.40.0/24 (firewalled off from both),
  WireGuard 10.10.30.0/24. Main and VLAN 2 can reach each other. DHCP pools are .6-.254 on Main and VLAN 2, so a
  static IP must be .2-.5 or a router reservation.
- The dashboard CT: **CTID 126**, hostname `pve1-dash`, `vmbr0` untagged, static **10.10.20.5/24** gw 10.10.20.1.
- Dashboard URL `https://dash.bgreen.cloud`, served by Nginx Proxy Manager (NPM): a Docker container in **VM 102 on
  pve1, at 10.10.10.13** (VLAN 2). Let's Encrypt certificate from a Cloudflare DNS challenge. LAN DNS (Technitium,
  10.10.20.191 + 10.10.10.118) has a wildcard `*.bgreen.cloud -> 10.10.10.13`; public DNS has no record for it.
- **NPM IS reachable from the internet:** the UDM forwards WAN :80/:443 to 10.10.10.13. Any NPM host without an
  Access List answers internet clients who send the right Host header. The dashboard has no login, so its NPM host
  **must** use an Access List that allows only `10.10.10.0/24` and `10.10.20.0/24` and denies everything else.
  NPM trusts `X-Real-IP` only from private sources; the IoT VLAN can't reach NPM.
- `listen.allowedSources` = `10.10.10.0/24 10.10.20.0/24` (NPM, the owner's devices on both LANs, Tailscale clients
  which arrive SNATed as 10.10.10.249, and the CT itself for the doctor's proxy check).
- **VM 102 is never entered with `qm guest exec`:** its qemu-guest-agent has wedged twice on large output (recovery
  needs the console). It is listed in the host-only skip file `/etc/pve1-dash-helper.skip` (see the helper). VM 107
  (OMV NAS) has no agent and is skipped anyway.
- **Installed 2026-10-13** (main `f1a3e65`), doctor 29/29. Host-local deviations from main, all needed until the
  `fix/pve1-local-setup` branch is pushed and merged:
  - `/usr/local/sbin/pve1-dash-helper` is the **branch** copy (skip-file support). Re-running the installer or
    `--update-helper` from main puts main's helper back and VM 102 gets entered again: afterwards re-run
    `install -m 0755 deploy/helpers/pve1-dash-helper /usr/local/sbin/pve1-dash-helper` from this checkout on the branch.
  - The CT config has `listen.host: 0.0.0.0` set explicitly: without it, main's `update.sh` builds
    `http://8080:8080/healthz` and every install/update "fails" its health check (fixed on the branch).
  - CT 126 DNS = Technitium (`pct set --nameserver "10.10.20.191 10.10.10.118"`). The installer copied the host's
    `/etc/resolv.conf`, whose first server, the UDM (10.10.20.1), answers `*.bgreen.cloud` with no records, so the
    doctor's proxy check couldn't resolve dash.bgreen.cloud. pve1 itself has the same quirk (host DNS is not ours to
    change): from the host, test with `curl --resolve dash.bgreen.cloud:443:10.10.10.13 ...`.
  - OpenSSH 10 `PerSourcePenalties`: failed logins from the CT (e.g. before its key is authorized) make sshd drop its
    connections for a while ("kex_exchange_identification: Connection reset by peer"). It clears by itself.
- Push goes to an iPhone Home Screen web app (iOS 16.4+). Local use only: one owner, no scaling concerns.
- Repo `https://github.com/orangesunshine321/Tiny-Ecowitt-Monitor`. The one-line installer fetches `deploy/install.sh`
  from **main** and installs `main` by default. The host checkout at `/root/Tiny-Ecowitt-Monitor` has no GitHub
  credentials.

## Hard rules

**Product and security invariants** (see `docs/SECURITY.md`):

- The dashboard stays **purely informational**: no power, lifecycle, snapshot, config or shell features, ever.
  Console buttons only link to Proxmox's own console.
- The API token keeps the built-in **`PVEAuditor`** role only. Never add `VM.Monitor` (on PVE 8 it allows guest
  exec and file read/write), `Sys.Modify`, or any non-`*.Audit` privilege. The Proxmox client sends GET requests only.
- The SSH helper (`deploy/helpers/pve1-dash-helper`) runs as **root** on the host. Keep its allow-list strict:
  regex-validated arguments, no `eval`, no new write side effects. Treat every change to it as security-sensitive.
- LAN only: never suggest port-forwarding. Access is checked on the TCP peer (`listen.allowedSources`), never on
  `X-Forwarded-For`. Keep `publicUrl: https://dash.bgreen.cloud` set, because the Host/DNS-rebinding gate (HTTP 421)
  is off without it.
- **No secrets in the repo, docs, tests, commits or chat summaries.** The owner's email (the Web Push VAPID contact)
  belongs only in the container's `/etc/pve1-dash/config.yaml`. Never print `/etc/pve1-dash/token`,
  `/etc/pve1-dash/ssh/id_ed25519`, `push.json` or `/etc/pve/priv/*` secrets. Don't run `pvesh get /cluster/acme/plugins`
  (it prints the DNS provider's API credentials) or `pvesh get .../agent/file-read` (it reads any file inside a VM);
  take the ACME domain from `pvesh get /nodes/pve1/config` or the certificate's SAN instead. Both are denied in
  `.claude/settings.json` (so is `pvesh get .../file-restore`).
- The doctor, and `pve1-dash-update` (which runs it), print `alerts.vapidSubject`, the owner's email, in the PUSH
  group. Quote `pve1-dash-doctor --brief` output, and never paste raw doctor or update output into commits, PR
  descriptions or chat without removing the `mailto:` line.

**Process rules:**

- **Ask first** before anything that changes the host, the container or any other guest (VM or CT). Examples: the
  installer or uninstaller, `--update-helper`, `pve1-dash-update`, `pve1-dash-config` saves, `systemctl restart`,
  `pct set/stop/resize`, `pveum`, apt, network or firewall changes, and any command inside another guest
  (`pct exec <other ctid>`, `qm guest exec`, `guest.sh`). Read-only diagnostics need no confirmation in chat (Manual
  mode may still show a permission prompt): the doctor, `journalctl`, `systemctl status`, `curl .../healthz`,
  `cat install.env`, `pveum user token permissions`.
- **`main` must always be installable**, because the one-liner installs it. Change things on a branch named
  `fix/<topic>` or `feature/<topic>`. Merge only after typecheck, tests and build pass, ideally after the branch has
  run on the container, and only with the owner's OK.
- Never force-push and never rewrite `main`'s history. Never push to `main` directly without the owner's OK.
- **Never reuse the branch name `claude/homelab-dashboard-pve1-dizt16`.** The installer and `pve1-dash-update` treat
  it as the old pre-merge branch and steer containers off it to `main`.
- Never run demo mode (`PVE1_DASH_DEMO=1`) inside the dashboard container, or anywhere `/etc/pve1-dash/config.yaml`
  exists. Demo mode merges the real config (its `dataDir` and port win) and could push fake alerts to the real iPhone.
- Never `pkill -f` a pattern: it can match your own shell. Each Bash tool call starts a fresh shell, so `$PID` doesn't
  survive to the next call. Either start, check and stop a server in one call (`& PID=$!` … `kill -TERM "$PID"`), or
  start it with the Bash tool's background option, `echo` its PID, and later kill that literal PID. If it is lost,
  find it with `ss -ltnp`.
- `.claude/settings.json` starts sessions in Manual mode (`defaultMode: default`), removes auto mode and bypass mode
  (`disableAutoMode`, `disableBypassPermissionsMode`), and holds ask/deny rules as a safety net. Bash rules are not a
  security boundary, so the rules written in this file are what matter.
- **Always start `claude` from the repo root** (on pve1, `/root/Tiny-Ecowitt-Monitor`) and never `/cd` into a
  subdirectory. Claude Code reads `.claude/settings.json` only from the session's primary working directory, so
  anywhere else the mode locks and ask/deny rules are silently missing while this file and the skills still load.
  `/permissions` shows whether the rules loaded.
- A few read-only commands match ask rules, so they prompt every time, even after "don't ask again" (an allow rule
  never outranks a project ask rule): `bash deploy/install.sh --help`, `bash deploy/uninstall.sh --help`,
  `pct exec <ctid> -- pve1-dash-config --check`, `qm guest cmd <vmid> ping` (the guest-agent check; `qm guest exec`
  shares its rule) and the SSH helper test that names the key
  (`pct exec <ctid> -- runuser -u pve1dash -- ssh -i /etc/pve1-dash/ssh/id_ed25519 ...`). That is expected, so tell the
  owner it's normal.
- `pct exec` commands that name `/etc/pve1-dash/token`, `/var/lib/pve1-dash/push.json` or end with
  `/etc/pve1-dash/ssh/id_ed25519` are **denied on purpose**, even `ls -l` or `chown` (the doctor prints some of these as
  fixes). List the directories instead (`pct exec <ctid> -- ls -la /etc/pve1-dash /var/lib/pve1-dash`), use the
  doctor's checks, and hand repairs on those files to the owner (`pct enter <ctid>`). Don't work around the denials.
- Commit messages: a sentence-case summary line, then bullets grouped by area. Keep model names out of docs and code.

## Repo map

```
server/            Fastify backend (TypeScript, ESM): index.ts (wiring, --check-config, --version), config.ts (zod 4 schema),
                   http.ts (routes, access gates, SSE), state.ts (Store), proxmox/, inventory/ (SSH + helper parsers),
                   health/, alerts/ (rules, engine, Web Push), diagnostics/ (doctor + /api/diagnostics), demo/ (mock PVE 9)
shared/types.ts    the server <-> web data contract
web/               React 19 PWA (Vite): src/store.ts (SSE client), src/router.tsx, src/pages/, src/styles/, public/sw.js
deploy/            install.sh (host), lxc-setup.sh (in CT), update.sh (= pve1-dash-update), uninstall.sh,
                   pve1-dash-doctor.sh, pve1-dash-config.sh, pve1-dash.service, helpers/, config.example.yaml, reverse-proxy/
tests/             vitest (node env): server modules, web logic + Chromium CSS suites, deploy scripts with stubbed pct/pveum
docs/              SETUP, TROUBLESHOOTING, SECURITY, HELPER_PROTOCOL, DESIGN, HANDOFF, research/
```

## Commands

| Where | Command | What |
|---|---|---|
| host | `pct exec <ctid> -- pve1-dash-doctor` | read-only self-test with fixes (`--json`, `--quick`, `--brief`); exit 0 = nothing failed |
| host | `pct exec <ctid> -- journalctl -u pve1-dash -n 100 --no-pager` | service log |
| host | `pct exec <ctid> -- curl -s http://127.0.0.1:8080/healthz` | liveness only (`{"ok":true}`; exempt from every access gate) |
| host | `pct exec <ctid> -- cat /etc/pve1-dash/install.env` · `pct exec <ctid> -- git -C /opt/pve1-dash rev-parse HEAD` | recorded repo/ref, and the deployed commit (the app version is always 0.1.0) |
| host | `pct exec <ctid> -- pve1-dash-update --ref <branch>` | **changes the CT**: build, swap, roll back if `/healthz` fails, then run the doctor. Takes minutes: see Gotchas for the timeout |
| host | `bash deploy/install.sh --help` | the installer's flags and documented `PVE1_DASH_*` variables (three more are listed in the install skill); no side effects |
| dev | `npm ci && npm run typecheck && npm test && npm run build` | the full gate (there is no CI) |
| dev | `npm run dev` / `npm run dev:web` then `http://<ip>:5173/?sample` | demo API + Vite / UI on a built-in fixture |
| any | `for f in deploy/*.sh deploy/helpers/pve1-dash-helper; do bash -n "$f"; done; sh -n deploy/helpers/pve1-dash-guest-inventory` | shell syntax check (no Node needed) |

## Testing

- Tests need Node **22.12+**; the dashboard container uses Node 24. Expect 76 files, about 1400 tests, about 35 s.
- `npm run build` and `pve1-dash-update` never typecheck or run tests. Run the gate yourself before every push.
- Browser suites skip silently unless Chromium exists at `/opt/pw-browsers/chromium`. Shellcheck tests skip without
  `shellcheck`. Some tests behave differently as root.
- Deploy scripts are tested by sourcing them with stub Proxmox tools (`tests/fixtures/deploy/sandbox.ts`). Every
  script the tests source (install, lxc-setup, update, uninstall, pve1-dash-config) has a main guard, so keep it.

## Gotchas (all verified in the code)

- Container code is always **git-fetched from GitHub**, so push before you deploy. `install.sh` itself comes from
  whatever URL you curl, which is main in the one-liner. Use full 40-char commit ids, never short ones.
- `pve1-dash-update --ref X` records X in `install.env`, and later updates follow it. Run `--ref main` **before**
  deleting a branch, or later updates stop with "no longer a branch or tag".
- `pct exec` keeps the host environment. `update.sh` reads `PVE1_DASH_REF` and `PVE1_DASH_REPO`, so don't export
  them in the host shell.
- The update's rollback only catches a server that fails to listen. Read the doctor output after every update.
- `pve1-dash-update` (npm ci, build, prune, restart, doctor in a 1-core CT) takes several minutes. Run it with the Bash
  tool's maximum timeout (600000 ms) or in the background, and read the whole output. If it was cut off, don't assume
  nothing changed: check `pct exec <ctid> -- git -C /opt/pve1-dash rev-parse HEAD` and `install.env` (a retry while it
  still runs stops with "another update is running"). Decide on `--update-helper` by comparing
  `pct exec <ctid> -- sha256sum /opt/pve1-dash/deploy/helpers/pve1-dash-helper` with
  `sha256sum /usr/local/sbin/pve1-dash-helper` (host; the installer copies it byte for byte), not by the one-time notice.
- Zod 4: nested config objects use `.prefault({})`, never `.default({})`. Every config key must appear in
  `deploy/config.example.yaml` with its real default (enforced by `tests/deploy-config.test.ts`).
- There is no hot reload, so a config change needs a restart. `pve1-dash-config` restarts for you.
- CSS: global rules go in `@layer pve1-base` or `pve1-materials`, and component CSS stays unlayered. Never put `url()`
  in `backdrop-filter` (Safari drops the effect). No bare `prefers-color-scheme` in component CSS.
- New AlertKind: the compiler only checks the web maps and `server/http.ts`. Hand-edit `server/alerts/push.ts`
  `ALERT_KINDS` (append only), `server/alerts/engine.ts` `KINDS` and `server/alerts/rules.ts` `RULES`. The checklist
  is in the develop skill.
- `services.certWarnDays` has no effect (the web hard-codes 14 days).

## Helper protocol rule

`HELPER_PROTOCOL_VERSION` (`server/inventory/innerScript.ts`) and `readonly PROTOCOL=` (`deploy/helpers/pve1-dash-helper`)
are both **2** and must change together; no test checks this. The inner guest script must be byte-identical in
`deploy/helpers/pve1-dash-guest-inventory`, `deploy/helpers/pve1-dash-helper` and `server/inventory/innerScript.ts`
(enforced by `tests/inventory-scripts.test.ts`). **Any** byte change to the host helper needs a helper refresh on
the host after the container is updated: the one-liner
`bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/Tiny-Ecowitt-Monitor/main/deploy/install.sh)" -- --update-helper`,
or `bash deploy/install.sh --update-helper` from a checkout on an up-to-date `main`. `pve1-dash-update` prints the exact
command, but only in the update that changed the helper (see Shipping a change); the sha256 comparison in Gotchas works
any time. When the container's helper differs from the repo copy, `--update-helper` shows a diff and asks on the
terminal, which the Bash tool doesn't have, so it stops with "no terminal to ask". Then stop too: the owner reads
`/var/log/pve1-dash-helper.diff` and re-runs the command in their own SSH or xterm.js terminal. Never preset
`PVE1_DASH_TRUST_CT_HELPER=yes` to get past it (`--yes` answers no there). Spec: `docs/HELPER_PROTOCOL.md`.

## Shipping a change

1. Agree on the change with the owner. Then `git fetch origin && git switch -c fix/<topic> origin/main`.
2. Edit, then run the gate in the dev environment (`npm ci && npm run typecheck && npm test && npm run build`; `bash -n` for scripts).
3. Commit (with a repo-local author identity, see the develop skill), and push the branch after the owner OKs it.
4. Optional: try it on the real dashboard (host, with confirmation, long timeout) with `pct exec <ctid> -- pve1-dash-update --ref fix/<topic>`, then read the doctor output. If it says the host helper changed (or the hashes in Gotchas differ), run the printed `--update-helper` command now (with the owner's OK; if it stops at a question, see Helper protocol rule), or write down that main will need it. A dev-container session has no `pct`: hand this step and step 6 to the owner or the host session.
5. Open a PR into `main` (`gh pr create`, or the compare URL that `git push` printed). Merge only with the owner's OK, as a merge commit (`gh pr merge <n> --merge`, or "Create a merge commit" on GitHub), like PR #1.
6. Move the container back (host, ask first, long timeout): `pct exec <ctid> -- pve1-dash-update --ref main`. If the PR changed `deploy/helpers/pve1-dash-helper`, compare the helper hashes (Gotchas) and run the main `--update-helper` one-liner if they differ (if it stops at a question, see Helper protocol rule); don't wait for a notice: when the branch was deployed in step 4, none appears here.
7. Delete the branch only after the container no longer follows it. Then bring the checkouts back to main: `git switch main && git pull --ff-only` on the host checkout (and in the dev container), with the owner's OK if there are local changes.

## Skills and docs

- Skills: `pve1-dash-install` (install, re-run, upgrade, uninstall, NPM, push), `pve1-dash-troubleshoot` (doctor
  first, one step at a time), `pve1-dash-develop` (dev environment, tests, checklists, deploy a branch, PR flow).
- Docs: `docs/HANDOFF.md` (start here) · `docs/SETUP.md` · `docs/TROUBLESHOOTING.md` · `docs/SECURITY.md` ·
  `docs/HELPER_PROTOCOL.md` · `deploy/reverse-proxy/README.md` · `deploy/config.example.yaml` (every option).
