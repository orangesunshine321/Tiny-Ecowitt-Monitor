# pve1-dash: backend stack and deployment reference

Scope: Node.js + TypeScript backend (Fastify 5) in a Debian 13 "trixie" LXC on the PVE host, behind an HTTPS reverse proxy on the LAN. React PWA frontend built with Vite. Must run on **Node 20.19+, 22 and 24**.

Research date: **2026-10-10**. All npm data comes from `npm view` against registry.npmjs.org on that date.

**How things were verified:**
- "VERIFIED (test)": proven by running code locally on Node **20.20.2, 22.22.0 and 24.21.0**. Node 20/24 came from the `node-linux-x64` npm package. The tests used a real OpenSSH 9.6p1 `sshd`, nginx 1.24.0 and self-made certificates.
- "VERIFIED (source)": read from upstream source or docs at the cited file and line.
- "UNVERIFIED": I could not confirm it. My best understanding is given separately.

Test artifacts (re-runnable) are in `scratchpad/tmp-research/`:
- `proj/tls-test.mjs`, `proj/tls-leak-test.mjs`
- `proj/ssh-test.mjs`, `proj/ssh-sig.mjs`
- `proj/sse-server.mjs`, `proj/close-test2.mjs`
- `proj/src/{pveHttp,sshExec,server,run-checks,forced}.ts`. These type-check with `tsc` 7.0.2 strict and run with tsx.
- `nginx/nginx.conf`, `systemd/pve1-dash.service`

---

## 0. TL;DR decisions

| Topic | Recommendation | Why (short) |
|---|---|---|
| Runtime floor | Node **>= 20.19.0** | `@fastify/static@10` → `content-disposition@3` is ESM-only and loaded via `require()`. `require(esm)` is on by default only from 20.19.0 / 22.12.0. Vite 8 also declares `^20.19.0 \|\| >=22.12.0`. |
| HTTP client to PVE | `undici@^7` (NOT 8). Use **undici's own `fetch`** (or `request`) with an undici `Agent`. | undici 8 needs Node >=22.19. An undici-8 `Agent` passed to the *built-in* `fetch` fails on Node 22 and 24 (`UND_ERR_INVALID_ARG invalid onRequestStart method`). VERIFIED (test). |
| TLS to PVE | Default: trust `/etc/pve/pve-root-ca.pem` (CA mode, optionally skip hostname check). Alternative: SHA-256 **leaf** pin via a custom undici connector. | `rejectUnauthorized:false` + `checkServerIdentity` does **not** pin self-signed certs: the callback is never called. VERIFIED (test). |
| SSH | `ssh2@1.17.0`, pure-JS (install with `--omit=optional --ignore-scripts`). Pin the host key by comparing the raw key Buffer with the base64 blob. Wrap remote commands with `timeout N`. | Native addons are optional and wrapped in try/catch. Closing the SSH connection does **not** kill the remote process. VERIFIED (test). |
| SSE | `reply.hijack()` + `reply.raw.writeHead` + `X-Accel-Buffering: no` + 15 s comment heartbeat. End all streams in a `preClose` hook. | Without `preClose`, `app.close()` blocks until every SSE client leaves. VERIFIED (test). |
| Proxy | nginx/NPM: works with the `X-Accel-Buffering: no` header alone (verified). Still add `proxy_buffering off; proxy_read_timeout 1h` for `/api/events`. Caddy/Traefik: no config needed (source). Enable HTTP/2 on the proxy. | Without HTTP/2, browsers cap SSE at 6 connections per domain. |
| Build/ship | Ship a **prebuilt tarball**: `server/` (esbuild, `--packages=external`) + prod-only `node_modules/` (pure JS) + `web/` (Vite build). **Do not** single-file-bundle deps. | A full bundle needs a CJS-shim banner (`require`, `__dirname`) and `*.node` externals. That works (verified) but is fragile. |
| Node install in LXC | Debian `nodejs` (20.19.2, Debian-security-maintained) by default. NodeSource `node_24.x` (nodistro repo) is opt-in. Never build on the target. | Debian needs no third-party repo or keys. NodeSource's official support table does not list trixie. |
| systemd | Dedicated system user + `ProtectSystem=strict`, `StateDirectory`, `LoadCredential`, etc. **No `MemoryDenyWriteExecute`** (it breaks the V8 JIT). Keep `AF_NETLINK` allowed. | Unit verified with `systemd-analyze verify` (systemd 255). Runtime in LXC is UNVERIFIED. |

---

## 1. Package versions (npm registry, 2026-10-10)

