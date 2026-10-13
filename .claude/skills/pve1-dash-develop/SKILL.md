---
name: pve1-dash-develop
description: "Use when fixing a pve1-dash bug in the code, adding or improving a feature, working on the HANDOFF backlog, or otherwise changing pve1-dash code, docs or deploy scripts. Covers setting up a dev environment without polluting the Proxmox host, running typecheck/tests/build, demo mode and ?sample UI work, screenshots, the checklists for config keys, alert kinds, helper/protocol changes, routes and CSS, deploying a branch to the dashboard container, and the branch → PR → merge flow including GitHub credentials. Not for config-only changes (launcher tiles, alert thresholds, polling intervals, board title): those are pve1-dash-config edits, see pve1-dash-troubleshoot."
---

# Developing pve1-dash

**dev** = the dev environment, **host** = pve1 as root, **CT** = the dashboard container. Hard rules from `CLAUDE.md`
apply throughout: ask before changes on the host, the container or any other guest (VM or CT), keep `main`
installable, no secrets in the repo, never reuse `claude/homelab-dashboard-pve1-dizt16`, never force-push.

## 1. Pick a dev environment (ask the owner)

The installer never puts Node.js on the host, and the tests have never been run as root on a real Proxmox host.
Unstubbed tools would resolve to the real `pct`/`qm` binaries, and one suite starts a temporary `sshd`. So **don't
build or test on the hypervisor.** On the host itself you can safely edit, use git, run the syntax check
`for f in deploy/*.sh deploy/helpers/pve1-dash-helper; do bash -n "$f"; done; sh -n deploy/helpers/pve1-dash-guest-inventory`
(`bash -n` checks only its first file argument, so keep the loop), and run `bash deploy/install.sh --help` (it
prompts every time because it matches an ask rule; that's expected).

Offer the owner these options. Recommend A or B and let them choose:

- **A. A dev container with its own Claude Code session** (the cleanest). The code, Node and GitHub credentials live
  there, and the host session keeps install, troubleshooting and deploys. Setup (owner, after the container below
  exists and the repo is cloned in it): `pct enter <devid>` on the host, then inside it
  `curl -fsSL https://claude.ai/install.sh | bash` (the native installer), `cd /root/pve1-dash && claude`, and log in
  when asked. The installer doesn't add `~/.local/bin` to PATH, so if `claude` isn't found, run
  `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && . ~/.bashrc` or start `~/.local/bin/claude`. Claude
  Code's documented minimum is 4 GB RAM, so create this container with `--memory 4096`. That session has no `pct`:
  for host steps (deploying a branch, `--update-helper`, moving the container back), it stops after the push and asks
  the owner to run the step in the host session, with the exact branch and what to check, then continues from their
  result.
- **B. One host session and a dev container used only for building and testing.** Edit and commit on the host, then
  copy the working tree into the dev container and run the gate there (recipe below).
- **C. Another machine** with Node 22.12+, running **Linux**, ideally as root. The deploy tests run the real scripts
  with the `bash`, `sed` and `mktemp` found on a fixed system PATH (`/usr/local/bin`, `/usr/bin`, `/bin`, ...), which
  must be GNU bash 4+, GNU sed and coreutils, so a stock Mac fails them. As a normal user, several deploy and sshd suites skip (see "Things that skip silently").
- Installing Node on the host only happens if the owner explicitly wants it. Don't suggest it as the default.

### Creating a dev container (host, needs the owner's OK)

Use the same tools and flags as the installer's `pct create`. **Do not tag it `pve1-dash`**: the installer and
uninstaller find the dashboard by that tag. Keep `pve1-dash` out of its hostname too, so a look at `pct list` can't
mix the two up. Sizes are suggestions, and the template name comes from the first command:

```bash
pveam list local                                    # host: e.g. local:vztmpl/debian-13-standard_..._amd64.tar.zst
# host; --memory 4096 for option A (Claude Code runs inside), 2048 is enough for option B (build and test only)
pct create <devid> <template volid> --hostname p1d-dev --cores 2 --memory 4096 --swap 512 \
  --rootfs <storage>:16 --net0 name=eth0,bridge=vmbr0,ip=dhcp --unprivileged 1 --features nesting=1 \
  --ostype debian --start 1
pct exec <devid> -- apt-get update                  # host, then:
pct exec <devid> -- apt-get install -y ca-certificates curl git xz-utils shellcheck libjson-perl gh
```

`libjson-perl` is needed: the deploy tests run the real `perl -MJSON` (Proxmox VE ships it, plain Debian may not).
Add `openssh-server` only if the real-sshd suite should run (it also needs root and `/run/sshd`).

Clone for option A (host):
`pct exec <devid> -- git clone https://github.com/orangesunshine321/pve1_dashboard.git /root/pve1-dash`. The Vite
and demo servers bind `0.0.0.0`, so a dev container exposes them to the LAN while they run. That is fine on
the home LANs (10.10.10.0/24, 10.10.20.0/24), but stop them when done.

Node.js 24 (tests need 22.12+), **dev container only, never on the host**: `install_node` has no host guard, so run
bare on pve1 it would install Node into `/opt` and link node/npm/npx into `/usr/local/bin` on the hypervisor. It is
the updater's verified tarball install, the same function the dashboard uses, but sourcing it like this is
**unverified**. From the host (`env -i`, because `pct exec` passes the host environment and `update.sh` reads
`PVE1_DASH_*` variables):

```bash
# host; option A, after the clone:
pct exec <devid> -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  bash -c 'cd /root/pve1-dash && source deploy/update.sh && install_node 24'
# host; option B, once, after Recipe B's tar step has copied the checkout:
pct exec <devid> -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  bash -c 'cd /root/pve1-dash.src && source deploy/update.sh && install_node 24'
```

From a shell inside the dev container (option A's own session), the same is
`cd /root/pve1-dash && bash -c 'source deploy/update.sh && install_node 24'`.

### Recipe B: test the host checkout inside the dev container (unverified pipeline)

`pct exec` passes stdin through, which the installer relies on. It also keeps the host environment, so wrap the build
in `env -i`:

```bash
# host, from the checkout; DEV=<dev ctid>
pct exec $DEV -- rm -rf /root/pve1-dash.src
pct exec $DEV -- mkdir -p /root/pve1-dash.src
tar -C "$PWD" --exclude=./node_modules --exclude=./dist --exclude=./.data -cf - . | pct exec $DEV -- tar -C /root/pve1-dash.src -xf -
# first time only: install Node.js 24 now (option B command above), then:
pct exec $DEV -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
  sh -c 'cd /root/pve1-dash.src && npm ci && npm run typecheck && npm test && npm run build'
```

Give the Bash tool a long timeout (up to 10 minutes): `npm ci` plus about 35 s of tests.

## 2. The gate (dev)

```bash
npm ci                    # exact deps from package-lock.json; commit the lockfile when deps change (updates use npm ci too)
npm run typecheck         # tsconfig.server.json, tsconfig.web.json, tsconfig.webtests.json
npm test                  # vitest, 76 files; npx vitest run tests/alerts-engine.test.ts for one file; -t "name" to filter
npm run build             # vite -> dist/web, esbuild -> dist/server/{index,doctor}.js
for f in deploy/*.sh deploy/helpers/pve1-dash-helper; do bash -n "$f"; done; sh -n deploy/helpers/pve1-dash-guest-inventory
```

There is no CI, and neither the build nor `pve1-dash-update` typechecks or tests, so run all of it before every push.

Things that skip silently:

- The Chromium suites (web-cascade, web-theme, web-board-theme, web-matrix-controls, web-matrix-pages) skip unless
  Chromium is at `/opt/pw-browsers/chromium`.
- The shellcheck tests skip without `shellcheck`.
- One config test skips as root.
- As a normal user these skip: `lxc_setup_main` (`tests/deploy-lxc-setup.test.ts`), one doctor-wrapper and three
  `pve1-dash-config` cases in `tests/deploy-tools.test.ts`, the uninstall end-to-end suite (`tests/deploy-uninstall.test.ts`), and the real-sshd
  suite in `tests/inventory-ssh.test.ts` (which also needs `sshd` and `/run/sshd`).

To get Chromium (unverified path layout), **dev container only, never on the host**:

```bash
# dev (in option B, wrap it from the host like Recipe B's last command, with cd /root/pve1-dash.src)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright install --with-deps chromium
ln -sfn <the chrome binary it installed> /opt/pw-browsers/chromium
```

`--with-deps` installs apt packages, so run it only in the dev container.

## 3. Running it (dev, never in the dashboard container)

- `npm run build && npm run demo`: a simulated homelab (mock PVE 9.0.10 API and mock SSH) on :8080. State goes to
  `.data/demo`. Demo mode **merges a real config file** if `/etc/pve1-dash/config.yaml` or `PVE1_DASH_CONFIG` exists,
  so only run it where neither exists. `PVE1_DASH_DEMO_EDGECASES=1` adds rare states.
- `npm run dev`: the demo API under `tsx watch` plus Vite on :5173 (proxies `/api` and `/setup`). For background
  jobs with a PID each, start the binaries directly. `npm run dev:server` does **not** set `PVE1_DASH_DEMO=1` (it
  exits without a config, or uses the real one if it exists), and `kill` on an `npm run` PID leaves its child running:
  ```bash
  PVE1_DASH_DEMO=1 node_modules/.bin/tsx watch server/index.ts > /tmp/pve1-dash-srv.log 2>&1 & SRV=$!
  node_modules/.bin/vite > /tmp/pve1-dash-web.log 2>&1 & WEB=$!
  # ... work ...
  kill -TERM "$SRV" "$WEB"; wait "$SRV" "$WEB"
  ```
  Each Bash tool call starts a fresh shell, so `$SRV` and `$WEB` are gone in the next call. Keep start → check → kill
  in one call, or start the servers with the Bash tool's background option, `echo "$SRV $WEB"`, and later kill those
  literal PIDs (if lost, find them with `ss -ltnp`; never `pkill`).
- **UI without any server:** `npm run dev:web`, then open `http://<ip>:5173/?sample`. Scenarios:
  `?sample&scenario=auth|permission|tls|unreachable|timeout|proxmox|other|config|legacy`. This only works on the Vite
  dev server. In-app navigation drops `?sample`, so open each page directly. Use an IP or `localhost` in the URL,
  because Vite rejects other host names.
- Built server against a temp config, stopped by PID:
  ```bash
  T=$(mktemp -d); printf 'listen:\n  host: 127.0.0.1\n  port: 18081\ndataDir: %s/data\n' "$T" > "$T/c.yaml"
  PVE1_DASH_DEMO=1 PVE1_DASH_CONFIG="$T/c.yaml" node dist/server/index.js > "$T/log" 2>&1 & PID=$!
  for i in $(seq 1 30); do curl -fs http://127.0.0.1:18081/healthz && break; sleep 0.5; done   # wait until it listens
  kill -TERM "$PID"; wait "$PID"
  ```
  Never `pkill -f`. If a port stays busy, find its PID with `ss -ltnp` and kill only that PID.
- Config check without a service: `node dist/server/index.js --check-config FILE` (exit 0 means usable).
  Doctor against any config: `node dist/server/doctor.js --config FILE --quick --no-live`.
- Web Push can't be tested on the dev server: it needs HTTPS and the Home Screen app.

**Screenshots:** with the Vite dev server running, use
`node scripts/screenshot.mjs http://127.0.0.1:5173 /,/guests,/settings shots --sample --both`. Options include
`--theme system|light|dark|matrix`, devices `mac,ipad,ipad-portrait,iphone` and `--full`; `--help` prints the usage.
It needs Chromium at `/opt/pw-browsers/chromium`. File names drop the query string, so use one outDir per scenario.
`docs/screenshots/` predates the Matrix theme and the last improvement round, so refreshing it is a backlog item.

## 4. Checklists

**New or changed config key**

1. `server/config.ts` `ConfigSchema`: `.default(x)` on the leaf, `.prefault({})` on any new nested object (zod 4;
   `.default({})` skips inner defaults).
2. `deploy/config.example.yaml`: show the real default, or a commented `# key:` line. If the value shown is only an
   example, add its path to `examples` in `tests/deploy-config.test.ts`.
3. If the installer should write it: `render_config()` / `render_listen()` in `deploy/lxc-setup.sh`
   (`tests/deploy-lxc-setup.test.ts` loads that output).
4. If the web UI needs it: `SnapshotMeta` in `shared/types.ts`, `initialMeta()` in `server/index.ts`, and
   `web/src/dev/sampleSnapshot.ts`.
5. Alert rule settings: the fallback defaults in the helpers in `server/alerts/rules.ts` duplicate the schema, so keep
   them in sync.
6. There is no hot reload. Document that a restart is needed (`pve1-dash-config` does it).

**New AlertKind** (the compiler only catches steps 5 and 6)

1. `shared/types.ts` `AlertKind`.
2. `server/alerts/rules.ts`: the rule plus its `RULES` entry. Keys are `<kind>:<id>` and must stay stable forever.
3. `server/alerts/engine.ts` `KINDS`. Without it, persisted alerts of that kind are dropped on restart and fire again.
4. `server/alerts/push.ts` `ALERT_KINDS`: **append at the end** (`LEGACY_KINDS = ALERT_KINDS.slice(0, 10)`).
5. `server/http.ts` `ALERT_KINDS` (it has a compile guard).
6. Web: `web/src/pages/alerts/alertKinds.tsx`, `web/src/pages/overview/AttentionCard.tsx` (`ICON`) and
   `web/src/pages/overview/attention.ts` (`DEFAULT_PATH`).
7. The rule config in `server/config.ts` plus `deploy/config.example.yaml`. In `web/src/dev/sampleSnapshot.ts`,
   add the kind to `SAMPLE_DEVICE.prefs.kinds` if it is on by default. Do **not** add it to the `known` set in
   `toLegacy`, which models the older server.
8. Decide with the owner whether the kind pushes by default (`isDefaultKind` in `server/alerts/push.ts`; today only
   `updates_available` is off). Existing devices get new default-on kinds automatically, so deploying the branch
   starts pushing it to the iPhone.
9. Removing a rule or renaming a key resolves live alerts **with recovery pushes**, so avoid both.

**Helper scripts or protocol** (they run as root; see `docs/HELPER_PROTOCOL.md` and `docs/SECURITY.md`)

1. The inner script must be byte-identical in three places. Edit `deploy/helpers/pve1-dash-guest-inventory` first,
   then `server/inventory/innerScript.ts`, then the copy embedded in `deploy/helpers/pve1-dash-helper`.
2. Keep the allow-list strict: regex-validated arguments, no `eval`, no new write side effects.
3. If the output format changes, bump the protocol everywhere together:
   - `HELPER_PROTOCOL_VERSION` and the inner markers/header in `innerScript.ts`
   - `readonly PROTOCOL=` plus its header comment in the host helper, and the guest helper's version echo
   - `server/demo/mockRunner.ts` and `server/demo/guestInventory.ts`
   - the parsers and fixtures in `server/inventory/parse.ts`
   - `docs/HELPER_PROTOCOL.md`
   - tests that hard-code `2`: run `grep -rn "pve1-dash-helper 2\|inventory v2" tests server`
   Keep parsing the older output.
4. Run `npx vitest run tests/inventory-scripts.test.ts tests/inventory-helper.test.ts tests/inventory-parse.test.ts tests/inventory-v2.test.ts tests/diagnostics-ssh.test.ts`.
5. Rollout: update the container, then refresh the helper on the host with the `--update-helper` command that
   `pve1-dash-update` prints (or `bash deploy/install.sh --update-helper` from a checkout on an up-to-date `main`).
   Any byte change needs this, and the doctor can't detect an outdated helper whose protocol number is unchanged, so
   compare the sha256 of the CT and host copies (`CLAUDE.md` → Gotchas). The notice appears only in the update that
   changed the helper; see section 5, steps 4 and 7. For VMs without the guest agent, the owner re-runs
   `curl -fsSL https://dash.bgreen.cloud/setup/guest.sh | sh` inside each VM (the agent runs it only after the
   owner's explicit OK: it changes that guest's root `authorized_keys`).
6. Also fix the drift in `docs/SECURITY.md`: its helper table leaves out `hostinfo` and `inventory ... quick`.

**Deploy scripts**

- Keep the main guard at the bottom of every script the tests source (copy it from the last lines of
  `deploy/update.sh`), because the tests source those scripts.
- `deploy/lxc-setup.sh` sources `deploy/update.sh`, so the shared functions must stay self-contained.
- Run `npx vitest run tests/deploy-*.test.ts` plus `bash -n` on each script.
- To try installer changes on the real host (host; the owner runs it in their own SSH/xterm.js shell, after an
  explicit OK, because the installer is interactive and changes the real dashboard): push, then the owner runs
  `PVE1_DASH_REF=<40-char sha> bash -c "$(curl -fsSL https://raw.githubusercontent.com/orangesunshine321/pve1_dashboard/<40-char sha>/deploy/install.sh)"`
  (unverified URL form). Commit URLs aren't cached the way branch URLs are, and the ref must be given too, because
  `install.sh` defaults to `main`. That run records the sha in `install.env`, so later plain updates stay on the trial
  commit ("already up to date"). Once the change is merged or abandoned, move the container back (host, ask first,
  long timeout): `pct exec <ctid> -- pve1-dash-update --ref main`.

**Web**

- A new REST call in `web/src/api.ts` needs a branch in `sampleApi` (`web/src/dev/sampleSnapshot.ts`), or `?sample`
  throws.
- A new page needs `RouteId` and `ROUTES` in `web/src/router.tsx` plus a `NAV` item in `web/src/shell/nav.ts`.
- CSS:
  - Global rules go in `@layer pve1-base` or `pve1-materials`, and component CSS stays unlayered. Production links
    chunks in a different order than `vite dev`, so check with `tests/web-cascade.test.ts`.
  - Never use `url()` in `backdrop-filter`, and always write both `-webkit-backdrop-filter` and `backdrop-filter`.
  - Don't animate opacity or filter on an ancestor of `.glass`.
  - Use no bare `prefers-color-scheme` in component CSS (use tokens in `web/src/styles/tokens.css`). The two dark
    token blocks there must stay identical.
- No inline scripts: the CSP is `script-src 'self'`, and dev mode doesn't enforce it.
- Pages stay read-only, so add no buttons that act on Proxmox.

## 5. Ship it

1. Agree on scope with the owner. Then `git fetch origin && git switch -c fix/<topic> origin/main`, or `feature/<topic>`.
2. Make the change and run the gate. Commit with a sentence-case subject and bullets grouped by area (set the author
   identity first, see GitHub credentials).
3. Push the branch (ask first): `git push -u origin fix/<topic>`.
4. Try it on the real dashboard (host, ask first): `pct exec <ctid> -- pve1-dash-update --ref fix/<topic>`.
   - In option A's dev-container session there is no `pct`: ask the owner to run this in the host session (give the
     branch and what to check), then continue from their result. The same goes for step 7.
   - Run it with the Bash tool's maximum timeout (600000 ms) or in the background; it takes minutes (`CLAUDE.md` →
     Gotchas says what to check if it was cut off).
   - Unset any exported `PVE1_DASH_REF`/`PVE1_DASH_REPO` first.
   - Read the doctor output it prints, and check the commit with `pct exec <ctid> -- git -C /opt/pve1-dash rev-parse HEAD`.
   - If it says the host helper changed (or the CT and host helper hashes differ), run the printed `--update-helper`
     command (from the branch's `install.sh`) now with the owner's OK, or write down that main will need it. When the
     container's helper differs from the repo copy, it shows a diff and asks on the terminal, which your Bash tool
     doesn't have, so it stops with "no terminal to ask". Then stop too: the owner reads
     `/var/log/pve1-dash-helper.diff` and re-runs the command in their own SSH or xterm.js terminal. Never preset
     `PVE1_DASH_TRUST_CT_HELPER=yes` to get past it (`--yes` answers no there).
   - Remember that the rollback only catches a server that doesn't listen.
5. Open a PR into `main` (`gh pr create --base main --head fix/<topic>`, or without `gh` the owner opens the compare
   URL that `git push` printed) with "What's in it" and "Testing" sections.
   The doctor and update output contain the owner's email (`alerts.vapidSubject`, PUSH group): quote
   `pve1-dash-doctor --brief` and remove any `mailto:` line before pasting anything into the PR.
6. **Merge only with the owner's OK**, as a merge commit like PR #1: `gh pr merge <n> --merge`, or without `gh` the
   owner merges in the web UI with "Create a merge commit".
7. Move the container back to main (host, ask, long timeout): `pct exec <ctid> -- pve1-dash-update --ref main`. If the
   PR changed `deploy/helpers/pve1-dash-helper`, compare the CT and host helper hashes and run the main
   `--update-helper` one-liner if they differ (if it stops at a question, handle it as in step 4); don't wait for a
   notice: after the trial in step 4 none appears here.
   Delete the branch only after the container follows main again, or later updates stop with "no longer a branch or
   tag". Then `git switch main && git pull --ff-only` in the dev checkout and on the host checkout (ask first if
   either has local changes), so the next session loads the merged `CLAUDE.md`, skills and settings.
