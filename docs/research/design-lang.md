# pve1-dash design language reference: Liquid Glass (macOS/iOS 26) + split-flap board

Researched 2026-10-10. Scope: everything needed to make a React PWA look and feel like a native Apple 26-series app on the web, plus a split-flap (Solari) "departures" board.

**How to read this document**
- **[V]** means verified against the cited primary source, which was fetched during research. Citations use a URL plus a local copy in `scratchpad/dl/design/...`.
- **[V-3p]** means verified against a reputable third-party primary artifact, such as source code or a spec.
- **UNVERIFIED** means I could not confirm the fact against a primary source. My best understanding is given next to it.
- **RECIPE** means engineering guidance I wrote for this project. It is not an Apple value. Tune it by eye.

**Unit convention:** 1 Apple point (pt) = 1 CSS px at device-width viewports. That is the standard mapping in Safari on iOS and on macOS at 1x. Tracking is given in 1/1000 em, so CSS `letter-spacing: <value/1000>em`.

**Timeliness note:** WWDC26 (June 2026) already shipped "macOS Golden Gate" and iOS 27-era HIG updates. Several HIG pages show "June 8, 2026" changelog entries. MacRumors reports that macOS Golden Gate windows "share one corner radius and are less dramatically rounded than in Tahoe" (via web search, not fetched). The target look here is still the 26-series Liquid Glass. The HIG text quoted below is the live version as of 2026-10-10.

---

## 1. Liquid Glass: what Apple says

### 1.1 Definition and layering rules [V]

These rules come from the HIG Materials page (changelog: added 2025-06-09, updated 2025-09-09). Source: https://developer.apple.com/design/human-interface-guidelines/materials (local copy: `dl/design/hig-materials.txt` lines 5-20).

- **Two kinds of material.** Apple platforms have two material types: *Liquid Glass* and *standard materials*. Liquid Glass "is a dynamic material that unifies the design language across Apple platforms, allowing you to present controls and navigation without obscuring underlying content." Standard materials "help with visual differentiation within the content layer."
- **Liquid Glass is the control layer.** It "forms a distinct functional layer for controls and navigation elements — like tab bars and sidebars — that floats above the content layer."
- **"Don't use Liquid Glass in the content layer."** Use standard materials for content-layer elements such as app backgrounds. The one exception is transient interactive controls in the content layer, such as sliders and toggles. These take on a Liquid Glass appearance *while being activated*.
- **"Use Liquid Glass effects sparingly."** Limit them "to the most important functional elements."
- **Variants.** There are two variants, **regular** and **clear**.
  - *Regular* "blurs and adjusts the luminosity of background content to maintain legibility". Most system components use it. Use it for alerts, sidebars, popovers, and anything with lots of text.
  - *Clear* "is highly translucent". Use it only over visually rich media. If the content underneath is bright, add a **dark dimming layer of 35% opacity** behind it.
  - The SwiftUI `Glass.clear` doc example uses `.background(.black.opacity(0.3))`. Source: https://developer.apple.com/documentation/swiftui/glass/clear (`dl/design/swiftui/glass_clear.json`).
- **Scroll edge effects** "further enhance legibility by blurring and reducing the opacity of background content."
- **System settings can override glass.** The appearance changes with the user's preferred Liquid Glass look, with Reduce Transparency, and with Increase Contrast.

### 1.2 Liquid Glass color [V]

Source: HIG Color, section "Liquid Glass color" (changelog 2025-06-09 and 2025-12-16). https://developer.apple.com/design/human-interface-guidelines/color (`dl/design/hig-color.txt` lines 31-43).

- Glass "has no inherent color, and instead takes on colors from the content directly behind it." Tinting gives a "colored or stained glass" look. Prominent buttons work this way.
- **Small elements adapt their brightness.** For toolbars and tab bars, "the system can adapt Liquid Glass between a light and dark appearance in response to the underlying content". Symbols and text on them follow a monochromatic scheme: darker over light content, lighter over dark content.
- **Large elements stay steadier.** "Liquid Glass appears more opaque in larger elements like sidebars".
- **Tint the background, not the label.** "To emphasize primary actions, apply color to the background rather than to symbols or text … Refrain from adding color to the background of multiple controls."

### 1.3 WWDC25 "Meet Liquid Glass" (session 219) [V]

Source: transcript at https://developer.apple.com/videos/play/wwdc2025/219/ (`dl/design/wwdc25-219.txt`).

- **Lensing (118-165 s).** "The primary way Liquid Glass visually defines itself is through something called Lensing." Previous materials "scattered light". The new one "dynamically bends, shapes, and concentrates light in real time".
- **Appearing and disappearing (175 s).** Objects "materialize in and out by gradually modulating the light bending and lensing", instead of fading.
- **Interaction (218-268 s).**
  - On interaction the material is "instantly flexing and energizing with light". It has a "gel-like flexibility".
  - Controls can temporarily "lift up into Liquid Glass" on touch, so "the transparent liquid lens can be seen through to precisely observe the value underneath it". This is the slider/toggle thumb behavior.
  - Menus: "the bubble simply pops open"; controls "morph" between states.
- **Adaptivity (381-449 s).**
  - Glass is made of layers, and each layer adapts to what is behind it.
  - "As text scrolls underneath, shadows become more prominent."
  - Tint and dynamic range shift for legibility.
  - Small elements can flip between light and dark independently.
  - Larger glass, such as a menu presented from a button, "casts deeper, richer shadows, has more pronounced lensing and refraction effects, and a softer scattering of light."
- **Mac and iPad (455-527 s).**
  - "Glass controls nest perfectly into the rounded corners of windows, maintaining concentricity."
  - On sidebars, "Light from colorful content nearby can subtly spill onto its surface".
  - "Floating sidebars on iPad and Mac". The sidebar and tab bar form "a single navigational element".
- **Scroll edge effect (532-606 s).**
  - It "gently dissolves the content into the background". Over dark content it "switch[es] to apply a subtle dimming instead".
  - A **"hard style"** is used with pinned accessory views such as column headers. It is "applied uniformly across the height of the toolbar and the pinned accessory view".
- **Highlights layer (664-698 s).** "Light sources … shine on the material producing highlights that respond to geometry". The lights move on interactions, and sometimes respond to device motion.
- **Shadows (698-721 s).** Shadow opacity *increases over text* and *decreases over solid light backgrounds*.
- **Touch feedback (725-740 s).** The material "illuminates from within". The glow starts under the fingertip and spreads to nearby glass.
- **Focus (757 s).** When a window loses focus on Mac or iPad, glass "visually recedes".
- **Usage rules (784-828 s).**
  - Glass is "best reserved for the navigation layer". Don't make a table view glass.
  - **"Always avoid glass on glass."** For elements on top of glass, "use fills, transparency, and vibrancy … like a thin overlay."
- **Variant rules (831-906 s).**
  - Regular and Clear "should never be mixed".
  - Clear has no adaptive behaviors and "needs a dimming layer".
  - Use Clear only when all 3 conditions hold: media-rich content behind it, the dimming layer is acceptable, and the content on top is bold and bright.
- **Light/dark flipping (916-951 s).** Navbars and tab bars flip light/dark. Menus and sidebars adapt but **don't flip**. Glyphs on glass mirror the flip.
- **Tinting (968-1055 s).**
  - "Selecting a color generates a range of tones that are mapped to content brightness underneath". A solid opaque fill "breaks the visual character".
  - Tint only primary actions. "If you want to imbue color into your app, do it in the content layer instead."
- **Accessibility (1102-1118 s).**
  - Reduce Transparency makes glass "frostier".
  - Increase Contrast makes elements "predominantly black or white" with "a contrasting border".
  - Reduce Motion "disables any elastic properties".

### 1.4 WWDC25 "Get to know the new design system" (session 356) [V]

Source: https://developer.apple.com/videos/play/wwdc2025/356/ (`dl/design/wwdc25-356.txt`).

- **System colors (155 s).** "Our family of system colors has been adjusted in subtle but meaningful ways across Light, Dark and Increased Contrast appearances". See §2.
- **Typography (172 s).** "now bolder and left-aligned … in key moments like alerts and onboarding".
- **Concentricity (201-376 s).** There are three shape types:
  1. **Fixed**: a constant radius.
  2. **Capsule**: radius = height / 2.
  3. **Concentric**: "calculate their radius by subtracting padding from the parent's".
  - Watch for corners that look "too pinched — or flared".
  - On iPhone, a button near a screen edge should be a capsule with extra margin. On iPad and Mac, use a concentric shape aligned to the window edge.
  - Use a "concentric shape with a fallback radius" for components that live both nested and standalone.
- **macOS control shapes (263-284 s).** Mini, Small, and Medium controls stay rounded rectangles. Large controls become capsules. There is a new X-Large size.
- **Structure (392-472 s).**
  - Sheets and action sheets "spring from the action itself".
  - Pair glass with a dimming layer for modal interruptions.
  - A dragged-up sheet becomes "more opaque" and grows.
- **Bars (513-605 s).**
  - Remove custom bar backgrounds and borders: "hierarchy should be expressed through layout and grouping."
  - Grouped bar items "share a background".
  - Don't group symbols with text buttons.
  - The primary action (Done) sits separate and **tinted**: "a blue checkmark on iOS … a prominent text button on macOS".
- **Scroll edge effects (656-750 s).** They are "not decorative"; there is one per view. **Soft** is the default (iOS). **Hard** is "mostly used on macOS". Don't stack them.
- **Sidebars (754-812 s).** "sidebars are now inset and built with Liquid Glass, allowing content to flow behind them". The *background extension effect* mirrors content under the sidebar. "Scroll views now extend beneath the sidebar by default".

### 1.5 Toolbars, sidebars, layout, tab bars, scroll views [V]

Sources: HIG Toolbars, Sidebars, Layout, Tab bars, Scroll views (`dl/design/hig-toolbars.txt`, `hig-sidebars.txt`, `hig-layout.txt`, `hig-tab-bars.txt`, `hig-scroll-views.txt`).

- **Toolbars**
  - "standard buttons, text fields, headers, and footers have corner radii that are concentric with bar corners. If you … create a custom component, ensure that its corner radius is also concentric".
  - "Reduce the use of toolbar backgrounds and tinted controls … use a ScrollEdgeEffectStyle when necessary."
  - Item groupings: leading edge (back, sidebar toggle, title), center (common controls, customizable), trailing edge (inspectors, search, More menu, primary action).
  - "Minimize the number of groups … aim for a maximum of three."
  - Keep title text "under 15 characters".
  - Use `.prominent` for one primary action, placed on the trailing side.
  - macOS: "toolbar items don't include a bezel".
- **AppKit (WWDC25 session 310, 108-252 s)** [V]
  - AppKit groups toolbar buttons onto one piece of glass. Segmented controls, pop-ups, and search each get their own glass.
  - Non-interactive items, such as titles and status indicators, "should avoid the glass material" (`isBordered = false`).
  - The prominent style tints glass with the accent color.
  - Badges use NSItemBadge.
- **Windows (310, 442-467 s)** [V]
  - "windows now have a softer, more generous corner radius, which varies based on the style of window. Windows with toolbars now use a larger radius … Titlebar-only windows retain a smaller corner radius". No numbers are given; see §4.
  - macOS 26 Mini, Small, and Medium controls "are now slightly taller" than before (310, 737-753 s).
