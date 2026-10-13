# pve1-dash design brief

pve1-dash should feel like a native Apple app (macOS Tahoe / iPadOS / iOS 26, Liquid Glass) that happens to run in a
browser: calm, legible, fast, and delightful. It is a **read-only** information dashboard for one Proxmox VE node.

Background research is in `docs/research/design-lang.md`. Read §1.6 (CSS recipe), §2 (colours), §3 (type), §4 (metrics,
springs, rings) and §6 (split-flap board) before building UI. Charts follow the dataviz skill rules summarised in
"Charts" below.

## 1. Principles

1. **Glass is for chrome, not content.** Liquid Glass (backdrop blur + saturate, rim light, specular sheen) is for
   things that float above content:
   - the sidebar, toolbars and tab bar;
   - sheets, popovers, menus, toasts;
   - the Spotlight palette.

   Content cards use a quieter *content material*: mostly opaque, 0.5px hairline, small blur, so text stays crisp and
   glass never sits on glass. Never animate an ancestor's `opacity` around glass (it breaks `backdrop-filter`
   sampling).
2. **Colour means something.** Colour marks status (reserved: green ok, orange warning, red critical, gray
   paused/unknown, blue info/interactive) and data series. Everything else is neutral labels on materials. Status
   always comes with an icon and text, never colour alone.
3. **Typography does the hierarchy.** Use the system font stack so Apple devices render SF Pro natively (never bundle
   SF). Use `ui-rounded` for big hero numbers (Fitness-style) and `ui-monospace` for logs, IDs and IPs. Use
   `font-variant-numeric: tabular-nums` wherever numbers update live.
4. **Motion is physical and quiet.** Use spring curves (`linear()` springs from research §4.3) for presses, sheet
   presentation and segmented thumbs. Honour `prefers-reduced-motion`. Live values tween smoothly and never jump the
   layout.
5. **Safari first.**
   - Write both `-webkit-backdrop-filter` and `backdrop-filter`.
   - **Never** put `url()` in `backdrop-filter`.
   - Safari has no `prefers-reduced-transparency`, so provide an in-app **Reduce Transparency** toggle that swaps glass
     for opaque fills, plus `prefers-contrast: more` support.
   - Keep blurred layers to a handful.
6. **Dark and light are both first-class.** Follow the system by default, with a manual override (System / Light /
   Dark) in Settings, stored in `localStorage`. Use the 2025 system colour values from research §2.1.

## 2. Layout and navigation

Routes are client-side (History API, with the server falling back to `index.html`):

| Path | Page |
|---|---|
| `/` | Overview |
| `/guests` | Guests (VMs + LXCs) |
| `/guests/:vmid` | Guest detail |
| `/services` | Services launcher |
| `/board` | Status board (fullscreen) |
| `/storage` | Storage, ZFS and disks |
| `/backups` | Backups |
| `/tasks` | Tasks |
| `/network` | Network |
| `/alerts` | Alerts |
| `/settings` | Settings |

Breakpoints:
- **Mac (≥ 1100px).** A floating glass sidebar (≈ 248px, inset 10px, radius 24px) sits over the animated wallpaper.
  Each page opens with a large-title header (34/41 bold) and a right-aligned toolbar of glass capsule groups.
  Content gets a max width of ≈ 1440px and responsive card grids.
- **iPad (768–1099px).** The sidebar collapses to a 76px glass icon rail; the sidebar toggle in the toolbar expands it
  as an overlay.
- **iPhone (< 768px).** A floating glass tab bar at the bottom (capsule, inset 12px plus safe area) holds Overview,
  Guests, Services, Board and More; More opens a sheet with the rest. A large title collapses into an inline glass nav
  bar on scroll. Respect `env(safe-area-inset-*)`, with `viewport-fit=cover`.

Sidebar groups:
- **Header:** app icon, node name, a status capsule (● Online / Offline) and uptime.
- **Library:** Overview, Guests (running count), Services (red badge = down count), Board.
- **Infrastructure:** Storage, Backups, Tasks, Network.
- **Footer:** Alerts (badge = active alerts) and Settings.

The toolbar always shows:
- **Spotlight search (⌘K / Ctrl-K).** It jumps to guests, services, containers and pages.
- **Live indicator.** The dot is green and pulsing when the SSE stream is connected and the node is online, amber when
  data is stale (> 2× the interval), and red when offline. Clicking it opens a popover with collector freshness from
  `meta.collectors`.

## 3. Material and visual tokens