8. Home Screen apps keep the old build until "New version available — Reload" is tapped.

### GitHub credentials

The local agent needs its own access to push: `gh` (installed in the dev container above; the Debian package is
`gh`, unverified on this host), or an SSH key added to the owner's GitHub account plus
`git remote set-url origin git@github.com:orangesunshine321/pve1_dashboard.git`.

- Ask the owner which one they want, and where. Prefer the dev container (option A): it keeps credentials off the
  hypervisor.
- `gh auth login` is interactive, so the owner runs it in their own `pct enter <devid>` shell (HTTPS, and yes to
  authenticating git with their GitHub credentials). Without `gh`, the owner opens the PR from the compare URL that
  `git push` prints and merges it in the web UI with "Create a merge commit".
- Commits need an author identity. Ask the owner for a name and their GitHub noreply address
  (`<id>+<user>@users.noreply.github.com`), and set them repo-local with `git config user.name` and
  `git config user.email` in each checkout, never `--global` on the hypervisor. The no-email rule in `CLAUDE.md` is
  about their personal address (the VAPID contact); a noreply address is fine in this public repo. Never guess one.
- If the SSH key must live on the host, the owner creates it and prints its `.pub` in their own shell.
  `.claude/settings.json` denies Claude edits under `/root/.ssh` and reads of the private key files there.
- Never commit tokens or keys, never put them in the repo's git config or in docs, and never echo them.
- On the host, `/root/.ssh/authorized_keys` is the pmxcfs file `/etc/pve/priv/authorized_keys` (cluster-wide only if pve1 joins a cluster). Creating a key pair in `/root/.ssh` doesn't
  touch it, but never edit that file for GitHub.