- **Sidebars**
  - "sidebars can float above content in the Liquid Glass layer." Extend rich content beneath them, either by horizontal scrolling or with the background extension effect.
  - Show at most two levels of hierarchy.
  - Sidebar icons use the accent color by default.
  - macOS sidebar row height, text, and glyph size depend on the small/medium/large sidebar icon size setting. No numbers are given.
- **Layout**
  - "Instead of applying a solid or semi-opaque background color beneath controls, use a scroll edge effect".
  - Extend full-screen backgrounds under sidebars, toolbars, and tab bars.
- **Tab bars (iOS)**
  - "A tab bar floats above content at the bottom of the screen. Its items rest on a Liquid Glass background".
  - The tab bar can minimize on scroll down when an accessory is attached.
  - An optional search tab sits at the trailing end.
  - Badge: "a red oval containing white text".
- **Scroll views**
  - "Prefer the automatic scroll edge effect style … Only use a scroll edge effect when a scroll view is behind floating interface elements … Apply one scroll edge effect per view." In split views each pane has its own effect, "consistent in height".
  - SwiftUI `ScrollEdgeEffectStyle`: "hard style provides a more opaque, clearly defined linear boundary, and the soft style provides a subtle" transition (https://developer.apple.com/documentation/swiftui/scrolledgeeffectstyle).
- **SwiftUI glass API facts (for intuition)** [V] (`dl/design/swiftui/*.json`)
  - `glassEffect(_:in:)` defaults to `.regular` and a **Capsule** shape.
  - `Glass.tint(_:)` and `.interactive()` exist. Interactive glass "reacts … by scaling, bouncing, and shimmering" (WWDC 323, 1171 s).
  - `GlassEffectContainer(spacing:)` merges nearby glass shapes, which "blend" as they approach. "glass can not sample other glass", so group neighbouring glass in one container (323, 1191-1229 s).
  - iOS 26 partial-height sheets are "inset by default with a Liquid Glass background". At smaller heights "the bottom edges pull in, nesting in the curved edges of the display". At full height the background turns opaque (323, 386-408 s).
  - Bordered buttons are capsules by default (323, 865 s).

### 1.6 Translating Liquid Glass to CSS (RECIPE)

**What the web can reproduce**
- Blur plus luminosity/saturation lift: `backdrop-filter`.
- Translucent fill and tint.
- Rim and specular highlights: inset shadows, gradient borders, and pseudo-element sheens.
- Adaptive shadow, crudely, through context classes.
- Morphing: FLIP / View Transitions.
- Spring motion: `linear()`.

**What it can't reproduce in Safari**
- True lensing/refraction (§1.7).
- Per-pixel adaptive light/dark flipping driven by sampled backdrop luminance. You can approximate it with JS sampling or by setting `data-tone` from known content.
- Device-motion-driven lights.
- Glass-to-glass merging. Approximate it with SVG `feGaussianBlur` + `feColorMatrix` "gooey" filters on *non-backdrop* layers.

**Browser support facts behind the recipe**

| Feature | Support | Source |
|---|---|---|
| `backdrop-filter` unprefixed | Safari 18+, Chrome 76+, Firefox 103+ | [V-3p] BCD `css.properties.backdrop-filter` |
| `-webkit-backdrop-filter` | Safari 9-17 needs the prefix. Always emit both. | [V-3p] BCD; Safari 18 release notes "Added support for the unprefixed `backdrop-filter`" (`dl/apple/safari-release-notes_safari-18-release-notes.txt:88`) |
| `mask-composite` standard keywords (`exclude`) | Safari 15.4+, Chrome 120+, Firefox 53+ | [V-3p] BCD |
| `-webkit-mask-composite` | Chrome 1+, Safari 3.1+, no Firefox. Uses legacy keywords such as `xor`. | [V-3p] BCD |
| `color-mix()` | Safari 16.2+, Chrome 111+, Firefox 113+ | [V-3p] BCD |
| `light-dark()` | Safari 17.5+, Chrome 123+, Firefox 120+ | [V-3p] BCD |
| `@property` | Safari 16.4+, Chrome 85+, Firefox 128+ | [V-3p] BCD |
| `corner-shape: squircle` | Chrome 139+; Safari and Firefox "preview" only | [V-3p] BCD |
| `prefers-reduced-transparency` | Chrome 118+; **Safari: not supported** (BCD `false`, and absent from WebKit `MediaQueryFeatures.cpp`); Firefox behind a flag | [V-3p] |
| `prefers-contrast` | Safari 14.1+, Chrome 96+, Firefox 101+ | [V-3p] BCD |
| `prefers-reduced-motion` | Safari 10.1+ | [V-3p] BCD |

`corner-shape: squircle` would give Apple's continuous corners, so use it as progressive enhancement only.

**Backdrop root gotcha** [V-3p, MDN `backdrop-filter` page, `dl/design/mdn-backdrop-filter.md:96-110`]

`backdrop-filter` only samples up to the nearest **backdrop root**. These create one:
- the root element
- any ancestor with `filter`
- any ancestor with `opacity < 1`
- any ancestor with `mask`/`mask-image`/`mask-border`/`clip-path`
- any ancestor with `backdrop-filter`
- any ancestor with `mix-blend-mode`
- any ancestor with `will-change` naming one of the above

Consequences:
- **Never fade a glass panel by animating an ancestor's `opacity`.** Fade the panel itself, or animate `transform`/`scale`.
- Nested glass inside glass only blurs what is between them. This matches Apple's "glass can not sample other glass" and "avoid glass on glass".

**Tokens (light and dark)**

```css
:root {
  color-scheme: light dark;
  /* Liquid-glass-ish tokens (RECIPE) */
  --glass-blur: 24px;              /* regular; use 12-16px for small chips, 30-40px for big sheets */
  --glass-sat: 180%;               /* luminosity/saturation lift stands in for Apple's "adjusts luminosity" */
  --glass-fill: rgb(255 255 255 / 0.56);         /* regular, light */
  --glass-fill-clear: rgb(255 255 255 / 0.14);   /* clear, light */
  --glass-rim-hi: rgb(255 255 255 / 0.75);       /* top specular line */
  --glass-rim-lo: rgb(255 255 255 / 0.18);
  --glass-hairline: rgb(0 0 0 / 0.08);           /* outer hairline for separation on white */
  --glass-shadow: 0 10px 30px -8px rgb(0 0 0 / 0.22), 0 2px 6px rgb(0 0 0 / 0.08);
  --dim-clear: rgb(0 0 0 / 0.35);                /* Apple: 35% dark dimming under clear glass on bright content */
}
@media (prefers-color-scheme: dark) {
  :root {
    --glass-fill: rgb(40 40 44 / 0.52);
    --glass-fill-clear: rgb(255 255 255 / 0.06);
    --glass-rim-hi: rgb(255 255 255 / 0.28);
    --glass-rim-lo: rgb(255 255 255 / 0.06);
    --glass-hairline: rgb(255 255 255 / 0.10);
    --glass-shadow: 0 12px 34px -8px rgb(0 0 0 / 0.55), 0 2px 6px rgb(0 0 0 / 0.35);
  }
}
@media (prefers-contrast: more) {
  :root { --glass-fill: light-dark(rgb(255 255 255 / 0.92), rgb(20 20 22 / 0.92)); --glass-hairline: light-dark(#000, #fff); }
}
```

**Glass surface: fill, blur, rim, specular, shadow**

```css
.glass {
  position: relative;
  isolation: isolate;                       /* keeps pseudo-elements stacked locally */
  background: var(--glass-fill);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
          backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  border-radius: var(--r, 22px);
  box-shadow:
    inset 0 1px 0 0 var(--glass-rim-hi),    /* 1px top highlight ("specular" edge) */
    inset 0 -1px 0 0 var(--glass-rim-lo),   /* faint bottom rim */
    0 0 0 0.5px var(--glass-hairline),      /* hairline separation */
    var(--glass-shadow);                    /* soft, deep shadow */
}
/* Gradient rim (light catching the bevel) via mask compositing */
.glass::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px;
  background: linear-gradient(140deg,
      rgb(255 255 255 / .85), rgb(255 255 255 / .15) 35%,
      rgb(255 255 255 / .05) 60%, rgb(255 255 255 / .45));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;                                      /* legacy WebKit/Blink */
          mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  pointer-events: none; opacity: .9;
}
/* Specular sheen: soft top-left light pool */
.glass::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background:
    radial-gradient(120% 70% at 20% -10%, rgb(255 255 255 / .38), transparent 55%),
    linear-gradient(to bottom, rgb(255 255 255 / .10), transparent 40%);
  mix-blend-mode: soft-light;               /* or 'screen' at lower alpha in dark mode */
}
.glass[data-variant="clear"] { --glass-fill: var(--glass-fill-clear); --glass-blur: 8px; --glass-sat: 140%; }
.glass[data-tint] {                          /* "stained glass" tint for ONE primary action */
  background: color-mix(in oklab, var(--tint) 62%, var(--glass-fill));
  color: white;
}
.glass:active { transform: scale(1.04); transition: transform 180ms var(--spring-snappy); } /* "lift/energize" */
@media (prefers-reduced-motion: reduce) { .glass:active { transform: none; } }
```

Notes:
- Keep the `::before` rim and `::after` sheen on *the glass element itself*. Masks on the glass's own pseudo-elements don't affect the glass's backdrop sampling.
- Interactive glow under the pointer: set CSS vars `--mx`/`--my` from `pointermove`, then add `radial-gradient(160px circle at var(--mx) var(--my), rgb(255 255 255/.25), transparent 60%)` to `::after`. This approximates "illuminates from within … starting right under your fingertips".
- Adaptive shadow: Apple increases shadow opacity over text. Approximate this with a `data-over="text"` class on bars when scrolled content sits beneath them.
- Scroll edge effect (soft): put a fixed gradient band behind the toolbar, not on content. Example: `position:sticky;top:0;height:calc(var(--toolbar-h) + 24px); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); mask-image: linear-gradient(#000 55%, transparent);`. For the **hard** style (macOS table headers) use a uniform `background: var(--glass-fill)` band with no fade. Use one per scroll view.
- Increase Contrast: use opaque fill plus a 1px contrasting border.
- Reduce Transparency: Safari has no media query (see above). Offer an in-app "Reduce transparency" toggle that swaps to the opaque fill.
- Performance:
  - Each `backdrop-filter` is a compositing layer that re-samples the backdrop when content beneath it changes. Keep glass to a handful of elements: sidebar, toolbar groups, tab bar, sheet.
  - WebKit caps total backdrop area: `cMaxTotalBackdropFilterArea = 1242 * 2208 * 10` px² (WebKit `GraphicsLayerCA.cpp:113`) [V-3p].
  - WebKit notes "Filters cause flattening, so we should never have filters on a layer with preserves3D()" (`GraphicsLayerCA.cpp`, `setBackdropFilters`). **Don't put 3D split-flap cells inside a glass element that uses `transform-style: preserve-3d`.**

**Animated wallpaper (macOS-26-like backdrop for the glass to refract)**

Apple's guidance is to give glass rich content to sit on, and extend backgrounds under bars. RECIPE: a slow, blurred mesh of 3-4 colored blobs on a dark or light base. It animates only `transform`, renders on its own layer, and is paused for reduced motion and hidden tabs.

```css
.wallpaper { position: fixed; inset: -10vmax; z-index: -1; overflow: hidden;
  background: light-dark(#dfe7f3, #0b1020); contain: strict; }
.wallpaper i { position: absolute; width: 60vmax; aspect-ratio: 1; border-radius: 50%;
  filter: blur(80px); opacity: .75; will-change: transform; animation: drift 90s ease-in-out infinite alternate; }
.wallpaper i:nth-child(1){ background: radial-gradient(circle, #0088FF, transparent 65%); left: -5%;  top: -10%; }
.wallpaper i:nth-child(2){ background: radial-gradient(circle, #CB30E0, transparent 65%); right: -10%; top: 10%;  animation-duration: 120s; }
.wallpaper i:nth-child(3){ background: radial-gradient(circle, #00C3D0, transparent 65%); left: 20%;  bottom: -20%; animation-duration: 105s; }
.wallpaper i:nth-child(4){ background: radial-gradient(circle, #FF8D28, transparent 70%); right: 15%; bottom: -15%; animation-duration: 140s; opacity: .45; }
@keyframes drift { to { transform: translate3d(8vmax, -6vmax, 0) scale(1.15) rotate(25deg); } }
@media (prefers-reduced-motion: reduce) { .wallpaper i { animation: none; } }
/* JS: document.addEventListener('visibilitychange', () => wallpaper.style.animationPlayState = document.hidden ? 'paused' : 'running') */
```

Add a subtle noise overlay (an SVG `feTurbulence` data-URI at about 3% opacity) to kill gradient banding on 8-bit panels.

### 1.7 True refraction: Chromium-only, and dangerous in Safari

- **Chromium**
  - Supports `backdrop-filter: url(#svgFilter)`, for example an `feImage` displacement map plus `feDisplacementMap`. This is the basis of most "real Liquid Glass" CSS demos.
  - The `liquid-glass-js@0.1.0` README says: "Most demos out there are Chromium-only (they reference an SVG filter from `backdrop-filter`)" and "Safari/Firefox don't support referencing an SVG filter from `backdrop-filter`" [V-3p, npm registry readme].
  - Web search also surfaced WebKit bug 313914 about this (UNVERIFIED: content not fetched).
- **Safari: a stronger finding from WebKit source** [V-3p]
  - `RenderLayerBacking::updateBackdropFilters` sets `m_canCompositeBackdropFilters = !style.backdropFilter().hasReferenceFilter() && …` (`Source/WebCore/rendering/RenderLayerBacking.cpp:921`, WebKit main fetched 2026-10-10).
  - `GraphicsLayerCA::setBackdropFilters` has the comment "FIXME: This would clear the backdrop filters if we had a software implementation" (`GraphicsLayerCA.cpp:968`).
  - **Implication:** in Safari, a `backdrop-filter` list that contains `url(...)` is not composited at all. You likely lose the blur too, not just the refraction. Runtime behavior is UNVERIFIED; this is a source reading.
  - **Never** write `backdrop-filter: url(#lens) blur(20px)` as your only declaration. Gate it:

```css
.glass { -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%); }
@supports (not (-webkit-backdrop-filter: none)) {        /* i.e., not WebKit; crude Chromium gate */
  .glass.refract { backdrop-filter: url(#lens) blur(6px) saturate(180%); }
}
```

  This `@supports` gate is crude. It also matches Firefox, which (per a web-search snippet, UNVERIFIED) "can accept the `url()` syntax and then render nothing". A safer gate is JS: add the `.refract` class only when `navigator.userAgentData?.brands?.some(b => b.brand === 'Chromium')`. Alternatively, use the "clone mode" technique from liquid-glass-js: refract a clone of the background, which works in all engines but only over known DOM.
- **WebKit has internal glass CSS that you can't use.** WebKit has `-apple-visual-effect: -apple-system-glass-material | -apple-system-glass-material-clear | -apple-system-blur-material[-thin|-thick|-ultra-thin|-chrome] | -apple-system-vibrancy-*` (`Source/WebCore/css/CSSProperties.json:14378`). It is gated by `settings-flag: useSystemAppearance`, and `UseSystemAppearance` is `status: embedder, defaultValue: false` (`Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml:6647-6651`) [V-3p]. Only native apps embedding WKWebView can turn it on, so **it isn't available to a web page in Safari.**
- **Fallback.** Plain blur+saturate glass, plus the rim and specular recipe above. Optionally add a *static* pre-rendered lens highlight PNG/SVG in `::after` for large hero glass.

---

## 2. Apple system colors

### 2.1 Accent system colors (updated 2025) [V]

Source: the HIG Color "Specifications → System colors" table. The values come from the image alt-text in https://developer.apple.com/tutorials/data/design/human-interface-guidelines/color.json (local `dl/hig-color.json`; swatches `colors-unified-<name>-{light,dark}.png` and `colors-unified-accessible-*`).

- **The values changed in 2025.** The HIG changelog says "June 9, 2025 — Updated system color values". WWDC25-356 (155 s) confirms colors were "adjusted … across Light, Dark and Increased Contrast".
- **One table covers all platforms.** It is a single "unified" table with SwiftUI API names. The HIG notes "visionOS system colors use the default dark color values." That the table also applies to macOS is my reading of the "unified" swatch naming, since no separate macOS table remains. Treat macOS applicability as UNVERIFIED but very likely.
- **Don't hard-code these values in native code.** The HIG says "Avoid hard-coding system color values in your app … The actual color values may fluctuate from release to release". On the web you have no choice, so treat these as tokens.

| Name (SwiftUI) | Light | Dark | Light, Increased Contrast | Dark, Increased Contrast | Pre-2025 light → dark (for comparison)¹ |
|---|---|---|---|---|---|
| red | `#FF383C` (255,56,60) | `#FF4245` (255,66,69) | `#E9152D` | `#FF6165` | #FF3B30 → #FF453A |
| orange | `#FF8D28` (255,141,40) | `#FF9230` (255,146,48) | `#C55300` | `#FFA056` | #FF9500 → #FF9F0A |
| yellow | `#FFCC00` (255,204,0) | `#FFD600` (255,214,0) | `#A16A00` | `#FEDF43` | #FFCC00 → #FFD60A |
| green | `#34C759` (52,199,89) | `#30D158` (48,209,88) | `#008932` | `#4AD968` | unchanged |
| mint | `#00C8B3` (0,200,179) | `#00DAC3` (0,218,195) | `#008575` | `#54DFCB` | #00C7BE → #63E6E2 |
| teal | `#00C3D0` (0,195,208) | `#00D2E0` (0,210,224) | `#008198` | `#3BDDEC` | see ² |
| cyan | `#00C0E8` (0,192,232) | `#3CD3FE` (60,211,254) | `#007EAE` | `#6DD9FF` | #32ADE6 → #64D2FF |
| blue | `#0088FF` (0,136,255) | `#0091FF` (0,145,255) | `#1E6EF4` | `#5CB8FF` | #007AFF → #0A84FF |
| indigo | `#6155F5` (97,85,245) | `#6D7CFF` (109,124,255) | `#564ADE` | `#A7AAFF` | #5856D6 → #5E5CE6 |
| purple | `#CB30E0` (203,48,224) | `#DB34F2` (219,52,242) | `#B02FC2` | `#EA8DFF` | #AF52DE → #BF5AF2 |
| pink | `#FF2D55` (255,45,85) | `#FF375F` (255,55,95) | `#E7124D` | `#FF8AC4` | unchanged |
| brown | `#AC7F5E` (172,127,94) | `#B78A66` (183,138,102) | `#956D51` | `#DBA679` | #A2845E → #AC8E68 |

¹ The pre-2025 column comes from Flutter `CupertinoColors` (`flutter/flutter` master, `packages/flutter/lib/src/cupertino/colors.dart` lines 134-293), which mirrors UIKit iOS 13+ values [V-3p]. Its increased-contrast values differ from the 2025 ones.

² Flutter's `systemTeal` is #5AC8FA → #64D2FF. That is the pre-iOS-15 teal, and later iOS versions renamed and adjusted it. I believe the iOS 15-18 teal was #30B0C7 → #40C8E0 (UNVERIFIED).

**Biggest visible changes:** the default **blue moved from #007AFF to #0088FF**, purple and indigo got more saturated, and red, orange, and cyan shifted.

**Accent color on the web:** set `accent-color: #0088FF` (light) / `#0091FF` (dark) so native checkboxes and range inputs match.

### 2.2 Gray ramp (iOS/iPadOS; unchanged vs pre-2025) [V]

Source: HIG Color, "iOS, iPadOS system gray colors", swatches `ios-default-systemgray*.png` / `ios-accessible-*`. They match Flutter `systemGrey…systemGrey6` exactly (colors.dart lines 302-377).

| Name | Light | Dark | Light, Increased Contrast | Dark, Increased Contrast |
|---|---|---|---|---|
| systemGray (SwiftUI `gray`) | `#8E8E93` | `#8E8E93` | `#6C6C70` | `#AEAEB2` |
| systemGray2 | `#AEAEB2` | `#636366` | `#8E8E93` | `#7C7C80` |
| systemGray3 | `#C7C7CC` | `#48484A` | `#AEAEB2` | `#545456` |
| systemGray4 | `#D1D1D6` | `#3A3A3C` | `#BCBCC0` | `#444446` |
| systemGray5 | `#E5E5EA` | `#2C2C2E` | `#D8D8DC` | `#363638` |
| systemGray6 | `#F2F2F7` | `#1C1C1E` | `#EBEBF0` | `#242426` |

### 2.3 Semantic UI colors (iOS) [V-3p; values not published in the HIG]

The HIG lists these colors' *roles* (`hig-color.txt` lines 56-70) but no values. The values below are from Flutter `CupertinoColors` (`colors.dart` lines 382-639), which are the UIKit values used since iOS 13. **Whether iOS 26 changed any of these is UNVERIFIED.** The HIG's 2025 changelog mentions "system color values" only. The gray ramp is unchanged, and I found no evidence of label or background changes.

Format: `rgba(r,g,b,alpha)`; alpha = ARGB byte/255, rounded.

| Name | Light | Dark (base) | Dark (elevated) | Notes |
|---|---|---|---|---|
| label | `#000000` | `#FFFFFF` | `#FFFFFF` | |
| secondaryLabel | `rgba(60,60,67,0.60)` | `rgba(235,235,245,0.60)` | same | Increased Contrast α = 0.68 |
| tertiaryLabel | `rgba(60,60,67,0.30)` | `rgba(235,235,245,0.30)` | same | Increased Contrast α = 0.38 |
| quaternaryLabel | `rgba(60,60,67,0.18)` | `rgba(235,235,245,0.16)` | same | Increased Contrast α = 0.26 / 0.24 |
| placeholderText | `rgba(60,60,67,0.30)` | `rgba(235,235,245,0.30)` | same | |
| systemFill | `rgba(120,120,128,0.20)` | `rgba(120,120,128,0.36)` | same | |
| secondarySystemFill | `rgba(120,120,128,0.16)` | `rgba(120,120,128,0.32)` | same | |
| tertiarySystemFill | `rgba(118,118,128,0.12)` | `rgba(118,118,128,0.24)` | same | |
| quaternarySystemFill | `rgba(116,116,128,0.08)` | `rgba(118,118,128,0.18)` | same | |
| separator | `rgba(60,60,67,0.29)` | `rgba(84,84,88,0.60)` | `rgba(210,210,210,0.60)` | Increased Contrast α = 0.37 / 0.68 |
| opaqueSeparator | `#C6C6C8` | `#38383A` | `#38383A` | |
| link | `#007AFF` | `#0984FF` | | Pre-2025. On 26-series, use the new blue (UNVERIFIED that `link` followed it). |
| systemBackground | `#FFFFFF` | `#000000` | `#1C1C1E` | |
| secondarySystemBackground | `#F2F2F7` | `#1C1C1E` | `#2C2C2E` | |
| tertiarySystemBackground | `#FFFFFF` | `#2C2C2E` | `#3A3A3C` | |
| systemGroupedBackground | `#F2F2F7` | `#000000` | `#1C1C1E` | |
| secondarySystemGroupedBackground | `#FFFFFF` | `#1C1C1E` | `#2C2C2E` | |
| tertiarySystemGroupedBackground | `#F2F2F7` | `#2C2C2E` | `#3A3A3C` | |

- **Base vs. elevated** [V, HIG Dark Mode]: "the system uses two sets of background colors — called base and elevated … the background color automatically changes from base to elevated when an interface is in the foreground, such as a popover or modal sheet." Use the elevated column for sheets and popovers in dark mode.
- **macOS semantic colors** (labelColor, etc.) differ from iOS. My understanding is that macOS `labelColor` is `rgba(0,0,0,0.85)` / `rgba(255,255,255,0.85)` and `secondaryLabelColor` is `rgba(0,0,0,0.5)` / `rgba(255,255,255,0.55)`. These are UNVERIFIED (no primary source fetched). Use the iOS set above for a consistent cross-device PWA.
- **HIG contrast guidance** [V, Dark Mode page]: "make sure the contrast ratio between colors is no lower than 4.5:1 … strive for a contrast ratio of 7:1, especially in small text."

### 2.4 Activity ring colors [V], and why not to clone the rings

Source: HIG Activity rings (`dl/design/hig-activity-rings.txt`; swatch alt-text).

- **Colors:** Move `#FA114F` (250,17,79), Exercise `#A6FF00` (166,255,0), Stand `#00FFF6` (0,255,246).
- **The same page says not to clone them:**
  - "Use Activity rings only to show Move, Exercise, and Stand information … Don't replicate or modify Activity rings for other purposes. Never use Activity rings to display other types of data."
  - "Always display Activity rings on a black background."
- **Practice:** build *ring gauges* in the Activity *style* (thick round-capped concentric arcs) with **system colors** (for example CPU = blue, RAM = purple, disk = orange). Don't use the Move/Exercise/Stand triple on black. See §4.4.

### 2.5 CSS token sketch

```css
:root {
  --red:#FF383C; --orange:#FF8D28; --yellow:#FFCC00; --green:#34C759; --mint:#00C8B3; --teal:#00C3D0;
  --cyan:#00C0E8; --blue:#0088FF; --indigo:#6155F5; --purple:#CB30E0; --pink:#FF2D55; --brown:#AC7F5E;
  --gray:#8E8E93; --gray2:#AEAEB2; --gray3:#C7C7CC; --gray4:#D1D1D6; --gray5:#E5E5EA; --gray6:#F2F2F7;
  --label:#000; --label2:rgb(60 60 67/.6); --label3:rgb(60 60 67/.3); --label4:rgb(60 60 67/.18);
  --separator:rgb(60 60 67/.29); --fill:rgb(120 120 128/.2); --fill2:rgb(120 120 128/.16); --fill3:rgb(118 118 128/.12);
  --bg:#FFFFFF; --bg2:#F2F2F7; --bg3:#FFFFFF; --grouped:#F2F2F7; --grouped2:#FFFFFF;
}
@media (prefers-color-scheme: dark) { :root {
  --red:#FF4245; --orange:#FF9230; --yellow:#FFD600; --green:#30D158; --mint:#00DAC3; --teal:#00D2E0;
  --cyan:#3CD3FE; --blue:#0091FF; --indigo:#6D7CFF; --purple:#DB34F2; --pink:#FF375F; --brown:#B78A66;
  --gray:#8E8E93; --gray2:#636366; --gray3:#48484A; --gray4:#3A3A3C; --gray5:#2C2C2E; --gray6:#1C1C1E;
  --label:#FFF; --label2:rgb(235 235 245/.6); --label3:rgb(235 235 245/.3); --label4:rgb(235 235 245/.16);
  --separator:rgb(84 84 88/.6); --fill:rgb(120 120 128/.36); --fill2:rgb(120 120 128/.32); --fill3:rgb(118 118 128/.24);
  --bg:#000; --bg2:#1C1C1E; --bg3:#2C2C2E; --grouped:#000; --grouped2:#1C1C1E;
}}
```

Status mapping suggestion for Proxmox:
- running → `--green`
- stopped → `--gray`
- paused/suspended → `--yellow`
- error/failed task → `--red`
- migrating/backup in progress → `--blue`
- warning thresholds (e.g., disk > 85%) → `--orange`

---

## 3. Typography

### 3.1 iOS/iPadOS Dynamic Type, "Large (default)" [V]

Source: HIG Typography → Specifications (`dl/design/hig-typography.txt` lines 152-167). The "emphasized weight" column was added 2025-12-16.

| Style | Weight | Size (pt) | Leading (pt) | Emphasized | HIG tracking at that size (1/1000 em → CSS em) |
|---|---|---|---|---|---|
| Large Title | Regular | 34 | 41 | Bold | +12 → `0.012em` (0.40 pt) |
| Title 1 | Regular | 28 | 34 | Bold | +14 → `0.014em` (0.38 pt) |
| Title 2 | Regular | 22 | 28 | Bold | −12 → `-0.012em` (−0.26 pt) |
| Title 3 | Regular | 20 | 25 | Semibold | −23 → `-0.023em` (−0.45 pt) |
| Headline | **Semibold** | 17 | 22 | Semibold | −26 → `-0.026em` (−0.43 pt) |
| Body | Regular | 17 | 22 | Semibold | −26 → `-0.026em` |
| Callout | Regular | 16 | 21 | Semibold | −20 → `-0.02em` (−0.31 pt) |
| Subhead | Regular | 15 | 20 | Semibold | −16 → `-0.016em` (−0.23 pt) |
| Footnote | Regular | 13 | 18 | Semibold | −6 → `-0.006em` (−0.08 pt) |
| Caption 1 | Regular | 12 | 16 | Semibold | 0 |
| Caption 2 | Regular | 11 | 13 | Semibold | +6 → `0.006em` (0.06 pt) |

- **Other Dynamic Type sizes** (xSmall…xxxLarge, AX1-AX5) are in the same file (lines 104-297). For example, xSmall Body is 14/19 and AX5 is much larger.
- **Default and minimum sizes** [V]: iOS 17 pt / 11 pt; macOS 13 pt / 10 pt.
- **Weights** [V]: "prefer Regular, Medium, Semibold, or Bold … avoid Ultralight, Thin, and Light".

### 3.2 macOS built-in text styles [V]

Source: `hig-typography.txt` lines 299-312. macOS has no Dynamic Type.

| Style | Weight | Size | Line height | Emphasized |
|---|---|---|---|---|
| Large Title | Regular | 26 | 32 | Bold |
| Title 1 | Regular | 22 | 26 | Bold |
| Title 2 | Regular | 17 | 22 | Bold |
| Title 3 | Regular | 15 | 20 | Semibold |
| Headline | **Bold** | 13 | 16 | Heavy |
| Body | Regular | 13 | 16 | Semibold |
| Callout | Regular | 12 | 15 | Semibold |
| Subheadline | Regular | 11 | 14 | Semibold |
| Footnote | Regular | 10 | 13 | Semibold |
| Caption 1 | Regular | 10 | 13 | Medium |
| Caption 2 | **Medium** | 10 | 13 | Semibold |

(The task's "Caption 10" corresponds to Caption 1/2. Caption 2 is Medium weight.)

**Recommendation for a dashboard PWA used on iPhone and Mac:** use the iOS scale on touch/narrow layouts. On wide pointer layouts (`@media (hover:hover) and (min-width: 1024px)`), use the macOS scale or something between the two (body 13-15 px). Mac Safari users expect 13 pt body density.

### 3.3 Tracking table, SF Pro (iOS/iPadOS/visionOS; the macOS table is identical) [V]

Source: `hig-typography.txt` lines 457-528 (iOS) and 661-728 (macOS).

| Size (pt) | Tracking (1/1000 em) | Tracking (pt) |
|---|---|---|
| 6 | +41 | +0.24 |
| 7 | +34 | +0.23 |
| 8 | +26 | +0.21 |
| 9 | +19 | +0.17 |
| 10 | +12 | +0.12 |
| 11 | +6 | +0.06 |
| 12 | 0 | 0.0 |
| 13 | −6 | −0.08 |
| 14 | −11 | −0.15 |
| 15 | −16 | −0.23 |
| 16 | −20 | −0.31 |
| 17 | −26 | −0.43 |
| 18 | −25 | −0.44 |
| 19 | −24 | −0.45 |
| 20 | −23 | −0.45 |
| 21 | −18 | −0.36 |
| 22 | −12 | −0.26 |
| 23 | −4 | −0.10 |
| 24 | +3 | +0.07 |
| 25 | +6 | +0.15 |
| 26 | +8 | +0.22 |
| 27 | +11 | +0.29 |
| 28 | +14 | +0.38 |
| 29 | +14 | +0.40 |
| 30 | +14 | +0.40 |
| 32 | +13 | +0.41 |
| 34 | +12 | +0.40 |
| 36 | +10 | +0.37 |
| 40 | +10 | +0.37 |
| 48 | +8 | +0.35 |
| 56 | +6 | +0.30 |
| 64 | +4 | +0.22 |
| 72 | +2 | +0.14 |
| ≥80 | 0 | 0 |

SF Pro Rounded uses a *different, looser* table: 11 pt → +52, 13 → +40, 17 → +22 (lines 529-597).

**Does Safari apply this tracking automatically for `system-ui`?** The HIG says "In a running app, the system font dynamically adjusts tracking at every point size". Whether WebKit applies the same automatic tracking to `system-ui` / `-apple-system` text is **UNVERIFIED**. I found no tracking attribute in WebKit's CoreText font code via code search. Apply `letter-spacing` explicitly, and A/B-check against a native screenshot.

### 3.4 Font stacks on the web [V-3p]

| Value | Support | Source |
|---|---|---|
| `system-ui` | Safari 11+ (9+ prefixed), Chrome 56+, Firefox 92+ | BCD; caniuse `font-family-system-ui` |
| `ui-sans-serif`, `ui-serif`, `ui-monospace`, `ui-rounded` | **Safari 13.1+ only**. Chrome and Firefox: `false`. | BCD; caniuse `extended-system-fonts` |

- **WebKit internals** (`Source/WebCore/platform/graphics/cocoa/SystemFontDatabaseCoreText.cpp` lines 246-282):
  - `-apple-system`, `-apple-system-font`, `system-ui`, and `ui-sans-serif` all map to the system UI font.
  - `ui-serif` maps to New York, `ui-monospace` to SF Mono, and `ui-rounded` to SF Pro Rounded.
- **Dynamic Type on the web (WebKit only)** [V-3p]:
  - `font: -apple-system-body | -apple-system-headline | -apple-system-subheadline | -apple-system-footnote | -apple-system-caption1 | -apple-system-caption2 | -apple-system-title0…title4 | -apple-system-short-* | -apple-system-tall-body` (WebKit `Source/WebCore/css/CSSValueKeywords.in` lines 41-57, `enable-if=WTF_PLATFORM_COCOA`).
  - These map to CoreText `kCTUIFontTextStyle*` styles (`SystemFontDatabaseCoreText.cpp` lines 291-307, 424-454), which are the Dynamic Type styles.
  - On iOS they should follow the user's text-size setting. That is my understanding of CoreText text styles and is not runtime-tested here (UNVERIFIED).
  - Use them as a progressive enhancement inside `@supports (font: -apple-system-body)`.

```css
:root {
  --font-ui: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-rounded: ui-rounded, system-ui, -apple-system, "SF Pro Rounded", var(--font-ui);  /* rounded only in Safari */
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
body { font-family: var(--font-ui); font-size: 17px; line-height: 22px; letter-spacing: -0.026em;
       -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
.num, .metric, td.numeric { font-variant-numeric: tabular-nums; }  /* Safari 9.1+, Chrome 52+, FF 34+ [V-3p BCD] */
@supports (font: -apple-system-body) { .dt-body { font: -apple-system-body; } .dt-headline { font: -apple-system-headline; } }
```

- `"SF Pro …"` family names in the stack only resolve if the user has the fonts installed locally. **Never serve them** (§3.5).
- On non-Apple clients, `system-ui` resolves to Segoe UI or Roboto. That is fine.
- If you want SF-like metrics everywhere, self-host **Inter** (`@fontsource-variable/inter@5.3.0`, license **OFL-1.1** [V npm]). Inter has `tnum`.

### 3.5 Licensing: SF fonts and SF Symbols must not be bundled [V]

- **SF fonts.** The San Francisco font license text is embedded on https://developer.apple.com/fonts/ (`dl/fonts.html`, "APPLE INC. LICENSE AGREEMENT FOR THE APPLE SAN FRANCISCO FONT For iOS, OS X and tvOS application uses only", EA1370):
  - "2.A … you may use the Apple Font **solely for creating mock-ups of user interfaces** to be used in software products running on Apple's iOS, OS X or tvOS operating systems".
  - "2.B … You may not **embed** the Apple Font in any software programs or other products. Except as expressly provided for herein, you may not use the Apple Font to, create, develop, display or otherwise distribute any documentation, artwork, **website content** or any other work product … you may not make the Apple Font available over a network".
  - **So you can't `@font-face` SF Pro, SF Mono, or New York in the PWA.** Using `system-ui` / `-apple-system` is different: it asks the *OS* to render its own font locally and distributes nothing.
- **SF Symbols.**
  - The HIG SF Symbols page says: "Be sure to understand the terms and conditions for using SF Symbols, including the prohibition against using symbols — or images that are confusingly similar — in app icons, logos, or any other trademarked use" (`hig-sf-symbols.txt` line 6).
  - The full SF Symbols license ships inside the SF Symbols app download (https://developer.apple.com/sf-symbols/ → `SF-Symbols-27.dmg`). I could not read it here.
  - Secondary sources and an Apple forum reply (page blocked by a bot check) state that SF Symbols are "system-provided images" under the Xcode/SDK license and that use on websites is against the license. **Exact wording is UNVERIFIED.** Treat it as **do not ship SF Symbols SVGs/glyphs in the web app.**
- **Icon alternatives** [V via `npm view`, 2026-10-10]:

| Package | Latest | License | Notes |
|---|---|---|---|
| `lucide-react` / `lucide` | 1.54.0 | **ISC** | Clean 2px-stroke outline set. Closest everyday match to SF Symbols "regular" weight. Stroke width is configurable (use 1.75-2 to match SF regular/medium). |
| `@phosphor-icons/react` | 2.1.10 | **MIT** | 6 weights (thin…bold, fill, duotone). Good for SF-like weight matching and filled tab icons (HIG: "Prefer filled symbols" in tab bars). |
| `@tabler/icons-react` | 3.49.0 | **MIT** | Large set with many infra glyphs (server, database, cpu). |
| `framework7-icons` | 5.0.5 (2021) | **MIT** | Explicitly "iOS-icons font". Closest *look* to Apple's style, but old. |
| `iconoir-react` | 7.12.1 | **MIT** | |
| `@heroicons/react` | 2.2.0 | **MIT** | Small set. |

Recommendation: use **Phosphor** (regular for toolbars, fill for selected tab/sidebar) or **Lucide** throughout. Match icon weight to adjacent text weight, as SF Symbols do.

---

## 4. Standard metrics

### 4.1 What Apple documents [V]

**Hit targets and control sizes.** Source: HIG Accessibility (`hig-accessibility.txt` lines 61-67) and HIG Buttons (`hig-buttons.txt` line 12).

| Platform | Default control size | Minimum control size |
|---|---|---|
| iOS, iPadOS | 44×44 pt | 28×28 pt |
| macOS | 28×28 pt | 20×20 pt |
| visionOS | 60×60 pt | 28×28 pt |

- "a button needs a hit region of at least 44x44 pt".
- Spacing: "about 12 points of padding around elements that include a bezel … about 24 points … around elements without a bezel."

**Shapes.** Fixed, capsule (radius = h/2), and concentric (inner radius = outer radius − padding). See §1.4.
- macOS 26: Mini, Small, and Medium controls are rounded rectangles; Large and X-Large are capsules.
- iOS 26 bordered buttons are capsules by default.

**Split view.** The thin divider "measures one point in width". The default split is 1/3 primary : 2/3 secondary (`hig-split-views.txt` lines 31-35).

**Toolbar.** Max about 3 groups; titles under 15 characters.

**Segmented control.** Aim for "no more than about five to seven segments in a wide interface and no more than about five segments on iPhone". Segments are equal width. Use text *or* images, not both (`hig-segmented-controls.txt`).

**Switch.**
- iOS: "Use the switch toggle style only in a list row". The default on-color is green.
- macOS: "consider using a mini switch" in grouped form rows (`hig-toggles.txt`).

### 4.2 Not documented by Apple (UNVERIFIED best understanding, use as starting points)

**Corner radii**
- **macOS 26 window corner radius.** Apple says only "larger" for toolbar windows and "smaller" for titlebar-only windows (WWDC 310). Community reports cluster around ~26 pt for toolbar windows; a MacRumors thread snippet said "26 is Tahoe's standard, 20 is Golden Gate's standard, 10 is for previous versions". Pre-Tahoe windows were about 10 pt.
  - Web value: **outer app frame 24-26 px**.
  - Floating sidebar inset about 8 px from the window edge, so its radius ≈ 26 − 8 = **18 px** (concentric).
  - Toolbar capsule groups use height/2 (for example a 36 px tall group → 18 px).
- **iOS 26 sheets/cards.**
  - Partial sheets are inset and concentric with the display corners. iPhone display corner radii are roughly 39-62 pt depending on model (UNVERIFIED).
  - Web: bottom sheet `border-radius: 28px` with an 8 px inset from the screen edges, and `env(safe-area-inset-bottom)` padding.
  - Cards/insets: 16-22 px (grouped-list "inset" style about 10-12 pt historically; iOS 26 looks larger, ≈ 20-26 pt).
- **Content cards inside a 24 px window with 12 px padding:** use a 12 px radius, or keep a fixed 16-20 px if not nested. Watch for "pinched" corners.

**Sidebar**
- Width: **220-260 px**. This is a convention (Finder/Mail default about 220-240), not documented. Collapse under about 900 px of viewport width. The HIG only says "Consider automatically hiding and revealing a sidebar when its container window resizes".
- macOS sidebar row heights by icon size: about 24 / 28 / 32 pt (small / medium / large).

**Toolbar and bars**
- macOS unified toolbar height: about 52 pt (pre-26), similar or slightly taller in 26. Web: 52 px bar with 32-36 px tall control capsules.
- iOS nav bar: 44 pt (standard); large-title area +52 pt.
- iOS 26 floating tab bar: a capsule about 62-64 pt tall, inset about 20 pt from the sides.
- Pre-26 tab bar: 49 pt plus the home-indicator safe area.

**Lists**
- iOS default row 44 pt (consistent with the 44 pt hit target); subtitle rows about 60 pt.
- macOS table rows: 24 pt (medium), 20 pt (small); recent macOS list rows about 28 pt.

**Spacing grid**
- An 8 pt grid (4 pt half-steps) is a common Apple-design-resource convention, but **not stated in the HIG** (I searched the Layout page).
- Margins: iOS 16 pt (20 pt on larger iPhones); macOS 20 pt window margins.

**Switch**
- UISwitch pre-26 is 51×31 pt (UNVERIFIED); iOS 26 looks wider and flatter (≈ 63×28; UNVERIFIED).
- Thumb is white with a soft shadow. On press, the thumb stretches and becomes a clear glass lens (WWDC 219, 250-268 s describes "lift up into Liquid Glass" for controls). The HIG Materials page says toggles and sliders take on Liquid Glass when activated [V].
- CSS: track `--fill` (off) → `--green` (on); thumb `#fff` + `0 2px 6px rgb(0 0 0/.18)`; on `:active`, thumb width +30% and `backdrop-filter` glass for 150 ms.

**Segmented control (iOS 26 look)**
- Capsule track in `--fill3`, with the selected segment as a raised capsule "thumb" in `--bg` (light) / `rgba(255,255,255,.2)` (dark), plus a shadow `0 3px 8px rgb(0 0 0/.12)`.
- Track height 32 pt; segment labels 13-15 pt semibold.
- Thumb slides with a snappy spring. During drag the thumb lens-magnifies. This is like the slider/toggle lift; that segmented controls get it is UNVERIFIED.

### 4.3 Motion: SwiftUI springs and CSS equivalents [V math + RECIPE]

**Facts** (`dl/design/swiftui/*.json`):
- `spring(duration: 0.5, bounce: 0.0, blendDuration: 0)` defaults.
- `.smooth` has base bounce 0, `.snappy` has base bounce **0.15**, `.bouncy` has base bounce **0.3**; all default to duration 0.5 s.
- `Animation.default` is `spring(response: 0.55, dampingFraction: 1.0)` since iOS 17 / macOS 14.
- `Spring(duration: 0.5, bounce: 0.3)` gives mass 1, stiffness 157.9, damping 17.6.

**Derived conversion** (checked against Apple's example):
- stiffness = (2π / duration)²
- damping ratio ζ = 1 − bounce (for bounce ≥ 0)
- damping = 4π(1 − bounce) / duration

CSS `linear()` is supported in Safari 17.2+, Chrome 113+, and Firefox 112+ [V-3p BCD]; Safari 17.4 "Fixed CSS `linear()` easing" (release notes). The curves below were generated by sampling the analytic step response (`scratchpad/tools/spring.py`). Each total time is the settle time to within 0.1%, so use it as `transition-duration`.

```css
:root {
  /* SwiftUI .smooth  (0.5s, bounce 0)    -> 740ms */
  --spring-smooth: linear(0, 0.023, 0.08, 0.155, 0.238, 0.324, 0.406, 0.484, 0.555, 0.618, 0.675, 0.724, 0.767, 0.804, 0.836, 0.863, 0.886, 0.905, 0.921, 0.935, 0.946, 0.955, 0.963, 0.97, 0.975, 0.98, 0.983, 0.986, 0.989, 0.991, 0.993, 0.994, 0.995, 0.996, 0.997, 0.997, 0.998, 0.998, 0.999, 0.999, 1);
  /* SwiftUI .snappy  (0.5s, bounce 0.15) -> 700ms, 0.6% overshoot */
  --spring-snappy: linear(0, 0.021, 0.075, 0.15, 0.235, 0.324, 0.413, 0.498, 0.576, 0.647, 0.71, 0.765, 0.812, 0.853, 0.886, 0.914, 0.936, 0.954, 0.968, 0.98, 0.988, 0.994, 0.999, 1.002, 1.004, 1.005, 1.006, 1.006, 1.006, 1.006, 1.005, 1.005, 1.004, 1.004, 1.003, 1.003, 1.002, 1.002, 1.002, 1.001, 1);
  /* SwiftUI .bouncy  (0.5s, bounce 0.3)  -> 820ms, 4.6% overshoot */
  --spring-bouncy: linear(0, 0.029, 0.104, 0.205, 0.32, 0.438, 0.551, 0.655, 0.746, 0.824, 0.888, 0.939, 0.978, 1.006, 1.026, 1.038, 1.044, 1.046, 1.045, 1.042, 1.037, 1.032, 1.026, 1.021, 1.016, 1.012, 1.008, 1.005, 1.003, 1.001, 1, 0.999, 0.998, 0.998, 0.998, 0.998, 0.998, 0.998, 0.999, 0.999, 1);
  /* quicker "glass" spring (0.35s, bounce 0.2) -> 480ms, 1.5% overshoot (RECIPE) */
  --spring-glass: linear(0, 0.021, 0.074, 0.147, 0.233, 0.324, 0.414, 0.501, 0.583, 0.656, 0.722, 0.78, 0.829, 0.871, 0.905, 0.933, 0.956, 0.974, 0.987, 0.997, 1.005, 1.01, 1.013, 1.014, 1.015, 1.015, 1.014, 1.013, 1.012, 1.011, 1.009, 1.008, 1.007, 1.006, 1.005, 1.004, 1.003, 1.002, 1.002, 1.001, 1);
  --ease-fallback: cubic-bezier(0.32, 0.72, 0, 1);   /* common iOS-sheet-like approximation (UNVERIFIED as Apple's) */
}
.sheet { transition: transform 700ms var(--spring-snappy, var(--ease-fallback)); }
@media (prefers-reduced-motion: reduce) { * { transition-duration: 1ms !important; animation-duration: 1ms !important; } }
```

- Apple's "materialize" transitions (blur + scale) can be approximated as `filter: blur(8px)`, `scale(.96)`, `opacity: 0` → normal, over about 300 ms on the element itself. Remember the backdrop-root rule.
- HIG Motion [V]: "Add motion purposefully … Make motion optional … avoid adding motion to UI interactions that occur frequently … Let people cancel motion."

### 4.4 Ring gauges, Activity *style* (RECIPE; see §2.4 for the HIG restriction)

- Concentric arcs. Stroke width ≈ 14-18% of the outer diameter. Gap between rings ≈ 2-4 px, or about 10% of the stroke. Outer margin ≥ the gap; the HIG requires that for real Activity rings [V].
- `stroke-linecap: round`. The track is the same hue at 20-25% alpha, which is how Apple's rings look (appearance UNVERIFIED).
- Progress uses an angular gradient from a darker to a lighter shade of the hue. Over 100% the arc overlaps itself with an end-cap shadow.
- SVG: `<circle r=… pathLength="100" stroke-dasharray="{p} 100" transform="rotate(-90)">`. For a gradient along the arc, use a CSS `conic-gradient` on a div masked by a ring (`mask: radial-gradient(farthest-side, transparent calc(100% - var(--w)), #000 calc(100% - var(--w) + 1px))`) plus round caps drawn as two small circles.
- Animate `stroke-dasharray` with `--spring-smooth`, about 700-900 ms.
- Colors: use system blue/purple/orange/green on `--bg2`, **not** `#FA114F/#A6FF00/#00FFF6` on black.

---

## 5. Homelab app icons: dashboard-icons (homarr-labs) [V]

Source: `homarr-labs/dashboard-icons` README and LICENSE, fetched via raw.githubusercontent.com (`dl/design/dashicons/README.md`, `LICENSE`).

- **URL pattern** (README lines 45-57): `<Base URL>/<Format>/<Icon Name>.<Format>`.
  - jsDelivr (recommended by the README): `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons`
  - GitHub direct: `https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main`
  - Example: `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/plex.svg`
- **Formats.**
  - SVG is the "original source".
  - PNG and WEBP are "512px height (auto-generated)".
  - Not every icon has an SVG. `metadata.json` lists 3385 icons, of which 2652 have `"base": "svg"` and 733 have `"base": "png"`. `tree.json` lists 2255 svg, 2799 png, and 2799 webp files.
  - **For a guaranteed hit, use `webp` or `png`**, or check `tree.json` first.
- **Naming.**
  - Kebab-case.
  - The `-light` suffix is the variant **for dark backgrounds**; `-dark` is for light backgrounds.
  - Metadata may carry `"colors": {"dark": "proxmox", "light": "proxmox-light"}`.
- **Verification (2026-10-10).**
  - `cdn.jsdelivr.net` is **not reachable** from this research container: the egress proxy returns 403, and WebFetch fails DNS. So jsDelivr URLs are **UNVERIFIED** here, though they follow the README.
  - The same paths via `raw.githubusercontent.com/homarr-labs/dashboard-icons/main/…` returned **HTTP 200** for: `svg|png|webp/jellyfin`, `svg|png|webp/proxmox`, `svg/proxmox-light`, `home-assistant`, `plex`, `portainer`, `pi-hole`, `adguard-home`, `truenas`, `nextcloud`, `grafana`, `docker`, `unraid`, `opnsense`, `pfsense`, `uptime-kuma`, `nginx-proxy-manager`, `vaultwarden`, `immich`, `frigate`, `linux`, `proxmox-backup-server`, `tailscale`, `wireguard`, `syncthing`, `paperless-ngx`, `sonarr`, `radarr`, `traefik`, `caddy`, `homarr`, `ollama`, `minecraft`.
  - **404:** `svg/debian.svg`, `svg/ubuntu.svg`, `svg/windows.svg`. The real slugs are `debian-linux`, `ubuntu-linux`, `microsoft-windows`, `alpine-linux`, `arch-linux`, `fedora`, `rocky-linux`, `centos`, `opensuse`, `nixos`, `truenas-scale`, `truenas-core`, `openmediavault`, `kubernetes`, `talos`, `ceph`, `gitea`, `forgejo`, `gitlab`; all present in svg/png/webp per `tree.json`.
  - `windows-11` is png/webp only.
  - **Not present:** `almalinux`, `freebsd`, `zfs`, `pbs`, `qemu`, `lxc`, `linux-containers`, `k3s`. Use a generic Lucide/Phosphor glyph for LXC (box/container) and QEMU VM (monitor/cpu).
- **jsDelivr behavior** [V, jsDelivr README at `raw.githubusercontent.com/jsdelivr/jsdelivr/master/README.md`]:
  - `/gh/user/repo@version/file`. Omitting the version gives "latest", which "Falls back to the repository's default branch if there are no tagged releases".
  - Caching: branches 12 h, version aliases 7 days, pinned versions/commits effectively forever. Pin a commit SHA for stability: `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@<sha>/webp/proxmox.webp`.
  - Limits: "Packages larger than 150 MB or single files larger than 20 MB (in the case of GitHub) are not supported by default". Individual icon files are tiny.
- **License.** **Apache License 2.0** (LICENSE). The README's legal note: "All product names, trademarks, and registered trademarks are the property of their respective owners. Icons are used for identification purposes only".
- **LAN-only PWA recommendation.** Don't hot-link at runtime. Either:
  - (a) vendor the handful of needed icons into the build (Apache-2.0 allows it; keep the LICENSE/NOTICE), or
  - (b) proxy through the backend with an on-disk cache, plus a service-worker `CacheFirst` rule.
  The dashboard then keeps working offline or when jsDelivr is blocked.
- **Icon mapping JSON example** (the format the backend could serve to the UI):

```json
{
  "iconBase": "/icons",
  "icons": {
    "100": { "slug": "home-assistant", "format": "webp" },
    "101": { "slug": "jellyfin",        "format": "svg"  },
    "102": { "slug": "pi-hole",         "format": "svg"  },
    "node:pve1": { "slug": "proxmox", "variantDark": "proxmox-light", "format": "svg" },
    "os:debian": { "slug": "debian-linux", "format": "svg" }
  }
}
```

---

## 6. Split-flap (Solari) departure board

### 6.1 Background facts

- **History** (web search summaries; pages not fetched, so treat specifics as UNVERIFIED):
  - Solari di Udine was founded 1948 (Fermo and Remigio Solari).
  - Architect **Gino Valle** designed the Cifra 5 flip clock, described as "a roller with 40 flaps". The alphanumeric airport/station displays he designed "in 1962 won the Compasso d'Oro" (Fondazione Pirelli).
  - Solari became the 1960s standard supplier to European railways and airports.
- **Real mechanism, from an open-source split-flap display** [V-3p] (`scottbez1/splitflap`, Apache-2.0, `firmware/src/config.h`, `splitflap_module.h`, `generate_acceleration.py`):
  - **Character drum.** Each module is one spool of flaps rotating in one direction only. To get from A to Z it must pass through every character in between. v2 has **52 flaps**: `' ' A–Z g 0–9 r . ? - $ ' # y p , ! @ & w`, where lowercase letters are color blocks (g=green, r=red, y=yellow, p=purple, w=white). The legacy set has 40 flaps: `' ' A–Z 0–9 . , '`. The first flap is "home" (blank).
  - **Speed.** Stepper with `STEPS_PER_REVOLUTION 2048`, `MIN_PERIOD_MICROS 1600`, `ACCEL_TIME_MICROS 200000`. At full speed that is 2048/52 ≈ 39.4 steps per flap × 1.6 ms ≈ **63 ms per flap (≈ 16 flaps/s)**, after a 200 ms acceleration ramp. A full revolution takes ≈ 3.3 s.
  - Real Solari units are UNVERIFIED but similar: tens of ms per flap. Hence the familiar rippling clatter.

### 6.2 Visual anatomy (RECIPE, informed by the libraries below)

- **Cell.** A dark rounded rectangle (radius about 6-10% of the height) split into a top half and a bottom half.
  - A horizontal **hinge line** at 50%, about 0.04 em (react-split-flap-effect) or 1 px (react-split-flap).
  - A tiny **gap** shows between the halves, about 1-2 px of darker background.
  - Optional small "axle pins" at the left and right ends of the hinge.
  - Top half is slightly lighter than the bottom half (overhead light). Add a subtle inner shadow at the top of the bottom half where the upper flap overlaps.
- **Character.** Bold condensed sans or a monospace grotesk, centered. Each half shows half the glyph:
  - top: `clip-path: polygon(0 0,100% 0,100% 50%,0 50%)`
  - bottom: `clip-path: polygon(0 50%,100% 50%,100% 100%,0 100%)`
  - Or use `overflow:hidden` half-height boxes containing a full-height glyph offset by −50%. This is cheaper and pixel-stable.
- **Flip sequence for one step** (old char X → next char Y). The cell holds four faces:
  1. Static top shows **Y** (revealed behind the falling flap).
  2. Static bottom shows **X** (until covered).
  3. Falling top flap shows **X**: `transform-origin: bottom; rotateX(0 → -90deg)`, ease-in, first half of the step.
  4. Rising bottom flap shows **Y**: `transform-origin: top; rotateX(90deg → 0)`, ease-out, second half, often with a slight bounce (react-split-flap-effect keyframes: 50% 90° → 80% 0° → 90% 20° → 100% 0°).
  - Darken the falling face as it rotates (shade overlay opacity 0 → 0.5) and brighten the rising face. This sells the 3D.
  - **Multi-step:** run steps through the drum order from the current to the target character at the step interval. Libraries use 30 ms (`react-split-flap-effect` "timing" default; README says "Numbers from 10-50 work best") or **60 ms** (`react-split-flap` "Interval between physical flap steps"). The final flip runs at **300 ms** (both) or **160 ms** ("performance-mode").
  - At 30-60 ms per step a full 3D rotation isn't visible anyway. For intermediate steps, simply swap glyphs with a quick 2-frame darkening of the bottom half. Play the full 3D animation only on the final step (this is what both libraries do) [V-3p].
- **3D context.** Set `perspective` on the board or each cell (react-split-flap: `perspective:1000px` on the display; use 300-600 px per cell for a more dramatic effect). Use `backface-visibility: hidden` on flap faces (Safari 15.4+ unprefixed; `-webkit-` since 5.1 [V-3p BCD]).
- **Colors**

| Scheme | Board / bezel | Flap top → bottom | Glyph | Notes |
|---|---|---|---|---|
| Classic Solari | `#0E0E0F` / `#1A1A1A` | `#262626` → `#1C1C1C` | white `#F2F2F2` | Hinge `#000`. react-split-flap dark theme: part gradient `linear-gradient(184deg,#212121 0,#191919 25%)`, border `#222` [V-3p]. |
| Yellow-character variant | as above | as above | `#FFD400` | Yellow-on-black boards are common at stations (UNVERIFIED as a Solari standard). |
| Retro-futuristic amber | `#0B0805` | `#1B140C` → `#130E08` | amber `#FFB000` + `text-shadow: 0 0 6px rgb(255 176 0/.55)` | Optional faint scanline overlay; CRT-phosphor feel (design choice). |
| Status column chips | — | flap-colored blocks | — | Mirrors the real color-block flaps (g/r/y/w): green = ON TIME/RUNNING, yellow = DELAYED/WARN, red = CANCELLED/ERROR. |

- **Typical columns.** TIME (HH:MM) · DESTINATION (12-20 chars) · PLATFORM / TRACK (2-3 chars) · REMARKS (ON TIME, DELAYED, BOARDING, CANCELLED, DEPARTED, GATE CLOSED).
  - Fixed-width columns. Pad with blanks (the drum's "home" flap).
  - REMARKS is often a *word flap* (one wide flap per status word) rather than characters. react-split-flap supports `mode: 'words'` with `chars={['ON TIME','DELAYED','CANCELLED']}` [V-3p].
- **Mapping to Proxmox (suggested; field names must come from the API reference docs, not here).** Use one "departures" row per scheduled/recent task or per guest:

```json
{
  "board": "PVE1 DEPARTURES",
  "columns": [
    { "key": "time",   "label": "TIME",        "width": 5,  "align": "left"  },
    { "key": "dest",   "label": "DESTINATION", "width": 16, "align": "left"  },
    { "key": "plat",   "label": "PLAT",        "width": 4,  "align": "right" },
    { "key": "remark", "label": "REMARKS",     "width": 9,  "mode": "words",
      "words": ["", "ON TIME", "RUNNING", "BOARDING", "DELAYED", "STOPPED", "CANCELLED", "DEPARTED"] }
  ],
  "charset": " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-/'#&!?",
  "rows": [
    { "time": "02:30", "dest": "VZDUMP 101 HASS",  "plat": "101", "remark": "ON TIME",   "color": "green"  },
    { "time": "03:00", "dest": "VZDUMP 102 JF",    "plat": "102", "remark": "DELAYED",   "color": "yellow" },
    { "time": "03:15", "dest": "ZFS SCRUB RPOOL",  "plat": "PVE1", "remark": "BOARDING", "color": "blue"   },
    { "time": "04:00", "dest": "REPLICATION 110",  "plat": "110", "remark": "CANCELLED", "color": "red"    }
  ]
}
```

  Cell count: (5+16+4+9) × 6 rows ≈ 200 cells.
- **Design-language note.** Per Apple's rules, the board is *content*. Render it as an opaque, physical-looking object in the content layer, with no Liquid Glass on or inside it. Glass toolbars may float above it.

### 6.3 Performance for ~200 animated cells (RECIPE + [V-3p] library practice)

- **Animate only `transform` (and `opacity`).** Keep clip-paths *static*. Prefer half-height `overflow:hidden` boxes over clip-path when targeting older Safari. react-split-flap-effect's README notes Chrome subpixel half-misalignment and suggests fixed pixel widths.
- **Containment.** Per cell, use `contain: layout paint style` (or `contain: strict` with a fixed cell size; react-split-flap uses `contain: layout style paint`, and `strict` in performance mode) [V-3p]. Use **fixed px sizes** per cell.
- **One clock.** Drive everything from a single `requestAnimationFrame` scheduler (react-split-flap "shares its animation clock, batches character cursors"). Don't use 200 `setInterval`s.
  - Each cell keeps `{current, target, nextStepAt}`.
  - Each frame, advance the cells whose `nextStepAt <= now`, then batch DOM writes. Swap `textContent` and toggle a class that starts a CSS keyframe of `final ? 300 : 0` ms.
- **`will-change: transform`** only on the two moving faces *while flipping*. Remove it afterwards to avoid ~800 permanent layers.
- **Stagger.** Start column *i* after `i × 15-25 ms` and row *r* after `r × 40 ms`. This gives the left-to-right ripple and spreads compositor load.
- **Cap concurrency.** For example, at most about 120 cells mid-final-flip at once; queue the rest.
- **No new frames for no reason.** Pause the clock when `document.hidden` or when the board is off-screen (IntersectionObserver). "Producing a new frame every requestAnimationFrame does not make a mechanical flap animation smoother" (react-split-flap README).
- **Accessibility.**
  - `prefers-reduced-motion: reduce` → set final characters instantly, or use a 120 ms crossfade.
  - Give the row an `aria-label` with the final text, and `aria-live="polite"` on a hidden text mirror, not on the 200 animated cells.
- **3D in Safari.** Keep the board outside any `backdrop-filter` / `filter` ancestor. WebKit flattens 3D under filters.
- **Minimal cell CSS**

```css
.flap { --h: 44px; --w: 30px; position: relative; width: var(--w); height: var(--h); perspective: 400px;
        contain: layout paint style; border-radius: 4px; background: #1c1c1c; color: #f2f2f2;
        font: 700 calc(var(--h)*.72)/var(--h) ui-monospace, "JetBrains Mono", monospace; text-align: center; }
.flap > .half { position: absolute; left: 0; right: 0; height: 50%; overflow: hidden; backface-visibility: hidden;
        -webkit-backface-visibility: hidden; background: inherit; }
.flap > .half > span { display: block; height: var(--h); }
.flap > .top    { top: 0;   border-radius: 4px 4px 0 0; background: #232323; }
.flap > .bottom { bottom: 0; border-radius: 0 0 4px 4px; }
.flap > .bottom > span { transform: translateY(-50%); }
.flap > .fall { transform-origin: 50% 100%; }              /* top flap, rotates down */
.flap > .rise { transform-origin: 50% 0;   transform: rotateX(90deg); }
.flap.final > .fall { animation: fall 150ms ease-in forwards; }
.flap.final > .rise { animation: rise 150ms 150ms cubic-bezier(.3,1.5,.5,1) forwards; } /* small bounce */
@keyframes fall { to { transform: rotateX(-90deg); filter: brightness(.6); } }
@keyframes rise { from { transform: rotateX(90deg); filter: brightness(.6); } to { transform: rotateX(0); filter: none; } }
.flap::after { content: ""; position: absolute; left: 0; right: 0; top: calc(50% - .5px); height: 1px; background: #000; z-index: 3; } /* hinge */
@media (prefers-reduced-motion: reduce) { .flap.final > .fall, .flap.final > .rise { animation: none; } }
```

(`filter` inside keyframes on a small element is fine, but if profiling shows cost, use an overlay `opacity` instead.)

### 6.4 Synthesizing the "clack" with Web Audio (RECIPE + [V] API rules)

**Sound design (RECIPE).** A flap clack is a very short broadband transient: a plastic or aluminium flap striking a stop. Synthesize it as:
- A white-noise burst of about 25-40 ms through a **band-pass** (center about 2.5-4.5 kHz, Q about 1-3) with a 0.5-1 ms attack and an exponential decay of about 15-35 ms.
- Plus an optional low "thock" body: a band-passed noise or sine burst at about 150-300 Hz, decaying in about 20-40 ms, at −12 dB.
- Randomize the center frequency ±10%, gain ±2 dB, and decay ±20% per hit, so 200 flaps don't sound like a machine gun.
- A real board is a *swarm* of clicks. Don't play one voice per cell-step. Aggregate per frame instead: in each rAF tick, compute how many steps happened (N) and schedule `min(N, 6)` voices spread randomly over the next ~16 ms, with gain scaled by about `1/sqrt(voices)`.

```js
let ctx, noiseBuf;
function initAudio() {                      // MUST be called from a user gesture handler (click/touchend/keydown)
  ctx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') ctx.resume(); // 'suspended' or WebKit's 'interrupted'
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.06), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
}
function clack(t = ctx.currentTime, gain = 0.25) {
  const src = ctx.createBufferSource(); src.buffer = noiseBuf;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = 3200 * (0.9 + Math.random() * 0.2); bp.Q.value = 1.6;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.001);           // 1 ms attack
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);          // ~30 ms decay; target must be > 0
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t); src.stop(t + 0.05);
}
```

**API rules [V]**
- `exponentialRampToValueAtTime`: "A RangeError exception MUST be thrown if this value is equal to 0" (Web Audio spec, `WebAudio/web-audio-api` `index.bs:4471`). Ramp to 0.0001, not 0.
- `setTargetAtTime` with `timeConstant` is an alternative exponential decay (`index.bs:4563`).
- `BiquadFilterNode` type `"bandpass"` (`index.bs:6535`).

**Autoplay / iOS unlock [V]**
- The Web Audio spec says "A user agent may disallow this initial transition [suspended→running], and to allow it only when the AudioContext's relevant global object has sticky activation" (`index.bs:1510-1514`).
- MDN Web Audio best practices: "Create or resume context from inside a user gesture" and check `audioCtx.state === "suspended"` → `resume()` (`mdn/content …/web_audio_api/best_practices/index.md:37-67`).
- Safari 16.4 release notes: "Fixed only requiring a transient user activation for Web Audio rendering" (`dl/apple/safari-release-notes_safari-16_4-release-notes.txt:206`). So call `initAudio()` inside a `click`/`touchend`/`keydown` handler, for example a "Sound on" toggle in the toolbar.
- The `AudioContextState` enum includes **`"interrupted"`** (spec `index.bs:725-730`; WebKit `AudioContextState.idl`). iOS moves the context there on calls, Siri, or app switches. Listen to `ctx.onstatechange` and re-`resume()` on the next gesture.

**iOS Ring/Silent switch [V]**
- WebKit chooses the AVAudioSession category automatically. If the page only uses Web Audio, the category is `AmbientSound` (`Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm:193-194`), which maps to `AVAudioSessionCategoryAmbient` (`ios/AudioSessionIOS.mm:216`).
- Apple's doc for `ambient`: "Screen locking and the Silent switch (on iPhone, the Ring/Silent switch) silence your audio" (https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/ambient).
- **So the clacks are silent when the iPhone is in silent mode.** For UI sound effects that is the correct, polite behavior.
- To override, Safari 16.4+ supports the Audio Session API ("Added support for a subset of the AudioSession Web API", 16.4 notes line 191). `navigator.audioSession.type = 'playback'` maps to `MediaPlayback` (WebKit `Modules/audiosession/DOMAudioSession.cpp:51-52`), i.e. `AVAudioSessionCategoryPlayback`, which "continues with the Silent switch set to silent".
  - Also: `'transient'` and `'ambient'` → Ambient; `'transient-solo'` → SoloAmbient. Spec: W3C Audio Session explainer (`w3c/audio-session` `explainer.md`).
  - **Don't** force `'playback'` for clacks. If you offer it, make it an explicit user setting. Feature-detect with `'audioSession' in navigator`.
- **Other tips**
  - Keep one AudioContext for the app's lifetime.
  - Create nodes per hit (they are cheap and one-shot) but reuse the noise buffer.
  - Add a master `GainNode` for the volume and mute toggle.
  - Mute automatically when `document.hidden`.

---

## 7. Design tokens example (for the React app; RECIPE)

```json
{
  "radius": { "window": 26, "sidebar": 18, "card": 20, "control": "capsule", "chip": "capsule", "sheet": 28, "flapCell": 4 },
  "space":  { "unit": 4, "s1": 4, "s2": 8, "s3": 12, "s4": 16, "s5": 20, "s6": 24, "s8": 32 },
  "size":   { "hitMin": 44, "hitMinPointer": 28, "toolbar": 52, "sidebarWidth": 240, "rowTouch": 44, "rowPointer": 28, "tabBar": 62 },
  "font":   { "body": [17, 22, -0.026], "callout": [16, 21, -0.020], "subhead": [15, 20, -0.016],
              "footnote": [13, 18, -0.006], "caption1": [12, 16, 0], "caption2": [11, 13, 0.006],
              "title3": [20, 25, -0.023], "title2": [22, 28, -0.012], "title1": [28, 34, 0.014], "largeTitle": [34, 41, 0.012],
              "_format": "[sizePx, lineHeightPx, letterSpacingEm]" },
  "glass":  { "blurPx": 24, "saturatePct": 180, "fillLight": "rgba(255,255,255,0.56)", "fillDark": "rgba(40,40,44,0.52)",
              "clearDim": "rgba(0,0,0,0.35)" },
  "motion": { "smooth": ["--spring-smooth", 740], "snappy": ["--spring-snappy", 700], "bouncy": ["--spring-bouncy", 820] },
  "flap":   { "stepMs": 60, "finalFlipMs": 300, "finalFlipMsDense": 160, "colStaggerMs": 20, "rowStaggerMs": 40 }
}
```

---

## Sources

**Apple (fetched 2026-10-10 via the `developer.apple.com/tutorials/data/...json` DocC endpoints; local text in `scratchpad/dl/design/`)**
- HIG Materials: https://developer.apple.com/design/human-interface-guidelines/materials (`hig-materials.txt`)
- HIG Color, including swatch alt-text RGB values: https://developer.apple.com/design/human-interface-guidelines/color (`dl/hig-color.json`, `hig-color.txt`)
- HIG Dark Mode: https://developer.apple.com/design/human-interface-guidelines/dark-mode
- HIG Typography: https://developer.apple.com/design/human-interface-guidelines/typography (`hig-typography.txt`)
- HIG Toolbars, Sidebars, Layout, Tab bars, Scroll views, Split views, Buttons, Toggles, Segmented controls, Sheets, Accessibility, Motion, Activity rings, Gauges, SF Symbols, App icons: https://developer.apple.com/design/human-interface-guidelines/{toolbars,sidebars,layout,tab-bars,scroll-views,split-views,buttons,toggles,segmented-controls,sheets,accessibility,motion,activity-rings,gauges,sf-symbols,app-icons}
- WWDC25 transcripts:
  - 219 "Meet Liquid Glass": https://developer.apple.com/videos/play/wwdc2025/219/
  - 356 "Get to know the new design system": https://developer.apple.com/videos/play/wwdc2025/356/
  - 323 "Build a SwiftUI app with the new design": https://developer.apple.com/videos/play/wwdc2025/323/
  - 310 "Build an AppKit app with the new design": https://developer.apple.com/videos/play/wwdc2025/310/
- SwiftUI docs:
  - Glass and variants: https://developer.apple.com/documentation/swiftui/glass, `/glass/regular`, `/glass/clear`
  - Glass modifiers: `/view/glasseffect(_:in:)`, `/glasseffectcontainer`, `/applying-liquid-glass-to-custom-views`, `/scrolledgeeffectstyle`
  - Springs and animation: `/spring`, `/spring/init(duration:bounce:)`, `/animation/spring(duration:bounce:blendduration:)`, `/animation/snappy(duration:extrabounce:)`, `/animation/bouncy(duration:extrabounce:)`, `/animation/smooth(duration:extrabounce:)`, `/animation/default`
- AVAudioSession categories: https://developer.apple.com/documentation/avfaudio/avaudiosession/category-swift.struct/ambient, `/playback`, `/soloambient`
- Apple Fonts page with the SF license text: https://developer.apple.com/fonts/ (`dl/fonts.html`)
- SF Symbols page: https://developer.apple.com/sf-symbols/
- Safari release notes 16.4, 17.4, 18, 26.x, 27 (`scratchpad/dl/apple/safari-release-notes_*.txt`, downloaded in this session by a sibling task)

**WebKit source** (raw.githubusercontent.com/WebKit/WebKit/main, fetched 2026-10-10)
- `Source/WebCore/rendering/RenderLayerBacking.cpp:921` (backdrop-filter reference filter → not composited)
- `Source/WebCore/platform/graphics/ca/GraphicsLayerCA.cpp:113, 955-972` (backdrop area cap; no software fallback; filters flatten 3D)
- `Source/WebCore/css/CSSProperties.json:14378-14419` (`-apple-visual-effect`, gated by `useSystemAppearance`)
- `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml:6647-6651` (`UseSystemAppearance: status embedder, default false`)
- `Source/WebCore/css/CSSValueKeywords.in:41-57`; `Source/WebCore/platform/graphics/cocoa/SystemFontDatabaseCoreText.cpp:246-307,424-454` (system fonts / text styles)
- `Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm:178-194`; `Source/WebCore/Modules/audiosession/DOMAudioSession.cpp:46-66`; `Source/WebCore/platform/audio/ios/AudioSessionIOS.mm:209-236`; `Source/WebCore/Modules/webaudio/AudioContextState.idl`

**Specs and compat data**
- Web Audio API spec source: https://raw.githubusercontent.com/WebAudio/web-audio-api/main/index.bs (lines 725-730, 1510-1514, 4419-4471, 4563, 6535)
- W3C Audio Session explainer: https://raw.githubusercontent.com/w3c/audio-session/main/explainer.md
- MDN content:
  - backdrop-filter (backdrop root): https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/css/reference/properties/backdrop-filter/index.md
  - Web Audio best practices: `…/web/api/web_audio_api/best_practices/index.md`
  - Autoplay guide: `…/web/media/guides/autoplay/index.md`
- MDN browser-compat-data (main): `css/properties/{backdrop-filter,mask-composite,-webkit-mask-composite,font-family,font-variant-numeric,backface-visibility,corner-shape,contain,will-change,clip-path,mask-image}.json`, `css/types/{easing-function,color}.json`, `css/at-rules/{media,property}.json`
- caniuse data.json (`scratchpad/dl/caniuse/data.json`): `css-backdrop-filter`, `extended-system-fonts`, `font-family-system-ui`, `css-masks`, `font-variant-numeric`, `transforms3d`, `audio-api`

**Third-party primary artifacts**
- Flutter `CupertinoColors` (UIKit semantic color values): https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter/lib/src/cupertino/colors.dart (lines 134-639)
- homarr-labs/dashboard-icons:
  - README: https://raw.githubusercontent.com/homarr-labs/dashboard-icons/main/README.md
  - LICENSE (Apache-2.0): `…/main/LICENSE`
  - Icon index: `metadata.json`, `tree.json`
  - Spot checks: `…/main/{svg,png,webp}/<slug>.<ext>`
- jsDelivr README: https://raw.githubusercontent.com/jsdelivr/jsdelivr/master/README.md
- scottbez1/splitflap (Apache-2.0): `README.md`, `firmware/src/config.h`, `firmware/src/splitflap_module.h`, `firmware/src/acceleration.h`, `firmware/src/generate_acceleration.py`
- npm (registry.npmjs.org, 2026-10-10):
  - `react-split-flap-effect@1.0.0` (MIT; README and dist CSS)
  - `react-split-flap@0.2.1` (MIT; README and dist CSS)
  - `liquid-glass-js@0.1.0` (README: browser support of `backdrop-filter: url()`)
  - Icon and font packages: `lucide-react@1.54.0` (ISC), `@phosphor-icons/react@2.1.10` (MIT), `@tabler/icons-react@3.49.0` (MIT), `framework7-icons@5.0.5` (MIT), `iconoir-react@7.12.1` (MIT), `@heroicons/react@2.2.0` (MIT), `@fontsource-variable/inter@5.3.0` (OFL-1.1)

**Web search summaries only (pages not fetchable from this container; treat as UNVERIFIED)**
- WebKit Bugzilla 313914 (Safari backdrop-filter url() refraction)
- MacRumors forum thread 2484925 and article "All the Liquid Glass Changes in macOS Golden Gate" (window radii)
- 9to5Mac / Norbert Heger on Tahoe resize areas (19×19 px hit zone; macOS 26.3 notes)
- Fondazione Pirelli on Gino Valle / Cifra 5 (40 flaps; 1962 Compasso d'Oro)
- Apple Developer Forums threads 837003 and 733267 (SF Symbols / SF fonts on websites; blocked by a bot check)