All of these are CSS custom properties in `web/src/styles/tokens.css`, with light and dark values:
- **Glass:** `--glass-fill`, `--glass-fill-clear`, `--glass-blur`, `--glass-sat`, `--glass-rim-hi`, `--glass-rim-lo`,
  `--glass-hairline`, `--glass-shadow` (research §1.6).
- **Content material:** `--card-fill` (light ≈ rgb(255 255 255 / .78), dark ≈ rgb(28 28 32 / .72)), `--card-blur: 8px`,
  `--card-hairline`, `--card-shadow` (soft, small).
- **Labels:** `--label`, `--label-2`, `--label-3`, `--label-4` (research §2.3). Also `--separator` and `--fill-1..4`.
- **System colours:** `--blue`, `--green`, `--orange`, `--red`, `--yellow`, `--teal`, `--cyan`, `--indigo`, `--purple`,
  `--pink`, `--mint`, `--brown`, `--gray`, plus the 2025 values for light and dark.
- **Status aliases:** `--status-ok` (green), `--status-warn` (orange), `--status-crit` (red), `--status-off` (gray),
  `--status-info` (blue).
- **Radii:** `--r-window 26px`, `--r-card 22px`, `--r-control 12px`, `--r-capsule 999px`. Inner radii are concentric
  (outer − padding). `corner-shape: squircle` is progressive enhancement only.
- **Spacing:** a 4/8-based scale (`--s1` = 4px … `--s8` = 48px).
- **Springs:** `--spring-snappy`, `--spring-smooth`, `--spring-bouncy` as `linear()` easing (research §4.3), with
  cubic-bezier fallbacks.
- **Type scale** (web-tuned Apple scale), each with matching tracking from research §3.3:

  | Style | Size / weight |
  |---|---|
  | largeTitle | 34/41 bold |
  | title1 | 28/34 bold |
  | title2 | 22/28 bold |
  | title3 | 20/25 semibold |
  | headline | 15/20 semibold |
  | body | 15/20 |
  | callout | 14/19 |
  | subhead | 13/18 |
  | footnote | 12/16 |
  | caption | 11/13 |

The **wallpaper** is fixed behind everything: a slow, blurred mesh of 3–4 colour blobs that animates only `transform`
(research §1.6). It pauses on `visibilitychange`, stops under reduced motion, carries a ~3% noise overlay, and becomes
a calm solid gradient under Reduce Transparency.

## 4. Components (built by the foundation; used by every page)

| Component | Notes |
|---|---|
| `GlassPanel` | variants: `regular` \| `clear` \| `chrome` |
| `Card` | content material; optional title, subtitle, accessory, footer |
| `PageHeader` | large title + subtitle + toolbar slot; collapses on scroll on iPhone |
| `Toolbar` / `ToolbarGroup` | glass capsule groups |
| `SegmentedControl` | sliding thumb with spring |
| `Toggle` | iOS switch |
| `Button` | `glass` \| `tinted` \| `plain` |
| `IconButton` | |
| `StatusBadge` | status → icon + label + colour |
| `StatusDot` | optional pulse |
| `RingGauge` | Activity *style* ring with rounded caps and a subtle gradient. Never the Move/Exercise/Stand palette; use the system colours by severity. Centre value in `ui-rounded`. |
| `Meter` | capsule bar; fill colour by severity, track a lighter step of the same hue |
| `Sparkline` | |
| `TimeSeriesChart` | 1–3 series, 2px lines, 10% area wash, hairline grid, crosshair + tooltip, legend for ≥ 2 series, one y-axis only |
| `ListGroup` / `ListRow` | iOS inset-grouped list: leading icon, title, subtitle, trailing value, chevron |
| `Table` | macOS-style, sortable headers, sticky glass header |
| `Sheet` | right-side inspector on Mac/iPad, bottom sheet with grabber on iPhone; Esc / swipe to close |
| `Popover` | |
| `Toast` | live alerts, glass, auto-dismiss, top-centre |
| `Spotlight` | |
| `EmptyState` | |
| `Skeleton` | shimmer |
| `TagChip` | colour derived from tag name (stable hash into the system palette) |
| `AppIcon` | dashboard-icons slug → `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/<slug>.webp`; on error, a monogram tile in a stable colour. Also accepts absolute/relative URLs. |
| `OsIcon` | maps an OS name to a dashboard-icons slug. Real slugs: `debian-linux`, `ubuntu-linux`, `alpine-linux`, `microsoft-windows`, `home-assistant`, `proxmox`. Falls back to a lucide icon. |
| `RelativeTime` | auto-updating "2m ago"; absolute time in a `title` tooltip |
| `Bytes` / `Percent` / `Rate` | formatters |
| `MiniBoard` | compact split-flap service status used on Overview (implemented in `web/src/board/`) |