| Package | `latest` | `engines.node` | peerDependencies | Notes / pitfalls |
|---|---|---|---|---|
| fastify | **5.12.5** (`next` 6.0.0-alpha.4, `four` 4.29.1) | *(none declared)* | – | `docs/Reference/LTS.md` lines 57-63: v5.0.0 (2024-09-17) supports Node **20, 22**. Transitive deps declare `>=20`: find-my-way 9.9.0, toad-cache 3.7.4, thread-stream 4.2.0. |
| @fastify/static | **10.1.6** | *(none)* | (fastify-plugin check `fastify: '5.x'`, index.js:1012) | **v10 breaking:** `setHeaders(reply: FastifyReply, path, stat)`. v8/v9 used `(res: SetHeadersResponse, …)`, see types/index.d.ts:96 vs 9.3.0:103. Depends on `content-disposition@^3.0.0`, which is `"type":"module"` with `engines >=22` and is `require()`d from CJS (index.js:12). It works on Node 20.19+/22.12+ via require(esm). Tested OK on 20.20.2. Fallback: **9.3.0** (content-disposition ^1, old setHeaders). README compat: `>=8.x` ↔ fastify `^5.x`. |
| @fastify/compress | **9.2.1** (optional) | *(none)* | (`fastify: '5.x'`, index.js:733) | README: `>=8.x` ↔ fastify `^5.x`. Not applied to hijacked (SSE) replies, because hooks are skipped. Probably unnecessary on a LAN behind a proxy (see §6). |
| ssh2 | **1.17.0** | `>=10.16.0` | – | deps: asn1, bcrypt-pbkdf. **optionalDependencies:** `cpu-features ~0.0.10`, `nan ^2.23.0`. `install` script runs `node-gyp rebuild` for `sshcrypto.node` and always exits 0. The tarball root folder is `mscdex-ssh2-5c506eb/`, not `package/`. |
| @types/ssh2 | **1.15.6** | – | – | Types compile against ssh2 1.17 usage below (tsc 7.0.2). |
| web-push | **3.6.7** (published 2024-01-16) | `>= 16` | – | deps: asn1.js, http_ece 1.2.0, https-proxy-agent ^7, jws ^4, minimist. **ESM pitfall:** only `WebPushError`, `supportedContentEncodings` and `default` are detectable named exports. Use `import webpush from 'web-push'`. VERIFIED (test). |
| @types/web-push | **3.6.4** | – | – | |
| yaml | **2.9.1** | `>= 14.6` | – | Named ESM import `parse` works. |
| zod | **4.6.5** | *(none)* | – | `import { z } from 'zod'` works. |
| undici | **8.11.2** (`seven` = 7.30.0, `six` = 6.29.0) | 8.x: `>=22.19.0`; 7.30.0: `>=20.18.1` | – | **Use ^7** for Node 20 support (undici 8 crashes at import on Node 20.20.2). See §3 for the global-fetch mismatch. Bundled undici: Node 20.20.2 → 6.24.1, 22.22.0 → 6.23.0, 24.21.0 → 7.29.1 (`process.versions.undici`). |
| esbuild | **0.28.2** | `>=18` | – | |
| tsx | **4.23.15** | `>=18.0.0` | – | dep `esbuild ~0.28.0`. |
| typescript | **7.0.2** (`rc` 7.0.1-rc; last 6.x = **6.0.3**) | 7.0.2: `>=16.20.0`; 6.0.3: `>=14.17` | – | **TS 7 is the native port.** Per-platform binaries come via `@typescript/typescript-<os>-<arch>` optionalDependencies. Its main export `"."` is only `./lib/version.cjs` (`version`, `versionMajorMinor`); there is no classic `ts.createProgram` JS API, only `./unstable/*`. **typescript-eslint 8.71.1 peer `typescript: >=4.8.4 <6.1.0`**: if you lint with typescript-eslint, pin `typescript@6.0.3`. `tsc --noEmit` with TS 7 works (verified on this repo's snippets). |
| vitest | **5.0.3** (`V4` = 4.1.11, `V3` = 3.2.7) | 5.0.3: `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`; 4.1.11: `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0` | 5.x: `vite ^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0`, `@types/node ^22.0.0 \|\| >=24.0.0`; 4.1.11: `vite ^6 \|\| ^7 \|\| ^8` | **vitest 5 does not run on Node 20.** If CI/dev must use Node 20, pin `vitest@^4.1.11`. |
| react | **19.3.0** | `>=0.10.0` | – | |
| react-dom | **19.3.0** | – | `react ^19.3.0` | |
| @types/react | **19.3.0** | – | – | |
| @types/react-dom | **19.3.0** | – | `@types/react ^19.3.0` | |
| vite | **8.3.4** | `^20.19.0 \|\| >=22.12.0` | all optional: tsx ^4.8.1, yaml ^2.4.2, esbuild ^0.27.0 \|\| ^0.28.0, @types/node ^20.19.0 \|\| >=22.12.0, … | deps include `rolldown ~1.2.12`, `lightningcss ^1.33.0`. |
| @vitejs/plugin-react | **6.1.2** | `^20.19.0 \|\| >=22.12.0` | `vite ^8.0.0` (+ optional babel/oxc plugins) | 5.2.0 supports vite 4–8. |
| lucide-react | **1.54.0** | – | `react ^16.5.1 \|\| ^17 \|\| ^18 \|\| ^19`, `@types/react *` | |
| zustand | **5.0.15** | `>=12.20.0` | react >=18, @types/react >=18, immer >=9.0.6, use-sync-external-store >=1.2.0 (**all optional**, peerDependenciesMeta) | |
| react-router | **8.4.0** (`version-7` = 7.18.4) | 8.4.0: `>=22.22.0`; 7.18.4: `>=20.0.0` | 8.x: `react >=19.2.7`, `react-dom >=19.2.7`; 7.x: `>=18` | v8 is `"type":"module"`. It still exports `BrowserRouter` and `createBrowserRouter` (dist/development/index.d.ts). On a Node 20 dev box use **7.18.4**. |
| react-router-dom | **7.18.4** (no v8) | `>=20.0.0` | `react >=18`, `react-dom >=18` | In v7 it is a compat re-export of `react-router`. |
| @playwright/test | **1.64.0** | `>=20` | – | |

**Node-version reality check for "everything on 20.19+":**
- **Runtime** deps are fine on Node 20.19+. These were tested: fastify, @fastify/static 10, @fastify/compress 9, ssh2, web-push, yaml, zod, undici 7.
- `npm ci` prints `EBADENGINE` warnings for content-disposition@3 (`>=22`). npm still installs unless `engine-strict` is set.
- **Dev/build** tools that need >20 are vitest 5 (>=22.12), react-router 8 (>=22.22) and undici 8 (>=22.19). Build the frontend on Node 22/24, or pin vitest@4 and react-router@7.

---

## 2. Node.js on Debian 13 (trixie)

### 2.1 Debian archive versions

None of the Debian sites could be fetched directly: packages.debian.org, tracker, security-tracker, lists and deb.debian.org were all blocked by the proxy, and WebFetch got DNS failures. The values below come from **web-search result summaries**, so they are only partially verified.
- **nodejs (trixie / stable):** `20.19.2+dfsg-1+deb13u3` in trixie-security. The fix is from **DSA-6517-1** (2026-09-26, 15 CVEs). The earlier fix was `+deb13u2` from **DSA-6183-1** (2026-03-29). The original trixie package is therefore 20.19.2+dfsg-1. Sources: security-tracker.debian.org/tracker/DSA-6517-1, LWN copy, linuxsecurity.com summary.
- **npm (trixie):** `9.2.0~ds1-3` per a sources.debian.org/patches/npm snippet. Another snippet (reproducible-builds) showed `9.2.0~ds1-2`. **The exact revision is UNVERIFIED.** It is npm **9.2.0** either way.
- Debian `node-undici` in trixie: `7.3.0+dfsg1+~cs24.12.11-1` (search snippet). This only matters if Debian's nodejs uses a system undici for its built-in fetch. **UNVERIFIED** whether it does. Check `node -p process.versions.undici` on the target. Our PVE client uses npm `undici@7` from `node_modules`, so this does not affect us.
- systemd in trixie: **257** (LWN release coverage, via search).
- Upstream status from `nodejs/Release/schedule.json` (VERIFIED, source):

| Line | LTS start | Maintenance | **End of life** |
|---|---|---|---|
| v20 "Iron" | 2023-10-24 | 2024-10-22 | **2026-04-30** (already EOL upstream; Debian still ships security fixes for trixie, e.g. DSA-6517-1) |
| v22 "Jod" | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| v24 "Krypton" | 2025-10-28 | **2026-10-20** | 2028-04-30 |
| v26 | 2026-10-28 | 2027-10-20 | 2029-04-30 |

- Node 22/24 Linux x64/arm64 binaries need **glibc >= 2.28** (nodejs/node `BUILDING.md` line 108). Trixie's glibc is newer, so this is no problem.
- Debian ships `node` at `/usr/bin/node`.

### 2.2 NodeSource (deb.nodesource.com)

VERIFIED (source: `nodesource/distributions` master, `scripts/deb/setup_24.x`; `setup_22.x` is byte-identical except `NODE_VERSION`; `setup_26.x` also exists):
- The repo is **distro-agnostic**: `Suites: nodistro`, `URIs: https://deb.nodesource.com/node_<ver>.x`, written as `/etc/apt/sources.list.d/nodesource.sources` (deb822).
  - Key: `/usr/share/keyrings/nodesource.gpg`, from `https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key`.
  - Pin: `/etc/apt/preferences.d/nodejs` sets `Package: nodejs / Pin: origin deb.nodesource.com / Pin-Priority: 600`, so it overrides Debian's nodejs 20.
- The script only checks that `/etc/debian_version` exists and that arch is `amd64` or `arm64`. It **does not check the codename**.
- Official command (DEV_README.md):
  ```sh
  curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
  bash nodesource_setup.sh        # as root
  apt-get install -y nodejs       # NodeSource nodejs includes npm
  ```
- DEV_README's "Debian versions" support table lists only Debian 10/11/12, with Node 18x–24x. **trixie is not listed.** Third-party guides (computingforgeeks, "tested March 2026 on Debian 13.4 with Node 24.14.0, npm 11.9.0") report it works. **Official trixie support: UNVERIFIED.** In practice it should work because the packages are "nodistro" builds needing glibc >= 2.28.
- "NodeSource nodejs includes npm" is my understanding, not verified here.

### 2.3 Recommendation for a homelab install script (most robust)
1. **Never build on the target.** Ship a release tarball that already contains prod `node_modules`, then target only needs a `node` binary.
   - All runtime deps are pure JS when installed with `--omit=optional --ignore-scripts` (§4.6).
   - This removes the need for npm, node-gyp, build-essential and registry access inside the LXC.
2. Runtime selection in the script:
   - Prefer an existing `node` if `node -v` >= 20.19.0.
   - Else `apt-get install -y nodejs`. This is Debian 20.19.2: no third-party repo or key, and security-patched by Debian for trixie's lifetime.
   - Offer `--node=24` to add NodeSource (`setup_24.x`), for users who want an upstream-supported LTS. Node 20 is upstream-EOL since 2026-04-30.
3. Check after install: `node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<20||(a===20&&b<19)) process.exit(1)'` and `node -p process.features.require_module` (must be `true`).

```sh
# sketch (untested in LXC)
set -euo pipefail
need_node() { command -v node >/dev/null || return 0; node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=19)?1:0)'; }
if need_node; then
  if [ "${NODE_SOURCE:-debian}" = nodesource ]; then
    curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh
  fi
  apt-get install -y --no-install-recommends nodejs
fi
id pve1-dash >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/pve1-dash --no-create-home --shell /usr/sbin/nologin pve1-dash
install -d -o root -g root -m 0755 /opt/pve1-dash
tar -xzf pve1-dash-<ver>.tar.gz -C /opt/pve1-dash --strip-components=1   # contains server/ web/ node_modules/ package.json
install -d -o root -g pve1-dash -m 0750 /etc/pve1-dash
install -d -o root -g root -m 0700 /etc/pve1-dash/secrets              # read by systemd (LoadCredential), not by the service user
install -m 0644 pve1-dash.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now pve1-dash
```

---

## 3. TLS to the PVE API from Node (custom CA / pinning / insecure)

### 3.1 Facts about PVE certificates (VERIFIED, source)
- PVE creates a cluster CA at **`/etc/pve/pve-root-ca.pem`** (`$pveca_cert_fn = "$pmxcfs_base_dir/pve-root-ca.pem"`, pve-cluster `src/PVE/Cluster/Setup.pm:78`).
  - The CA key is RSA 4096 with `-days 3650`.
  - Subject: `/CN=Proxmox Virtual Environment/OU=<uuid>/O=PVE Cluster Manager CA/`.
- Each node gets **`/etc/pve/nodes/<node>/pve-ssl.pem`**, signed by that CA (Setup.pm `gen_pve_ssl_cert`, lines 487-571).
  - RSA 2048, `basicConstraints=CA:FALSE`, `extendedKeyUsage=serverAuth`.
  - SAN = `IP:127.0.0.1,IP:::1,DNS:localhost,IP:<node ip>,DNS:<nodename>`, plus `DNS:<nodename>.<resolv.conf search>` if a search domain exists.
  - Validity is at most 2 years: `2*365` days, capped to CA expiry minus 2 days.
  - **Consequence:** with `ca = pve-root-ca.pem`, normal verification works **if you connect using the node IP, the short hostname or the FQDN that is in the SAN**. Any other name or IP needs the hostname check skipped (chain still verified) or a pin.
- If the user uploaded a custom cert or uses ACME, pveproxy serves `pveproxy-ssl.pem` instead (UNVERIFIED here; PVE docs). With ACME, use `mode: system`.
- **Leaf pins break on renewal:** ACME ~60-90 days; `pve-ssl.pem` ≤ 2 years / `pvecm updatecerts`. CA mode survives renewals.
- PVE prints SHA-256 fingerprints with `Net::SSLeay::X509_get_fingerprint($cert,'sha256')` (pve-common `src/PVE/Certificate.pm:216-228, 297`). The format is the standard option `fingerprint-sha256`, pattern `([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}` (pve-common `src/PVE/JSONSchema.pm:169-174`).
  - It is the same format as Node's `cert.fingerprint256`, e.g. `20:C0:8F:AA:…:0F:A1` (uppercase, colon-separated). VERIFIED (test).
  - On the host, get it with `openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256`.

### 3.2 Test matrix (VERIFIED (test), identical on Node 20.20.2, 22.22.0, 24.21.0 with npm undici 7.30.0)

Servers used: `ss` = self-signed leaf whose SAN does *not* contain 127.0.0.1; `pve` = CA-signed leaf mimicking pve-ssl.pem. All requests went to `https://127.0.0.1:<port>`.

| # | Setup | Result |
|---|---|---|
| A1 | built-in `fetch`, no options, `pve` | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| B1 | built-in `fetch` + `dispatcher: new undici.Agent({connect:{ca}})` (undici **7**) | 200 |
| B1' | same with undici **8** Agent on Node 22 *and* 24 | **`UND_ERR_INVALID_ARG invalid onRequestStart method`** (built-in fetch/undici-6/7 vs npm undici-8 handler API mismatch) |
| B2 | `undici.fetch` + same Agent (7 or 8) | 200 |
| **C1** | `connect:{rejectUnauthorized:false, checkServerIdentity: () => new Error()}` vs **self-signed** | **200, checkServerIdentity called 0×. The pin is NOT enforced.** |
| D1-D4 | custom connector via `buildConnector({rejectUnauthorized:false})` checking `socket.getPeerCertificate().fingerprint256` | correct pin → 200 (also over keep-alive ×3); wrong pin → `fetch failed` with cause `TLS fingerprint mismatch …` |
| E1 | `connect:{ca: pve-root-ca, checkServerIdentity: () => undefined}` vs `pve` | 200 (chain verified, hostname skipped) |
| E2 | same vs self-signed foreign cert | `DEPTH_ZERO_SELF_SIGNED_CERT` (still rejected) |
| F1/F2 | `ca: <the self-signed leaf itself>` | fails on IP not in SAN (`ERR_TLS_CERT_ALTNAME_INVALID`). OK with `servername:'pve1'` (in SAN). |
| F3/F4 | `ca: <CA-signed leaf only>` | `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. **OK with `allowPartialTrustChain: true`** (Node 22.9.0 / 20.18.0). |
| G1-G3 | `node:https` + `https.Agent({rejectUnauthorized:false})` + check in `secureConnect`; or `https.Agent({ca, checkServerIdentity})` | work |
| Leak | Wrong pin with an `Authorization: PVEAPIToken=…` header: did the request bytes reach the server? | **No.** Nothing was received for the undici connector, for node:https checking in `secureConnect`, or for default verify failure. |
| Env | `NODE_EXTRA_CA_CERTS=/path/ca.pem node …` + built-in `fetch` | 200. It is read once at process start and applies process-wide. |

Why C1 happens (VERIFIED, source: nodejs/node v22.x `lib/internal/tls/wrap.js:1787-1793`): the code is `let verifyError = this._handle.verifyError(); if (!verifyError && !this.isSessionReused()) { … verifyError = options.checkServerIdentity(…) }`. So `checkServerIdentity` runs only when the chain already verified, and it is also skipped on TLS session resumption. For a self-signed or untrusted chain the verify error comes first, and `rejectUnauthorized:false` then accepts it. **Never use C1 as a "pin".** The connector pin in D does not depend on that call: it reads `getPeerCertificate()` on every new socket. D4 confirmed it on 3 keep-alive requests, with `maxCachedSessions: 0` as used in the code below.

Other knobs:
- `tls.setDefaultCACertificates()` exists on 22.19.0+ only: CHANGELOG_V22 22.19.0 section line 1107; `undefined` on Node 20.20.2.
- `--use-system-ca` exists on 22.15.0+. Node 20.20.2 rejects it with `bad option`.
- **Neither is usable for the Node 20 floor.** Use `NODE_EXTRA_CA_CERTS` or a per-Agent `ca`.

### 3.3 Working code (VERIFIED: tsc 7.0.2 strict + run via tsx against the test servers)
```ts
// src/pveHttp.ts — undici@^7
import { Agent, buildConnector, fetch } from 'undici';
import type { TLSSocket } from 'node:tls';
import { readFileSync } from 'node:fs';

export type PveTls =
  | { mode: 'system' }                                         // public CA / ACME cert
  | { mode: 'ca'; caFile: string; skipHostnameCheck?: boolean } // e.g. copy of /etc/pve/pve-root-ca.pem
  | { mode: 'fingerprint'; sha256: string }                   // "AB:CD:..." (colons/case optional)
  | { mode: 'insecure' };                                      // last resort; log a warning

const normFp = (s: string) => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

export function makeDispatcher(tls: PveTls): Agent {
  const common = { keepAliveTimeout: 10_000, connections: 4 } as const;
  switch (tls.mode) {
    case 'system': return new Agent(common);
    case 'ca':
      return new Agent({ ...common, connect: {
        ca: readFileSync(tls.caFile),
        // chain still verified against `ca`; only the hostname/IP-vs-SAN check is skipped
        ...(tls.skipHostnameCheck ? { checkServerIdentity: () => undefined } : {}),
      } });
    case 'fingerprint': {
      const want = normFp(tls.sha256);
      if (want.length !== 64) throw new Error('fingerprint must be a SHA-256 (32 bytes)');
      const base = buildConnector({ rejectUnauthorized: false, timeout: 10_000, maxCachedSessions: 0 }); // no TLS session resumption
      return new Agent({ ...common, connect(opts, cb) {
        base(opts, (err, socket) => {
          if (err) return cb(err, null);
          const got = (socket as TLSSocket).getPeerCertificate()?.fingerprint256 ?? '';
          if (normFp(got) !== want) { socket!.destroy(); return cb(new Error(`PVE TLS fingerprint mismatch: got ${got || 'none'}`), null); }
          cb(null, socket); // request bytes are only written after this
        });
      } });
    }
    case 'insecure': return new Agent({ ...common, connect: { rejectUnauthorized: false } });
  }
}

export async function pveGet<T>(baseUrl: string, path: string, token: string, dispatcher: Agent, signal?: AbortSignal): Promise<T> {
  const res = await fetch(new URL(`/api2/json${path}`, baseUrl), {   // undici's fetch + undici's Agent = same version
    dispatcher, signal: signal ?? AbortSignal.timeout(10_000),
    headers: { Authorization: `PVEAPIToken=${token}`, Accept: 'application/json' },   // token = "user@realm!tokenid=uuid"
  });
  if (!res.ok) throw new Error(`PVE ${path}: HTTP ${res.status} ${res.statusText}`);
  return ((await res.json()) as { data: T }).data;
}
```
Errors surface as `TypeError: fetch failed` with the real reason in `err.cause`, e.g. `cause.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'` or our mismatch message. Log `err.cause`.

Example config (proposal, our own format, not PVE's):
```json
{ "pve": { "baseUrl": "https://192.168.1.10:8006", "tokenId": "dash@pve!ro", "tokenSecretCredential": "pve-token",
           "tls": { "mode": "ca", "caFile": "/etc/pve1-dash/pve-root-ca.pem", "skipHostnameCheck": false } } }
```

**Alternative without undici dependency** (node:https, verified G1/G2): `new https.Agent({ rejectUnauthorized:false, keepAlive:true })`, then `req.on('socket', s => s.once('secureConnect', () => { if (fp mismatch) req.destroy(err) }))`. The leak test showed no request bytes were sent. Still, the undici connector is preferred: there, the request is provably not written until `cb(null, socket)`.

---

## 4. ssh2 (1.17.0)

### 4.1 `Client#connect(config)`: relevant options (VERIFIED, source: README lines 945-985; lib/client.js)

| Option | Type / default | Notes |
|---|---|---|
| `host` | string, `'localhost'` | |
| `port` | integer, `22` | |
| `username` | string | |
| `privateKey` | Buffer \| string | "OpenSSH format". **OpenSSH-format ed25519 (`-----BEGIN OPENSSH PRIVATE KEY-----`) works, unencrypted and encrypted** (VERIFIED, test with `ssh-keygen -t ed25519 -N ''` and `-N secret`). |
| `passphrase` | string | Needed for encrypted keys. Without it, `utils.parseKey` returns `Error: Encrypted private OpenSSH key detected, but no passphrase given`. |
| `readyTimeout` | integer ms, **20000** | Covers the handshake. On expiry: `error` with `level:'client-timeout'`, message `Timed out while waiting for handshake` (VERIFIED, fired at 1001 ms with 1000). |
| `hostHash` | string (any `crypto.getHashes()` name) | If set, `hostVerifier` receives a **hex string** digest of the key blob (client.js:277-283). |
| `hostVerifier` | `(key[, callback]) => boolean` | Without `hostHash`, `key` = **raw host public key Buffer in SSH wire format**. That is exactly `Buffer.from(<base64 field of the .pub / known_hosts line>, 'base64')`; ed25519 = 51 bytes. Return `true`/`false`, or call `callback(bool)` for async. Rejection gives `error` level `handshake`, `Host denied (verification failed)`. **Default: auto-accept if not set.** |
| `keepaliveInterval` | integer ms, **0 (off)** | SSH-level keepalive, like `ServerAliveInterval`. |
| `keepaliveCountMax` | integer, **3** | Unanswered keepalives before disconnect. |
| `algorithms` | object | E.g. `{ serverHostKey: ['ssh-ed25519'] }` forces the ed25519 host key, so you know which key to pin. |
| `debug` | `(msg:string)=>void` | |

Default host-key preference (`ssh2/lib/protocol/constants.js`): `ssh-ed25519, ecdsa-sha2-nistp256/384/521, rsa-sha2-512, rsa-sha2-256, ssh-rsa`. Against a stock OpenSSH host, ed25519 is negotiated, so **pin `/etc/ssh/ssh_host_ed25519_key.pub` of the PVE host**.

KEX compatibility:
- ssh2 default KEX: `curve25519-sha256@libssh.org, curve25519-sha256, ecdh-sha2-nistp256/384/521, diffie-hellman-group-exchange-sha256, diffie-hellman-group14/15/16/17/18-sha*`. No ML-KEM or sntrup.
- OpenSSH portable master (10.6) server default `KEX_SERVER_KEX` = `mlkem768x25519-sha256, sntrup761x25519-sha512(@openssh.com), curve25519-sha256(@libssh.org), ecdh-sha2-nistp256/384/521` (`myproposal.h:27-35`).
- They share `curve25519-sha256`, so ssh2 works with current OpenSSH servers (PVE 8 bookworm and PVE 9 trixie). Live test: OpenSSH 9.6p1 only. OpenSSH 10.x **live compatibility is UNVERIFIED**, but the overlap is verified from source.

### 4.2 `exec(command[, options], cb(err, stream))` events (VERIFIED, test against OpenSSH 9.6)
- `stream.on('data', Buffer)` → stdout. `stream.stderr.on('data', Buffer)` → stderr.
- `stream.on('exit', …)` *may* fire. Normal exit gives `(code)`. On a signal it gives `(null, signalName, didCoreDump, description)`.
- `stream.on('close', (code, signal))` gets the same args when `exit` fired (README 1300-1306). Observed:
  - `exit 3` → close `(3, undefined)`.
  - `kill -TERM $$` → close `(null, 'SIGTERM')`, exit args `[null,'SIGTERM',false,'']`.
- Results example (real output of the helper below):
```json
{ "code": 2, "signal": null, "stdout": "hi\n", "stderr": "e\n" }
```

### 4.3 Timeouts: important behaviour (VERIFIED, test)
- ssh2 has **no per-command timeout**. Implement an overall `setTimeout` that calls `conn.end()`.
- **Ending the SSH connection does NOT stop the remote command**: `sleep 30` kept running on the server after the client disconnected (no pty).
- `stream.signal('KILL')` had **no effect** against OpenSSH 9.6 (remote `sleep` survived).
- **Do this:** run remote commands as `timeout 10 <cmd>` (coreutils, exit code **124** on timeout, verified), *and* keep the local overall timer.

### 4.4 Host-key pinning from a `.pub` or known_hosts line
- `utils.parseKey(line)` on `"ssh-ed25519 AAAA… comment"` returns `{type:'ssh-ed25519', comment, getPublicSSH(): Buffer}`. `getPublicSSH()` equals the raw blob (VERIFIED).
- **ESM pitfall:** `import { utils } from 'ssh2'` throws `SyntaxError: Named export 'utils' not found`. Node's CJS lexer only detects `AgentProtocol, BaseAgent, Client, createAgent`. Use `import ssh2 from 'ssh2'; const { Client, utils } = ssh2;` (VERIFIED).
- OpenSSH-style fingerprint (same as `ssh-keygen -lf`) = `'SHA256:' + base64(sha256(blob))` without `=` padding. Verified: `SHA256:35odbM6Lmu471fot9BBEswzsTNwsQC5Fxoa1B5bvEtQ` matched `ssh-keygen -lf`. With `hostHash:'sha256'` the verifier gets the hex of the same digest.
- Hashed known_hosts lines (`|1|salt|hash ssh-ed25519 AAAA…`) still carry the plain key in field 2, so the parser below works for them too. The host match is not checked; we pin the key, not the name.

```ts
// src/sshExec.ts — VERIFIED (tsc 7 strict + runtime vs OpenSSH 9.6)
import ssh2 from 'ssh2';
import { timingSafeEqual, createHash } from 'node:crypto';
const { Client } = ssh2;

export function parsePinnedHostKey(line: string): { type: string; blob: Buffer } {
  const parts = line.trim().split(/\s+/);
  const i = parts.findIndex((p) => /^(ssh-|ecdsa-sha2-|sk-)/.test(p));
  if (i < 0 || !parts[i + 1]) throw new Error('no "<type> <base64>" found');
  const type = parts[i]!, blob = Buffer.from(parts[i + 1]!, 'base64');
  const tlen = blob.readUInt32BE(0);                       // wire format: string(type) || key data
  if (blob.subarray(4, 4 + tlen).toString('ascii') !== type) throw new Error('key type mismatch in blob');
  return { type, blob };
}
export const sshFingerprint = (blob: Buffer) => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

export interface ExecResult { code: number | null; signal: string | null; stdout: string; stderr: string }

export function sshExec(
  opts: { host: string; port?: number; username: string; privateKey: Buffer | string; passphrase?: string; hostKey: string },
  command: string, timeoutMs = 15_000,
): Promise<ExecResult> {
  const pinned = parsePinnedHostKey(opts.hostKey).blob;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const done = (err: Error | null, r?: ExecResult) => {
      if (settled) return; settled = true; clearTimeout(timer); conn.end(); err ? reject(err) : resolve(r!);
    };
    const timer = setTimeout(() => done(new Error(`ssh exec timeout after ${timeoutMs}ms`)), timeoutMs);
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return done(err);
        const out: Buffer[] = [], errOut: Buffer[] = [];
        stream.on('data', (d: Buffer) => out.push(d));
        stream.stderr.on('data', (d: Buffer) => errOut.push(d));
        stream.on('close', (code: number | null, signal?: string) => done(null, {
          code: code ?? null, signal: signal ?? null,
          stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8') }));
      });
    })
    .on('error', (e) => done(e))
    .on('close', () => done(new Error('ssh connection closed before command finished')))
    .connect({
      host: opts.host, port: opts.port ?? 22, username: opts.username,
      privateKey: opts.privateKey, passphrase: opts.passphrase,
      readyTimeout: 10_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => key.length === pinned.length && timingSafeEqual(key, pinned),
    });
  });
}
// usage: sshExec({...}, 'timeout 10 sensors -j', 15_000)
```
Verified outcomes:
- pinned key OK;
- known_hosts-line pin OK;
- wrong pin → `Host denied (verification failed)`;
- 800 ms timeout → rejected at ~800 ms.

### 4.5 Least privilege on the PVE host (VERIFIED, test with OpenSSH 9.6)
`~root/.ssh/authorized_keys` (or a dedicated user) on pve1:
```
restrict,command="/usr/local/bin/pve1-dash-probe" ssh-ed25519 AAAAC3Nza... pve1-dash@lxc
```
The wrapper reads `$SSH_ORIGINAL_COMMAND` and allow-lists commands. `sshd(8)` documents `command=` at line 514, `SSH_ORIGINAL_COMMAND` at 534 and `restrict` at 670. Test results:
- `sensors -j` and `uptime` → allowed;
- `cat /etc/shadow` → `{"code":126,"stderr":"denied: cat /etc/shadow\n"}`.

### 4.6 Native addons: are they needed?
- `lib/protocol/crypto.js:29-33` loads `./crypto/build/Release/sshcrypto.node` inside `try {} catch {}`.
- `lib/protocol/constants.js:5-8` loads `cpu-features` inside `try {} catch {}`.
- Both are optional. Install with `npm ci --omit=dev --omit=optional --ignore-scripts`: no `build/` dir and only 5 packages for ssh2.
- With that install, every test above passed in pure-JS mode: `bindingAvailable false`, default ciphers `aes128-gcm@openssh.com, aes256-gcm@openssh.com, aes128-ctr, aes192-ctr, aes256-ctr, chacha20-poly1305@openssh.com`.
- Without `--ignore-scripts` on a box lacking build tools, the `install` scripts try `node-gyp`. ssh2's script always `exit(0)`s; cpu-features is optional, so npm tolerates its failure. It is noisy and slow but does not fail. That last part is UNVERIFIED on a box without a compiler; this test box had one.

---

## 5. Fastify 5: SSE without plugins + SPA static serving

### 5.1 Facts (VERIFIED, source: fastify 5.12.5 docs)
- `reply.hijack()` stops Fastify from sending the reply and from running the remaining hooks: Reply.md:639-666, "an application claims full responsibility … hooks will not be invoked". So **onSend hooks such as @fastify/compress do not touch SSE**.
- `handlerTimeout` (default 0) is cleared by `hijack()` (Server.md:259).
- `keepAliveTimeout` default 72000 ms (idle sockets only). `connectionTimeout` and `requestTimeout` default 0.
- `forceCloseConnections` default `"idle"`: on `close()` it only destroys idle keep-alive sockets (Server.md:166-195). Active SSE responses are not idle, so **`app.close()` waits for them**.
  - VERIFIED (test): without a `preClose` hook, SIGTERM → close hung until the client disconnected (4015 ms). With the hook ending streams → `closed in 2ms`.
- Disconnect detection: `request.raw.on('close')` *and* `reply.raw.on('close')` both fire when the client goes away, on Node 20.20.2, 22.22.0 and 24.21.0 (VERIFIED, test). Prefer `reply.raw` (ServerResponse).
- SSE wire format (MDN `using_server-sent_events` lines 137-160):
  - UTF-8 text; messages separated by a blank line;
  - fields `event`, `data`, `id`, `retry`;
  - a line starting with `:` is a comment. The MDN note says "can be used to prevent connections from timing out".
  - On reconnect, the browser sends `Last-Event-ID` (observed: header echoed as `"lastEventId":"41"`).

### 5.2 Code (VERIFIED: tsc 7 strict + run under tsx; curl results below)
```ts
// src/server.ts (excerpt)
import Fastify, { type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const WEB_ROOT = path.resolve(process.env.WEB_ROOT ?? path.join(import.meta.dirname, '..', 'web'));
const app = Fastify({ logger: true, trustProxy: true });

type SseClient = { res: ServerResponse; send: (event: string, data: unknown, id?: number) => boolean };
const sseClients = new Set<SseClient>();

app.get('/api/events', (request, reply) => {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  const client: SseClient = {
    res,
    send(event, data, id) {
      let frame = id !== undefined ? `id: ${id}\n` : '';
      frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;   // JSON.stringify output has no raw newlines
      return res.write(frame);                                        // false => slow client; coalesce/skip
    },
  };
  sseClients.add(client);
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 15_000);  // < nginx proxy_read_timeout (60s default)
  res.on('close', () => { clearInterval(heartbeat); sseClients.delete(client); });
  client.send('hello', { lastEventId: request.headers['last-event-id'] ?? null });
});
export function broadcast(event: string, data: unknown, id?: number) { for (const c of sseClients) c.send(event, data, id); }
app.addHook('preClose', async () => { for (const c of sseClients) c.res.end(); });   // else close() hangs

await app.register(fastifyStatic, {
  root: WEB_ROOT, wildcard: true, index: false,
  setHeaders(reply: FastifyReply, filePath: string) {                  // v10 signature!
    const rel = path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
    reply.header('Cache-Control', rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
});
app.get('/', (_req, reply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html'));
app.setNotFoundHandler((req, reply) => {
  const url = req.url.split('?')[0] ?? '';
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.startsWith('/api/') && !path.extname(url)
      && (req.headers.accept ?? '').includes('text/html')) {
    return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'Not Found' });
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
```
Observed responses (curl, Node 22.22 and 20.20.2):

| Request | Status | Cache-Control |
|---|---|---|
| `/` | 200 | `no-cache` |
| `/index.html` | 200 | `no-cache` |
| `/sw.js` | 200 | `no-cache` |
| `/manifest.webmanifest` | 200 | `no-cache` (content-type `application/manifest+json`) |
| `/assets/index-AbC123xy.js` | 200 | `public, max-age=31536000, immutable` |
| `/vms/101` (`Accept: text/html`) | 200 | `index.html`, `no-cache` |
| `/nope.js` | 404 | JSON |
| `/api/nope` | 404 | JSON |

ETag and Last-Modified are present (from `@fastify/send`), so `no-cache` revalidates cheaply. Also verified:
- In v10 the plugin first applies send's headers, then calls `setHeaders(reply, …)` (index.js:496-498), so `reply.header()` there wins.
- `@fastify/static` README (lines 118-140) shows the same pattern: `maxAge:'30d', immutable:true` globally, `sendFile('index.html', {maxAge:0, immutable:false})`.

SSE response as seen by curl (real):
```
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Transfer-Encoding: chunked

retry: 5000

id: 1
event: snapshot
data: {"hello":"world","lastEventId":"41"}

id: 17
event: update
data: {"n":17,"t":1791610894362}
```

---

## 6. Reverse proxy configs for SSE + PWA

General points:
- Keep SSE on its own path (`/api/events`).
- The backend always sends `X-Accel-Buffering: no` and a comment heartbeat every 15 s.
- **Enable HTTP/2 on the proxy.** MDN (EventSource index.md:21): when not over HTTP/2, browsers cap SSE at **6 connections per browser+domain**, across all tabs.

### 6.1 Plain nginx (VERIFIED, test with nginx 1.24.0; docs from nginx.org source)
Docs facts (`xml/en/docs/http/ngx_http_proxy_module.xml`):
- `proxy_buffering` default `on` (lines 172-210). Buffering "can also be enabled or disabled by passing yes or no in the **X-Accel-Buffering** response header field". Turn that off with `proxy_ignore_headers`.
- `proxy_read_timeout` default **60s**, measured "between two successive read operations" (1749-1764).
- `proxy_http_version` default **1.1 since nginx 1.29.7**, **1.0 before** (1153-1170). Debian/Ubuntu nginx 1.2x still defaults to 1.0, so set it explicitly.

Test results (event every 500 ms, 2.2 s window):

| Config | Events received |
|---|---|
| default `location / { proxy_pass … }`, upstream sends `X-Accel-Buffering: no` | **5** (streams) |
| same, upstream without that header | **0** (buffered) |
| upstream without header + `proxy_buffering off` | **5** |
| direct (no proxy) | 6 |

```nginx
server {
  listen 443 ssl;
  http2 on;                          # nginx >= 1.25.1 syntax; older: "listen 443 ssl http2;"
  server_name dash.lan;
  # ssl_certificate ...; ssl_certificate_key ...;

  location /api/events {
    proxy_pass http://10.0.0.20:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    gzip off;
  }
  location / {
    proxy_pass http://10.0.0.20:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
The `http2 on;` directive syntax is from my knowledge of nginx ≥ 1.25.1 and was not re-verified here.

nginx **inheritance gotcha** (VERIFIED, test): `proxy_set_header` from an outer level is inherited **only if the inner level defines none**. Example: `http{ proxy_set_header Accept-Encoding ""; }` plus a location with its own `proxy_set_header Host` → the upstream *did* get `Accept-Encoding: gzip, br`.

### 6.2 Nginx Proxy Manager (VERIFIED, source: NginxProxyManager/nginx-proxy-manager `develop`)
- Global `nginx.conf` (lines 32-45) sets:
  - `proxy_http_version 1.1`;
  - `proxy_read_timeout 90s`, `proxy_send_timeout 90s`, `proxy_connect_timeout 90s`;
  - `keepalive_timeout 90s`, `gzip on`;
  - `proxy_set_header Accept-Encoding ""`, `proxy_cache off`.
- The default `location /` does `include conf.d/include/proxy.conf`. That file sets Host, X-Forwarded-Scheme/Proto/For, X-Real-IP and `proxy_pass $forward_scheme://$server:$port$request_uri`.
  - Because it defines its own `proxy_set_header`s, the global `Accept-Encoding ""` is **not** inherited there (see 6.1). Client `Accept-Encoding` reaches the app.
- The "Advanced" tab text is inserted at **server** level (`{{ advanced_config }}` in `proxy_host.conf:28`), before the default `location /`.
- **Result:** SSE works with **no NPM config**, because of `X-Accel-Buffering: no` (+ 1.1 + a 90 s read timeout vs. 15 s heartbeat). To be explicit, paste into **Advanced**:
  ```nginx
  location /api/events {
    include conf.d/include/proxy.conf;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
  ```
  Building this snippet from NPM's own include file is my construction and was not run inside NPM.
- **Turn OFF "Cache Assets"** for this host. `include/assets.conf` caches every `*.js|css|png|svg|woff2…` in a shared proxy cache for 30 min. It does so with `proxy_ignore_headers Set-Cookie Cache-Control Expires`, hides upstream `Cache-Control`/`Vary`/`Last-Modified`, and forces `expires @30m`. That would override our `no-cache` on `sw.js`.
- Turn ON "HTTP/2 Support" (`http2 on;` in `_listen.conf`).
- The "Websockets Support" toggle is not needed for SSE.

### 6.3 Caddy (VERIFIED, source; not live-tested)
`reverse_proxy` docs (caddyserver/website `reverse_proxy.md:432-436`) and code (`modules/caddyhttp/reverseproxy/streaming.go:380-405`) agree: `flush_interval` is ignored and responses flush immediately when the response has `Content-Type: text/event-stream`, `Incremental: ?1`, unknown Content-Length, or is h2 on both sides. The `encode` directive does not hold SSE back for `minimum_length` (encode.md:49; `sseMediaType` in encode.go:37). No special config:
```caddyfile
dash.lan {
	tls internal          # or your LAN CA / DNS-01 cert
	encode zstd gzip      # optional; SSE-safe
	reverse_proxy 10.0.0.20:8080
}
```
`flush_interval -1` is only needed for non-SSE streaming.

### 6.4 Traefik (VERIFIED, source; not live-tested)
- Traefik builds its proxy on Go's `httputil.ReverseProxy` (`pkg/proxy/httputil/proxy.go:54-58`). Its `FlushInterval` default is 100 ms (`pkg/config/dynamic/http_config.go:24-25`).
- Go's ReverseProxy returns `-1` (flush immediately) for `text/event-stream` (`net/http/httputil/reverseproxy.go:720-726`).
- The compress middleware calls through `Flush()` (compression_handler.go:314-370), so SSE is flushed per event even if compressed. Its default excluded type is only `application/grpc`.
- **No special config needed.** Optionally add `excludedContentTypes: [text/event-stream]` to compress.
```yaml
http:
  routers:
    dash: { rule: "Host(`dash.lan`)", service: dash, entryPoints: [websecure], tls: {} }
  services:
    dash: { loadBalancer: { servers: [ { url: "http://10.0.0.20:8080" } ] } }
```

---

## 7. Building and shipping the server (esbuild)

VERIFIED (test, esbuild 0.28.2, entry imports fastify + @fastify/static + ssh2):

| Attempt | Result |
|---|---|
| `--bundle --platform=node --format=esm` with native addons built | **Build error:** `No loader is configured for ".node" files` (`cpufeatures.node`, `sshcrypto.node`) |
| + `--external:'*.node' --external:cpu-features` | builds (2.3 MB), **runtime crash:** `Dynamic require of "node:events" is not supported` (avvio) |
| + banner `const require = createRequire(import.meta.url)` | **runtime crash:** `ssh2/lib/agent.js:168` uses `__dirname` at load. Node reports a misleading `ReferenceError: Cannot determine intended module format because both require() and top-level await are present` |
| + banner also defining `__filename`/`__dirname` | **works** on Node 20.20.2, 22.22.0, 24.21.0, from an isolated dir with no node_modules. ssh2 falls back to pure JS. |
| `--packages=external` (bundle only our code, ship node_modules) | **works**, no banner needed |

Working full-bundle command (if you really want one file):
```sh
esbuild src/server.ts --bundle --platform=node --format=esm --target=node20 --sourcemap \
  --external:'*.node' --external:cpu-features --outfile=dist/server.mjs \
  --banner:js="import { createRequire as __cjsRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __pathDirname } from 'node:path'; const require = __cjsRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);"
```
Other single-file pitfalls (UNVERIFIED specifics, general esbuild/pino knowledge): pino `transport` targets (worker files such as `pino-pretty`) cannot be bundled. Use plain stdout JSON logging (`logger: true`), which works in the bundle (verified).

**Recommended (most robust for LXC):**
```sh
# on the build machine (Node 22/24)
npm ci
npx tsc --noEmit                      # typecheck
npx vite build                         # -> web/
npx esbuild src/server.ts --bundle --platform=node --format=esm --target=node20 \
    --packages=external --sourcemap --outfile=release/server/index.mjs
cp package.json package-lock.json release/
(cd release && npm ci --omit=dev --omit=optional --ignore-scripts)   # pure-JS prod deps (~39 MB measured for the runtime set)
tar -czf pve1-dash-<ver>.tar.gz -C release .
```
- The tarball is architecture-independent: there are no `.node` files (`find node_modules -name '*.node'` was empty for the runtime set).
- On the LXC: extract it and run `node /opt/pve1-dash/server/index.mjs`, with `--enable-source-maps` if desired.
- Fallback when a tarball is impractical: `npm ci --omit=dev --omit=optional --ignore-scripts` on the target. That needs npm (Debian `npm` 9.2.0 or NodeSource) and registry access.

---

## 8. systemd unit

### 8.1 Facts (VERIFIED, source: systemd `man/systemd.exec.xml`, main branch)
- `DynamicUser=yes` implies `ProtectSystem=strict`, `ProtectHome=read-only`, `RemoveIPC=yes`, `NoNewPrivileges=yes` and `RestrictSUIDSGID=yes`.
  - UID/GIDs come from 61184–65519 and are recycled.
  - Writable dirs must come from `StateDirectory=` / `RuntimeDirectory=` / `ReadWritePaths=`.
- `ProtectSystem=strict`: the whole FS is read-only except `/dev`, `/proc`, `/sys`. `ReadWritePaths=`, `StateDirectory=` etc. are exempt.
- `MemoryDenyWriteExecute=`: "incompatible with … JIT execution engines". **V8 is a JIT, so do not set it for Node.**
- `LoadCredential=ID:PATH`: systemd reads PATH (as root) and exposes it read-only at `$CREDENTIALS_DIRECTORY/ID`, "accessible only to the user associated with the unit". Ideal for the API token and SSH private key.
- `ProcSubset=pid` "not suitable for most non-trivial programs", so leave it unset.
- Fastify calls `os.networkInterfaces()` when listening on `0.0.0.0` (`lib/server.js:363-372`, address logging). libuv's interface enumeration uses netlink, so **keep `AF_NETLINK`** in `RestrictAddressFamilies`. The libuv→netlink detail is UNVERIFIED (known behaviour); or bind to a specific IP.
- LXC: Proxmox's CT wizard enables **Nesting by default** for unprivileged CTs (`www/manager6/lxc/CreateWizard.js:74-84`, `inputValue: 'nesting=1', value: true`). pct docs: "Nesting … Note that systemd also uses this to isolate services" (`pve-docs/pct.adoc:392-393`).
  - Namespace-based sandboxing (`ProtectSystem`, `PrivateTmp`, `ProtectHome`, `PrivateDevices`, …) needs this. **Whether every option below works in an unprivileged trixie CT is UNVERIFIED.**
  - If the unit fails with `status=226/NAMESPACE`, enable nesting or drop the mount-namespace options.

### 8.2 Dedicated user vs DynamicUser
Use a **dedicated system user** for this app. It needs persistent, root-administered secrets (PVE token, SSH key, pinned host key, VAPID keys) and persistent state (push subscriptions). A fixed UID keeps backups and file ownership simple, and you get the same hardening by listing the options. `DynamicUser=yes` also works if all writes go to `StateDirectory=` and secrets come via `LoadCredential=`.

### 8.3 Recommended unit (`/etc/systemd/system/pve1-dash.service`)
Syntax verified with `systemd-analyze verify` on systemd 255: no warnings. Bogus keys or groups were correctly reported in a negative control. **Runtime under systemd 257 in LXC: UNVERIFIED.**
```ini
[Unit]
Description=pve1-dash - read-only Proxmox VE dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pve1-dash
Group=pve1-dash
WorkingDirectory=/opt/pve1-dash
ExecStart=/usr/bin/node /opt/pve1-dash/server/index.mjs
Environment=NODE_ENV=production
Environment=PVE1DASH_CONFIG=/etc/pve1-dash/config.yaml
# Optional CA trust for built-in fetch/https: Environment=NODE_EXTRA_CA_CERTS=/etc/pve1-dash/pve-root-ca.pem
EnvironmentFile=-/etc/pve1-dash/env
LoadCredential=pve-token:/etc/pve1-dash/secrets/pve-token
LoadCredential=ssh-key:/etc/pve1-dash/secrets/id_ed25519
StateDirectory=pve1-dash
StateDirectoryMode=0750
ConfigurationDirectory=pve1-dash
ConfigurationDirectoryMode=0750
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
# Do NOT add MemoryDenyWriteExecute=yes (breaks V8 JIT).

[Install]
WantedBy=multi-user.target
```
Notes:
- The app reads secrets from `process.env.CREDENTIALS_DIRECTORY + '/pve-token'` and `'/ssh-key'`. It keeps state (VAPID keys, subscriptions, TOFU host keys) in `/var/lib/pve1-dash` (`StateDirectory`; the env var `STATE_DIRECTORY` is also set).
- `SystemCallErrorNumber=EPERM` makes a filtered syscall fail with EPERM instead of killing the process with SIGSYS. This is a precaution for libuv/V8 probing syscalls outside `@system-service`. That such probing happens is UNVERIFIED.
- Port 8080 > 1024, so no capabilities are needed.
- Check the hardening score on the target with `systemd-analyze security pve1-dash.service`.

---

## 9. UNVERIFIED / caveats summary
1. Exact Debian trixie `npm` revision (`9.2.0~ds1-3` vs `-2`). The nodejs `20.19.2+dfsg-1+deb13u3` / DSA-6517-1 comes from search summaries of security-tracker/LWN, not a direct fetch.
2. Whether Debian's nodejs uses the system `node-undici` for built-in fetch. Irrelevant if you use npm `undici@7`.
3. NodeSource **official** trixie support. The repo is "nodistro" and the script has no codename check, but trixie is absent from the support table.
4. OpenSSH 10.x live interop with ssh2: verified from source (shared `curve25519-sha256`); live-tested only with OpenSSH 9.6p1.
5. Caddy and Traefik SSE behaviour: from source and docs only, not live-tested. nginx was live-tested; NPM was checked from source plus the nginx test.
6. systemd hardening at runtime inside an unprivileged PVE LXC (nesting on/off), and the `AF_NETLINK` requirement detail.
7. Behaviour of `npm ci` without `--ignore-scripts` on a box with no compiler.
8. That a custom or ACME cert replaces `pve-ssl.pem` as `pveproxy-ssl.pem` (standard PVE behaviour, not re-read in source here).

---

## Sources
**npm registry** (`npm view <pkg> version engines peerDependencies dist-tags`, 2026-10-10): all packages in §1. Tarballs were inspected via `npm pack`: fastify 5.12.5, @fastify/static 10.1.6/9.3.0/8.3.0, @fastify/compress 9.2.1, fastify-plugin 6.0.0, ssh2 1.17.0, typescript 7.0.2, react-router 8.4.0, content-disposition 3.0.0 (installed).

**Package files read:**
- `fastify/docs/Reference/LTS.md:57-63`; `Reply.md:629-666`; `Server.md:141-275`; `fastify/lib/server.js:363-372`; `fastify/fastify.js:384-430`
- `@fastify/static/README.md:14-25, 118-270, 473-535`; `index.js:12, 496-498, 1012`; `types/index.d.ts:96`
- `@fastify/compress/README.md:19-31`; `index.js:733`
- `ssh2/README.md:60-95, 740-1010, 1290-1306, 1437-1453`; `lib/client.js:273-287`; `lib/protocol/crypto.js:29-33`; `lib/protocol/constants.js:5-8, 85-105`; `lib/agent.js:168`; `lib/index.js`; `install.js`
- `undici@7.30.0`: `README.md:48-140, 600-620`; `docs/docs/api/Client.md:76-100`; `Connector.md`; `lib/core/connect.js:62-130`
- `typescript@7.0.2/package.json` (exports), `lib/version.cjs`

**Upstream sources via raw.githubusercontent.com:**
- https://raw.githubusercontent.com/proxmox/pve-cluster/master/src/PVE/Cluster/Setup.pm (lines 76-78, 405-571)
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/Certificate.pm (216-228, 297)
- https://raw.githubusercontent.com/proxmox/pve-common/master/src/PVE/JSONSchema.pm (169-174)
- https://raw.githubusercontent.com/proxmox/pve-manager/master/www/manager6/lxc/CreateWizard.js (74-84)
- https://raw.githubusercontent.com/proxmox/pve-docs/master/pct.adoc (392-393)
- https://raw.githubusercontent.com/nodesource/distributions/master/DEV_README.md (19, 57-79, 200-225) ; …/scripts/deb/setup_24.x ; …/scripts/deb/setup_22.x
- https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- https://raw.githubusercontent.com/nodejs/node/v22.x/lib/internal/tls/wrap.js (1787-1793: checkServerIdentity only if no verifyError and not session reuse)
- https://raw.githubusercontent.com/nodejs/node/v24.x/BUILDING.md (108)
- https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V20.md (583-603: 20.19.0 require(esm); 1191/1479: allowPartialTrustChain in 20.18.0)
- https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V22.md (2854+: 22.12.0 require(esm); 1099-1107: setDefaultCACertificates 22.19.0; 2045: --use-system-ca Linux 22.15.0; 3614/3783: allowPartialTrustChain 22.9.0)
- https://raw.githubusercontent.com/nginx/nginx.org/main/xml/en/docs/http/ngx_http_proxy_module.xml (172-210, 1153-1170, 1749-1764)
- https://raw.githubusercontent.com/NginxProxyManager/nginx-proxy-manager/develop/docker/rootfs/etc/nginx/nginx.conf (25-45) ; …/docker/rootfs/etc/nginx/conf.d/include/proxy.conf ; …/docker/rootfs/etc/nginx/conf.d/include/assets.conf ; …/backend/templates/proxy_host.conf ; …/backend/templates/_location.conf ; …/backend/templates/_listen.conf ; …/backend/templates/_assets.conf
- https://raw.githubusercontent.com/caddyserver/website/master/src/docs/markdown/caddyfile/directives/reverse_proxy.md (432-436) ; …/encode.md (49)
- https://raw.githubusercontent.com/caddyserver/caddy/master/modules/caddyhttp/reverseproxy/streaming.go (380-405) ; …/modules/caddyhttp/encode/encode.go (37)
- https://raw.githubusercontent.com/golang/go/master/src/net/http/httputil/reverseproxy.go (720-731)
- https://raw.githubusercontent.com/traefik/traefik/master/pkg/proxy/httputil/proxy.go (54-58) ; …/pkg/config/dynamic/http_config.go (24-25) ; …/pkg/middlewares/compress/compress.go (50-75, 145) ; …/pkg/middlewares/compress/compression_handler.go (314-370) ; …/docs/content/reference/routing-configuration/http/middlewares/compress.md (54-72)
- https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml (DynamicUser, ProtectSystem, MemoryDenyWriteExecute, LoadCredential, ProcSubset, RestrictAddressFamilies)
- https://raw.githubusercontent.com/openssh/openssh-portable/master/myproposal.h (27-41) ; …/version.h ; …/sshd.8 (514, 534, 670)
- https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/eventsource/index.md (21) ; …/web/api/server-sent_events/using_server-sent_events/index.md (137-166)

**Web search summaries** (pages not directly fetchable from this container):
- https://security-tracker.debian.org/tracker/DSA-6517-1
- https://lwn.net/Articles/1097062/
- https://linuxsecurity.com/advisories/debian/debian-dsa-6517-1-nodejs
- https://lists.debian.org/debian-security-announce/2026/msg00092.html (DSA-6183-1)
- https://sources.debian.org/patches/npm
- https://tests.reproducible-builds.org/debian/npm
- https://tracker.debian.org/pkg/src:node-undici
- https://lwn.net/Articles/1033740/ (trixie: systemd 257)
- https://computingforgeeks.com/install-nodejs-debian/ and https://computingforgeeks.com/nodejs-24-debian/ (third-party NodeSource-on-trixie reports)

**Local tests** (scratchpad/tmp-research):
- Node 22.22.0 (system), Node 20.20.2 and 24.21.0 (npm `node-linux-x64`)
- OpenSSH_9.6p1 sshd on 127.0.0.1:2222; nginx 1.24.0; OpenSSL-generated CA, leaf and self-signed certs
- systemd 255 `systemd-analyze verify`