Formatting:
- Memory and disk use binary units labelled "GiB" (matching Proxmox).
- Network rates use bits per second ("12.4 Mb/s"); disk I/O uses bytes per second ("3.1 MB/s").
- Percentages are rounded (one decimal under 10%).
- Times use the browser's locale; uptime reads like "23d 4h".

## 5. Pages

### Overview (`/`)

- **Hero.** Node name and status, PVE version, kernel, CPU model and uptime. Updates available: show the count and
  open a sheet with the list.
- **Rings row.** CPU, Memory, Root FS and Swap as `RingGauge`, plus Load (1/5/15) and IO wait.
- **Performance card.**
  - `TimeSeriesChart` of CPU and memory, with a segmented control: Live / Hour / Day / Week / Month / Year.
  - Live uses `node.history`; the others call `/api/rrd/node`.
- **Network card.** In/out chart.
- **Attention card.** Everything that needs a look, ordered by severity, each linking to its page:
  - active alerts;
  - degraded ZFS pools and failing disks;
  - services that are down;
  - unhealthy or exited containers;
  - stale backups and failed tasks in the last 24h.

  When nothing is wrong, show a friendly "All systems nominal" empty state.
- **Guests card.** Running/stopped counts and the top 5 by CPU, with mini bars.
- **Service status card.** `MiniBoard` with the 5 most relevant services (down first).
- **Storage card.** A `Meter` per pool.
- **Temperatures card.** Only when `hostInventory.temps` exists.

### Guests (`/guests`)

- **Filters.** Segmented All / VMs / Containers, a status filter (Running / Stopped / All), search, and tag chips.
  Templates are hidden by default behind a toggle.
- **Grid and list views.** The grid shows cards with:
  - OS icon, name, vmid and a type badge (VM/CT);
  - status;
  - CPU and memory meters, plus disk for LXC (never show disk usage for qemu: PVE reports 0);
  - primary IP, uptime, tags and a CPU sparkline.

  The list view is a sortable `Table`.

### Guest detail (`/guests/:vmid`)

- **Header.** Big OS icon, name, status, vmid, node, tags and the OS pretty name.
- **Actions.** **Open Console** opens `consoleUrl` in a new tab (Proxmox asks for its own login). **Open in Proxmox**
  opens `pveUrl`. **Refresh inventory** calls `POST /api/inventory/refresh`.
- **Segments:**
  - **Overview:** resource rings, charts via `/api/rrd/guest/:vmid`, IPs, uptime.
  - **Apps:**
    - Docker containers grouped by compose project: state and health badges, image, ports as links to
      `http://<guest-ip>:<port>`, and uptime.
    - Services (non-system by default, with a "Show system services" toggle).
    - Listening ports.
    - When inventory is missing, show the reason (`inventory.error`) or instructions.
  - **Hardware:** cores, memory, disks and NICs (bridge, VLAN, MAC).
  - **Backups:** last backup plus this guest's backup items.
  - **Notes:** the description rendered as **plain text** with preserved line breaks. Never as HTML or markdown.

### Services (`/services`)

- A launcher grid grouped by `group`, using big glass-edged tiles. Each tile shows:
  - `AppIcon`, name and host guest;
  - a status pill and latency;
  - a 90-sample uptime strip and the `uptime24h` percentage.
- Clicking a tile opens the URL in a new tab.
- Filters: All / Problems / Docker / Configured, plus search.
- A "Status board" button opens `/board`.

### Board (`/board`)

The retro-futuristic split-flap status board is fullscreen, with no app chrome; Esc or a glass "Done" button
returns.

- **Header:** "SERVICE STATUS · PVE1" (from `meta.board`) and a live flip clock.
- **Words:** it looks like a station board but says plain things. The first version used train words (DEPARTURES,
  ON TIME, CANCELLED, PLATFORM), which the owner found unreadable without knowing the joke, so they were replaced. The
  code keeps the old identifiers (`departureRows`, `dest`, `platform`, `REMARK`).
- **Columns:**

  | Column | Content |
  |---|---|
  | CHECKED | last check, HH:MM |
  | SERVICE | service name, uppercase, truncated to fit |
  | GUEST (ID when narrow) | guest name or vmid |
  | STATUS | UP · SLOW · DOWN · STOPPED (paused: its guest is stopped) · UNKNOWN (not checked yet) |
  | MS | response time |

- **Look:**
  - deep charcoal flaps with warm amber/white characters, a hinge line and a subtle gap per cell;
  - a glowing status lamp per row;
  - a faint glass reflection sweep over the whole board, which supplies the "retro-futuristic" feel.
- **Motion:** characters flip sequentially through the drum (≈ 60 ms per step) when values change.
- **Paging:** if rows don't fit, pages auto-cycle every 12 s with a page indicator.
- **Sound:** optional WebAudio "clack" (research §6.4), off by default and unlocked by a tap. Don't put 3D cells
  inside a glass element.

### Storage (`/storage`)

- Pools with `Meter`s that colour from the thresholds in `meta.thresholds`, plus type, content and shared badges.
- ZFS pools with a health pill and fragmentation; tap for a sheet with the vdev tree from `/api/zfs/:name`
  (read/write/cksum).
- Disks: model, type, size, health pill and a wear `Meter` (used %, warns at `wearWarnPercent`); tap for a SMART
  sheet from `/api/disks/smart?disk=` showing the attribute table, or monospace text for NVMe.

### Backups (`/backups`)

- **Summary:** "X of Y guests backed up in the last N days", next job run and the source.
- **Coverage list:** per guest, last backup age, storage, and pills for stale / not in any job.
- **Jobs:** schedule, storage, mode, selection, next run, enabled.
- **Recent backup tasks.**
- **Backup items** grouped by guest (size, format, verification, protected lock).

When `backups.source === 'prunebackups'`, show an info banner explaining that size and notes need the SSH host helper.

### Tasks (`/tasks`)

- Filters: All / Errors / Running, plus a type filter.
- Each row shows: a type icon, a friendly label (e.g. "Backup", "Start VM 105"), the user, a relative start time, the
  duration and a status pill.
- Tapping a row opens a log sheet (monospace) from `/api/tasks/:upid/log`, which polls while the task is running.

### Network (`/network`)

- Host interfaces and bridges: type, CIDR, gateway, ports, VLAN-aware.
- A guest address table: name, vmid, IPs, MAC, bridge, VLAN.
- An "Open ports" table across all guests from inventory (searchable).

### Alerts (`/alerts`)

- Active alerts grouped by severity.
- A history timeline of recent alerts, including resolved ones.

### Settings (`/settings`)

- **Notifications:**
  - Enable on this device: permission and subscribe must come from a user gesture.
  - Device name, per-kind toggles, minimum severity, recoveries.
  - Send test, and the list of devices.
  - On iOS when not standalone (`navigator.standalone !== true` and not in `display-mode: standalone`), explain
    "Add to Home Screen first" with the share-sheet steps.
- **Appearance:** Theme (System / Light / Dark), Reduce Transparency, Board sound.
- **Data sources:**
  - collector freshness;
  - inventory status;
  - **Add a VM without guest agent:** a copyable command `curl -fsSL <publicUrl>/setup/guest.sh | sh`, plus the YAML
    snippet to add under `inventory.guests`.
- **About:** version, PVE version, links.

## 6. Charts (dataviz rules)

- Lines are 2px with round joins; area fill is the series hue at about 10% opacity; gridlines are 1px hairlines,
  recessive, never dashed.
- One y-axis only, never dual-axis. CPU (%) and memory (%) can share a percent axis; network in/out share a b/s axis.
- A legend whenever there are 2 or more series, and text in label colours, never series colours.
- Hover/touch shows a crosshair and a tooltip with all series values at that time.
- The fixed series colour order is blue, purple, teal, orange. Validate with the dataviz skill's
  `scripts/validate_palette.js` for light and dark.
- Status colours are reserved and never used for series.
- Gaps (missing RRD samples) render as breaks, not zeros.

## 7. PWA

- `manifest.webmanifest`: name "pve1", `display: standalone`, `id: "/"`, `start_url: "/"`, `scope: "/"`, icons
  (192/512 plus maskable) and theme colours.
- `apple-touch-icon` 180×180, `apple-mobile-web-app-status-bar-style: black-translucent`, `theme-color` per scheme.
- **Service worker** (`web/public/sw.js`, served at `/sw.js` with `Cache-Control: no-cache`):
  - Caching: precache only the app shell, use stale-while-revalidate for `/assets/*`, and never cache `/api/*`.
  - Push: handle Declarative Web Push JSON
    `{"web_push":8030,"notification":{"title","body","navigate","silent":false},"app_badge"?:n}` by calling
    `showNotification` for **every** push. Missing three in a row makes iOS delete the subscription.
  - `notificationclick` focuses or opens `navigate`.
  - Updates: show a "New version available — Reload" toast.
