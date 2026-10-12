# Web Push, PWA install and Safari CSS: reference for pve1-dash

Researched 2026-10-10. Current shipping releases: Safari 27.0 (released 2026-09-14, iOS/iPadOS/macOS 27) and Safari 27.2 beta. The project targets iOS/iPadOS 18 to 26 (and 27). Every claim below carries a citation tag such as `[S12]`; the tags are listed under **Sources** at the end. Where a claim comes only from community reports, or could not be checked, it is marked **UNVERIFIED**.

Note on sources: `webkit.org`, `caniuse.com`, `web.dev`, `w3.org` and MDN HTML pages could not be reached from this container. To compensate, this document relies on:
- WebKit **source code** (raw GitHub, `WebKit/WebKit@main`, fetched 2026-10-10)
- Apple Developer documentation as DocC JSON (release notes, the web push guide, HIG)
- WWDC session transcripts from developer.apple.com
- MDN `browser-compat-data` (BCD) and `mdn/content` raw files
- caniuse raw data (`Fyrd/caniuse`, updated 2026-10-06)
- the WHATWG HTML source and the W3C Push API source
- the `web-push` npm tarball itself

WebKit `main` is slightly ahead of shipping Safari. Where shipped behavior differed in older releases, that is stated.

---

## 0. TL;DR decisions for pve1-dash

1. **iOS/iPadOS push works only inside a Home Screen web app** (iOS 16.4+). It never works in a Safari tab. On macOS, Safari 16.1+ on macOS 13+ supports push directly in the browser tab. [S1][S2][S30]
2. **Ship a manifest** with `display: "standalone"`, `name`, `short_name`, `id`, `start_url`, `scope` and icons. Also add `apple-touch-icon` (180×180, opaque) and the `apple-mobile-web-app-*` meta tags. In iOS 26 a manifest is technically optional to become a web app, but keep it. [S5][S20][S31]
3. **Subscribe only from a click handler**, with `{ userVisibleOnly: true, applicationServerKey }`. Fetch the VAPID public key *before* the click, because WebKit's transient-activation window is **5 s**. [S10][S11][S12]
4. **Every push must produce `showNotification()` within 30 s.** After **3** misses, WebKit deletes the origin's subscriptions. The count is cumulative and never reset. [S13][S14][S15]
5. **Send payloads in Declarative Web Push format**: `{"web_push":8030,"notification":{"title","navigate",...}}`.
   - Safari 18.4+ (iOS/iPadOS Home Screen apps) and Safari 18.5+ (macOS) display them **without running the service worker**.
   - Every other browser delivers them to your classic `push` handler, which you write to read the same JSON. One format works everywhere. [S4][S16][S17][S18]
6. **VAPID `sub` must be a real `mailto:` address or a public `https:` URL.** Never use `localhost`: Apple answers `403 BadJwtToken` (documented by web-push and by several reports). Reserved TLDs such as `.local` and `.invalid` are reported to fail the same way, and a LAN name like `*.lan` probably does too (UNVERIFIED). [S3][S21][S25]
7. **`web-push@3.6.7` is CommonJS.** In ESM/TS, use the **default import** (`import webpush from 'web-push'`); named imports like `{ sendNotification }` are undefined. On 404/410, delete the subscription. Do not rely only on 410 from Apple. [S21][S22][S27]
8. **`backdrop-filter`**: Safari 18+ supports it unprefixed. Safari **ignores the entire backdrop-filter if it contains any `url()` SVG reference**, so the effect disappears completely. `prefers-reduced-transparency` is **not supported in Safari**, so provide an in-app "reduce transparency" toggle. [S6][S7][S40]
9. **SSE**: serve through HTTP/2 at the reverse proxy and send a `:` comment heartbeat every ~15 s. On `visibilitychange` → visible, recreate the `EventSource`. Also recreate it manually when `readyState === CLOSED`, because a non-200 response such as a proxy 502 permanently closes it. [S33][S34][S35]

---

## 1. Platform matrix: Web Push

| Platform | Where push works | Since | Notes |
|---|---|---|---|
| iOS / iPadOS Safari | **Home Screen web app only** | 16.4 | caniuse: "Requires website to first be added to the Home Screen", still true for iOS 27.x [S30]. Apple doc: "Add web push to Home Screen web apps in iOS 16.4 or later" [S3]. |
| iOS 26+ | Any site added to the Home Screen opens as a web app by default; a manifest is no longer required to become a web app | 26.0 | Release note: "Added support for any website to become a web app on iOS or iPadOS." [S5]. WebKit blog (via search snippet): "Giving users a web app experience simply no longer *requires* a manifest file" [S31]. Whether push works for a **manifest-less** web app is **UNVERIFIED**, so keep the manifest. |
| iOS third-party browsers (Chrome/Edge/Firefox on iOS) | Can offer Add to Home Screen; the resulting app is a WebKit web app | 16.4 | "Added support for third-party browsers to offer Add to Home Screen from the Share menu." [S2] |
| macOS Safari | **In the browser tab**, no install needed. Also in "Add to Dock" web apps (macOS 14+). | Safari 16.1 on macOS 13 Ventura | "Added Web Push Notifications support on macOS Ventura." [S30a]. caniuse: Safari 16.1 partial, "Only available on macOS 13 Ventura or later" [S30]. Web apps on macOS Sonoma: Safari 17 [S30b]. |
| Declarative Web Push | iOS/iPadOS Home Screen apps 18.4+, macOS Safari 18.5+ | 18.4 / 18.5 | [S16][S17] |
| Chrome (desktop + Android) | In browser, no install needed | 42 (data: 50) | `userVisibleOnly: true` is required [S36]. Endpoint `https://fcm.googleapis.com/fcm/send/...` [S21] |
| Firefox (desktop + Android) | In browser | 44 | `subscribe()` requires a user gesture since Firefox 72 [S36] |
| Lockdown Mode (Apple) | Push API disabled | n/a | WebKit pref `PushAPIEnabled: disableInLockdownMode: true` [S19 L4985-4995] |

Legacy *Safari Push Notifications* (APNs website push packages) is a different, Apple-only system. caniuse notes "Safari 7.0 - 26.3 supported Safari Push Notifications" [S30]. Do not use it.

---

## 2. iOS/iPadOS Home Screen web app push requirements

### 2.1 Manifest (Safari support per BCD [S20])

| Member | Safari iOS | Safari macOS | Notes |
|---|---|---|---|
| `name`, `short_name` | 11.3 | 17 | |
| `display` | 11.3 | 17 | Supported values: `standalone`, `browser`. `fullscreen` and `minimal-ui` are listed as **not supported** in BCD. The 16.4 WebKit announcement said "display ... standalone or fullscreen" makes a Home Screen web app [S29]. **Use `standalone`.** |
| `display_override` | **not supported** | not supported | Chrome 89+. Harmless to include, but has no effect on Apple platforms. |
| `id` | 16.4 | 17 | "Added support for the "id" member in Web App Manifest files." [S2] |
| `start_url`, `scope` | 11.3 | 17 | Safari 17.2 fixed "`scope` member ... not respected" [S2b] |
| `icons` | 15.4 | 17 | BCD: "Only used when no `apple-touch-icon` is present and either purpose is any or not specified." Safari 17.2 (macOS web apps): supply "at least one opaque, full-bleed `maskable` square icon ... SVG (any size) or high resolution bitmap (1024x1024)" [S2b]. |
| `theme_color` | 15 | 17 | See §5.4 |
| `background_color` | **not supported** | not supported | iOS does not build a splash screen from it (§5.3) |
| `shortcuts` | not supported | 17.4 | |
| `orientation`, `description` | not supported | not supported | |

Chrome installability needs `name`/`short_name`, `icons`, `start_url`, and `display` or `display_override` (BCD notes) [S20].

**Example `manifest.webmanifest`** (serve as `application/manifest+json`):

```json
{
  "id": "/",
  "name": "pve1 Dashboard",
  "short_name": "pve1",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "theme_color": "#0b0d12",
  "background_color": "#0b0d12",
  "icons": [
    { "src": "/icons/icon-192.png",  "sizes": "192x192",   "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png",  "sizes": "512x512",   "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-1024-maskable.png", "sizes": "1024x1024", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

Safari 26 added "support for SVG icons" and "`data:` URL icons" in the Browser section of the release notes [S5]. WWDC25 adds: "Using SVG as a favicon ... allows Safari to generate icons best suited for the context" [S38].

### 2.2 Permission and subscribe rules (verified in WebKit source)

From `PushManager.cpp` [S10]:
- `userVisibleOnly` must be `true`. Otherwise the call rejects with `NotAllowedError` "Subscribing for push requires userVisibleOnly to be true" (L81-84).
- `applicationServerKey` is **required**. Without it the call rejects with `NotSupportedError` (L86-89). A base64url `DOMString` or a `BufferSource` is accepted; base64url decode errors give `InvalidCharacterError`, and a key that is not P-256 gives `InvalidAccessError` (L92-115).
- A service worker must be active, otherwise `InvalidStateError` "Subscribing for push requires an active service worker" (L116-121). With `window.pushManager` (Declarative, 18.4+) no service worker is needed.
- Permission `denied` → `NotAllowedError`. Permission `default` from a non-document context (such as a service worker) → `NotAllowedError`.
- Permission `default` from a document requires the document to be same-origin with the top document, plus **transient activation**, which the call consumes. Otherwise it rejects with "Push notification prompting can only be done from a user gesture." (L127-158).
- **Permission already `granted` → subscribe works without a gesture** (L180-181). Use this to silently re-subscribe on app start if Apple dropped the subscription.

From `Notification.cpp` [S11]: `Notification.requestPermission()` without transient activation **resolves `"denied"` without prompting**. This happens even when permission is already granted, because the activation check runs first (L445-448). Read `Notification.permission` to learn the state, and call `requestPermission()` only inside a click handler.

Transient activation lasts `defaultTransientActivationDuration { 5_s }` (`LocalDOMWindow.cpp` L201) [S12]. Do not `await fetch('/api/push/vapid-key')` inside the click handler before calling `subscribe()`; prefetch the key instead.

Apple's own wording: "When the user completes the gesture, call the push subscription method immediately from the gesture's event handler code." [S3]

**Example `PushSubscription.toJSON()`**, which is the shape POSTed to the backend and passed to `web-push`:

```json
{
  "endpoint": "https://web.push.apple.com/QGv7Xz...opaque-token...",
  "expirationTime": null,
  "keys": {
    "p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    "auth": "tBHItJI5svbpez7KI4CCXg"
  }
}
```

About the endpoint host: Apple says to allow `https://*.push.apple.com` [S3]. Endpoints observed in the wild are on `web.push.apple.com` (Apple forum report [S27]; WWDC22: "allow URLs from any subdomain of push.apple.com" [S37]). `keys.p256dh` is a 65-byte uncompressed P-256 point and `auth` is 16 bytes, both base64url (standard Push API).

**Client subscribe snippet:**

```ts
// Prefetched at app start, NOT inside the click handler:
const vapidKey: string = await fetch('/api/push/vapid-public-key').then(r => r.text());

button.addEventListener('click', async () => {
  const reg = await navigator.serviceWorker.ready;                  // active SW required
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey });
  await fetch('/api/push/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
});

// On every app start / visibilitychange→visible: self-heal (no gesture needed when already granted)
if (Notification.permission === 'granted') {
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey });
  /* POST sub (idempotent upsert by endpoint) */
}
```

Feature detection: check `'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window`. On iOS outside a Home Screen app, push is unavailable; caniuse marks notifications "Requires website to first be added to the Home Screen" [S30]. Exactly which globals are undefined in an iOS Safari tab is **UNVERIFIED**, so feature-detect and also check standalone mode (§5.6).

### 2.3 Service worker MUST show a notification for every push (silent push penalty)

- Apple: "Safari doesn't support invisible push notifications. Present push notifications to the user immediately after your service worker receives them. If you don't, Safari revokes the push notification permission for your site." [S3]
- **Timeout is 30 s**: `silentPushTimeoutForProduction { 30_s }` (`NotificationData.h` L42) [S13].
- **Limit is 3**: `maxSilentPushCount = 3`, documented as "If an origin processes more than this many silent pushes, then it will be unsubscribed from push." (`WebPushDaemonConstants.h` L34-35) [S14]. In `PushService.mm` L658-667, once the count reaches 3 (`count < 3` is the only safe branch), it calls "Removing all subscriptions associated with ..." [S14].
- The counter is only ever incremented. `PushDatabase.cpp` has only `SET silentPushCount = silentPushCount + 1` and no reset path [S14]. So one origin gets 3 strikes for its lifetime.
- Strikes are **not** counted while the service worker is being inspected in Web Inspector (`WebPushDaemon.mm` L711-713) [S14].
- In WebKit a push event "succeeds" only if no `waitUntil` promise rejected **and** `showNotification` was called. Otherwise it logs "Push event handling completed without showing any notification ... This may trigger removal of the push subscription." (`ServiceWorkerThread.cpp` L319-336) [S15].
- WWDC22 says the same: "after three push events where you fail to post a notification in a timely manner, your site's push subscription will be revoked" [S37].
- Community reports say that after revocation `Notification.permission` can stay `"granted"` while `getSubscription()` returns `null` (**UNVERIFIED** beyond those reports [S28]). The self-heal snippet in §2.2 handles this case.

Rules for the handler:
- Always `event.waitUntil(registration.showNotification(...))`.
- Never return early, for example "app is focused, so skip the notification" or "deduplicated".
- Catch JSON parse errors and still show a generic notification.

### 2.4 Notification options WebKit actually supports

WebKit `NotificationOptions.idl` [S17]:
- **Supported:** `dir`, `lang`, `body`, `tag`, `icon`, `silent`, `data`, and `navigate`. `navigate` is a Declarative Web Push addition, Safari 18.4.
- **Commented out, not implemented:** `image`, `badge`, `vibrate`, `timestamp`, `renotify`, `requireInteraction`, `actions`.

So **there are no action buttons** on Apple platforms. BCD agrees (`showNotification` options `actions`, `badge`, `image`, `renotify`, `requireInteraction` and `vibrate` all show Safari false). BCD also notes that `Notification.tag` and `Notification.icon` on Safari "can be set, but has no effect" [S36]. Do not rely on `tag` replacement on iOS; deduplicate on the server.

> Note: BCD marks `showNotification` `data` as unsupported in Safari, but WebKit's `Notification.idl` exposes `readonly attribute any data` and `NotificationOptions` has `any data = null` [S17]. **Trust the source: `data` works.**

### 2.5 Badging API

- Use `navigator.setAppBadge(n)` and `navigator.clearAppBadge()`. Safari iOS 16.4+ for Home Screen apps; macOS Safari 17+ for installed web apps (Sonoma) [S36]. Chrome 81+ on desktop; Firefox has no support [S36].
- Passing `0` **clears** the badge rather than showing a dot (BCD note) [S36].
- WebKit exposes it in workers too: `WorkerNavigator includes NavigatorBadge` (`WorkerNavigator.idl` L37); `NavigatorBadge.idl` L28-30 defines `setAppBadge(optional [EnforceRange] unsigned long long contents)` and `clearAppBadge()` [S18]. So you **can call it from the service worker push handler**.
- Apple: "Users can configure badging permissions for your Home Screen web app in Notifications settings in iOS 16.4 or later." [S3] That badges require the notification permission to be granted is implied but **UNVERIFIED**.
- With Declarative Web Push, use the top-level `"app_badge"` member (§2.6).

### 2.6 Declarative Web Push (Safari 18.4 iOS/iPadOS, Safari 18.5 macOS)

**What it is.** A push payload in a standardized JSON format that the browser displays **itself, without waking the service worker**. A tap navigates to `navigate`, and `notificationclick` is skipped. The format is now in the W3C Push API editor's draft as the "declarative push message" [S16]. Apple presented it at WWDC25 [S4]: "Give it a shot in Safari 18.5 and later on macOS, or web apps saved to the home screen on iOS 18.4 and iPadOS 18.4 and later." Release notes: Safari 18.4 "Added support for Declarative Web Push."; Safari 18.5 "Added support for Declarative Web Push on macOS." [S2c].

**Detection by the browser.** There is no special HTTP header or Content-Type. The browser JSON-parses every decrypted payload and checks `web_push === 8030`:
- JSON parse fails, or there is no magic key → the payload goes to the classic service worker `push` event (WWDC25 [S4]; WebKit `hasDeclarativeMessageJSONValues` [S16a L74-85]).
- Has the magic key but is invalid → per WWDC25 "the browser simply does nothing, dropping the message on the floor" [S4]. The W3C ED algorithm instead falls through to the legacy path [S16]. **Validate server-side.**
- The old explainer's `Content-Type: application/notification+json` / `default_action_url` design is **obsolete** and was not shipped. The implementation uses the `web_push: 8030` key [S16a][S16b].

**Format** (from W3C Push API ED [S16] plus WebKit parser `NotificationJSONParser.cpp` [S16a]):

| Key | Level | Type | Req. | WebKit behavior |
|---|---|---|---|---|
| `web_push` | top | integer, must equal `8030` | yes | L37-38, L74-85 |
| `notification` | top | object | yes | error if missing or not an object (L105-110) |
| `notification.title` | notif | non-empty string | yes | L126-134 |
| `notification.navigate` | notif | URL string | yes | Parsed with `URL{string}` and **no base**, so **use an absolute URL** (L115-124). The spec resolves against the subscription scope, but WebKit main does not. |
| `notification.body` | notif | string | no | |
| `notification.lang` | notif | string (BCP 47) | no | |
| `notification.dir` | notif | `"auto"`/`"ltr"`/`"rtl"` | no | Invalid value → error (L176-184) |
| `notification.tag` | notif | string | no | |
| `notification.icon` | notif | absolute URL string | no | Invalid URL → error (L207-215) |
| `notification.silent` | notif | boolean | no | `false` = play the default sound if possible (WWDC25) |
| `notification.data` | notif | any JSON | no | Stored as JSON, exposed as `Notification.data` |
| `notification.image`, `badge`, `vibrate`, `timestamp`, `renotify`, `requireInteraction`, `actions[]` (each `{action,title,navigate,icon?}`) | notif | per spec | no | In the spec [S16], but **not parsed by WebKit** (only the keys at L40-50 exist) |
| `mutable` | **top** | boolean | no (default `false`) | Top level is standard. WebKit still accepts it inside `notification` as a non-standard fallback (L142-152). Safari 26.2 "Fixed reading the `mutable` field from the outer object instead of as a child of `notification`" [S2d]. |
| `app_badge` | **top** | unsigned integer, or a string of digits | no | WebKit-only (L154-168). `0` clears. Not present in the W3C Push API ED text fetched [S16]. |

**Example payload** for pve1-dash, about 330 bytes and well under the 3993-byte plaintext limit:

```json
{
  "web_push": 8030,
  "notification": {
    "title": "pve1: VM 104 (nas) stopped",
    "body": "Status changed running → stopped at 14:02:11",
    "navigate": "https://pve1-dash.home.example.net/guests/qemu/104",
    "tag": "guest-104",
    "lang": "en-US",
    "dir": "ltr",
    "silent": false,
    "data": { "kind": "guest-state", "node": "pve1", "vmid": 104, "ts": 1791640931 }
  },
  "app_badge": 3
}
```

**Mutable flow.** With `"mutable": true` and a service worker registered, WebKit fires a normal `push` event. The event carries `event.notification` (a `Notification` built from the JSON) and `event.appBadge`, and **`event.data` is `null`**: `PushEvent::create(eventNames().pushEvent, { }, notification.get(), proposedPayload.appBadge, ...)` (`ServiceWorkerThread.cpp` L349-350) [S15]. The `PushEvent.idl` additions are `readonly attribute Notification? notification;` and `readonly attribute unsigned long long? appBadge;` [S17]. If the service worker calls `showNotification` in time, that notification replaces the proposed one. If it does not, the proposed one is shown. For a dashboard, **leave `mutable` false**.

**Should pve1-dash use it?** Yes. Use it as **the only payload format**:
- iOS 18.4+ users get service-worker-free, ITP-proof delivery with **no silent-push-strike risk**, because the browser always displays the notification.
- Taps navigate directly to `navigate`. This sidesteps the iOS `notificationclick` reliability issue (§2.8).
- All other browsers, and iOS < 18.4, receive it in the classic handler below.

**Classic service worker handler that is compatible with declarative payloads:**

```js
// sw.js
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'pve1 Dashboard';
    let options = { body: 'New event', data: { url: '/' } };
    let badge;
    try {
      if (event.notification) {                       // WebKit mutable declarative push (data is null here)
        const n = event.notification;
        title = n.title;
        options = { body: n.body, lang: n.lang, dir: n.dir, tag: n.tag, silent: n.silent ?? undefined,
                    data: { ...(n.data ?? {}), url: n.navigate } };
        badge = event.appBadge ?? undefined;
      } else if (event.data) {
        const msg = event.data.json();                // throws on non-JSON → caught below
        if (msg?.web_push === 8030 && msg.notification?.title) {
          const { title: t, navigate, data, ...rest } = msg.notification;
          title = t;
          options = { ...rest, data: { ...(data ?? {}), url: navigate } };
          badge = msg.app_badge;
        }
      }
    } catch { /* fall through to generic notification — never skip showNotification */ }
    if (badge !== undefined && 'setAppBadge' in self.navigator) {
      try { await (Number(badge) === 0 ? self.navigator.clearAppBadge() : self.navigator.setAppBadge(Number(badge))); } catch {}
    }
    await self.registration.showNotification(title, options);
  })());
});
```

This handler deliberately does **not** pass `navigate` to `showNotification`. Whether WebKit then still fires `notificationclick`, which could cause a double navigation, is **UNVERIFIED**. Keeping the URL in `data.url` and routing in `notificationclick` (§6.3) is unambiguous.

### 2.7 macOS Safari, Chrome, Firefox

- **macOS Safari 16.1+ on macOS 13+**: push works in normal tabs without install [S30a][S30]. Safari 17: "Added support for Web Push subscriptions per profile." [S30b]
- **Chrome**: works in-browser on desktop and Android. It requires `userVisibleOnly: true` and an `applicationServerKey` (MDN/BCD) [S36]. Chrome also has silent-push enforcement; its details are not researched here.
- **Firefox**: works in-browser. `subscribe()` needs a user gesture since Firefox 72 [S36]. The endpoint host is commonly `updates.push.services.mozilla.com` (**UNVERIFIED** in this session). Firefox ignores `userVisibleOnly` (BCD: `PushSubscriptionOptions.userVisibleOnly` Firefox false) [S36].

### 2.8 `notificationclick` on iOS: caveat

- BCD lists `ServiceWorkerGlobalScope.notificationclick_event` as **`safari_ios: false`**, while desktop Safari has it from 16 [S36].
- WebKit's pref `NotificationEventEnabled` defaults to true only for `ENABLE(NOTIFICATION_EVENT) && !PLATFORM(IOS_FAMILY)` (`UnifiedWebPreferences.yaml` L4483-4495) [S19]. The embedder may override it at runtime, so this is not conclusive.
- Apple forum threads report `clients.openWindow(url)` not routing to the URL on iOS. The app reopens its last page, or `start_url` when cold-started [S28b].
- **Treat deep-linking from a tap on iOS < 18.4 as unreliable (UNVERIFIED either way).** On 18.4+, declarative `navigate` is the reliable path.
- For the dashboard, make the landing view show recent alerts, so a tap that just opens the app is still useful.

`pushsubscriptionchange`: Safari macOS 16+, **iOS false**, Chrome 138, Firefox 44 (partial) [S36]. Do not rely on it; use the self-heal approach in §2.2.

---

## 3. VAPID and Apple Push Service quirks

### 3.1 Request (RFC 8030 / 8291 / 8292) as Apple documents it [S3]

- `POST <endpoint>` over HTTP/1.1 or HTTP/2. "APNs supports both HTTP/1.1 and HTTP/2.0. The default protocol is HTTP/1.1." TLS with SNI is required. HTTP/1.1 pipelining: "Don't send more than 100 unacknowledged push requests over the connection."
- Firewall egress from the pve1-dash LXC: "allow access for `https://*.push.apple.com`" [S3]. Also allow `fcm.googleapis.com` for Chrome [S21] and Mozilla's push host for Firefox (UNVERIFIED host).

The request headers Apple lists:

| Header | Meaning / Apple rule |
|---|---|
| `TTL` | Seconds to keep the message if undeliverable. Apple stores it "for 30 days or fewer, depending on the value you specify". `BadTtl`: "The TTL header is either missing or isn't a positive number". **TTL `0` may therefore be rejected by Apple (UNVERIFIED in practice); use ≥ 1.** web-push's default is 2,419,200 s (28 days). |
| `Authorization` | `vapid t=<JWT>, k=<p256 public key b64url>`. "The public key you include must match the public key you provided to `PushManager.subscribe`." (`VapidPkHashMismatch` otherwise). "**Don't refresh your JWT more frequently than once per hour.**" |
| `Content-Encoding` | `aes128gcm` (RFC 8291). May be omitted for an empty payload. |
| `Topic` | Optional coalescing key: "maximum of 32 characters from the URL or filename-safe Base64 characters". |
| `Urgency` | `very-low` \| `low` \| `normal` \| `high`. "To attempt to deliver the notification immediately, specify `high`." |

### 3.2 VAPID JWT claims

- Header `{"typ":"JWT","alg":"ES256"}`. Claims are `aud` (the origin of the push service, e.g. `https://web.push.apple.com`), `exp` (unix seconds, **≤ 24 h ahead**) and `sub`. This was verified by generating a request with web-push 3.6.7: `{"aud":"https://web.push.apple.com","exp":<now+12h>,"sub":"mailto:admin@example.com"}` [S22].
- VAPID spec: "The "sub" claim SHOULD include a contact URI for the application server as either a "mailto:" (email) or an "https:" URI." `exp` "MUST NOT be more than 24 hours from the time of the request." [S24]
- Apple's `BadJwtToken` causes [S3]: JWT missing; signed with the wrong key; "The JWT subject claim isn't a URL or `mailto:`"; `aud` isn't the push service origin; `exp` more than one day in the future.

**Subject values Apple rejects (403 `BadJwtToken`):**
- `https://localhost`: web-push's own README says "Safari's push notification endpoint rejects the request with a BadJwtToken error", and the library prints a warning (`vapid-helper.js` L87-89) [S21][S22].
- `mailto:...@localhost`: the web-push master README says "Apple Push may reject localhost-based subjects with 403 BadJwtToken" [S21b]. Several independent reports show `mailto:x@localhost` → 403 while a real address → 201 [S25].
- Reserved or non-resolvable TLDs such as `.invalid`, `.local` and `.test` are reported rejected (community, **UNVERIFIED** by Apple) [S25].

Note that web-push only *warns* for `https://localhost`. It does **not** catch `mailto:user@localhost`, because `new URL('mailto:user@localhost').hostname === ''` (tested on Node 22.22.0).

For pve1-dash (LAN only), use the owner's real email address, e.g. `mailto:you@yourdomain.tld`, or a public `https://` URL. **Never use the LAN hostname.**

### 3.3 Payload size

- Apple: `413` / `PayloadTooLarge`: "The payload size is over the limit of 4 KB." [S3]
- RFC 8291: "A push service is not required to support more than 4096 octets of payload body ... this equates to at most **3993 octets of plaintext**" [S23].
- Verified with web-push 3.6.7: 3993-byte plaintext → 4096-byte body; 3994 → 4097, and **web-push does not check the size** [S22].
- Budget for ≤ ~3.5 KB of JSON.

### 3.4 Responses and errors (Apple) [S3]

Success is `201`. Every response carries the `apns-id` header ("uniquely identifies your push request"). Errors carry a JSON body with a `reason` key.

| Status | Meaning |
|---|---|
| 201 | Success |
| 400 | Bad request (`BadTtl`, `BadUrgency`, `BadWebPushRequest` (encryption), `BadWebPushTopic`, `BadAuthorizationHeader`, `BadVapidPublicKey`) |
| 403 | Auth error (`BadJwtToken`, `VapidPkHashMismatch`) |
| 404 | Invalid `:path` (`BadPath`) |
| 405 | Not POST (`MethodNotAllowed`) |
| **410** | "The device token has expired." → **delete the subscription** |
| 413 | `PayloadTooLarge` |
| 429 | `TooManyRequests` ("too many consecutive requests to the same device token") |
| 500 / 503 | `InternalServerError` / `ServiceUnavailable`, `Shutdown` → retry with backoff |

Also listed: `IdleTimeout` (connection timed out).

**Example error** (status 403, header `apns-id: 8F2A...`):
```json
{ "reason": "BadJwtToken" }
```
(The exact success body, likely empty, and the exact header casing are **UNVERIFIED**. A mock server should return `201` with an `apns-id` header and accept either.)

**Subscription lifecycle gotchas:**
- Apple forum reports (2022, 2024) say `web.push.apple.com` returned **201 (not 410)** for subscriptions the user had denied in Settings or that had been replaced [S27]. Do not rely on 410 alone.
- Mitigations:
  - Re-POST the current subscription from the client on every app start (upsert by `endpoint`).
  - Store `lastSeenAt` per subscription and prune subscriptions not refreshed for N days.
  - Delete on `404` and `410`.
- Rotating VAPID keys invalidates every existing subscription (`VapidPkHashMismatch`), so keep the keys stable.

---

## 4. The `web-push` npm library

Facts from `npm view` and the published tarball [S22]:
- **Latest is 3.6.7**, published 2024-01-16. No newer release exists as of 2026-10-10.
- **CommonJS** (`main: src/index.js`, `module.exports = {...}`), `engines: { node: ">= 16" }`.
- Dependencies: `asn1.js ^5.3.0`, `http_ece 1.2.0`, `https-proxy-agent ^7.0.0`, `jws ^4.0.0`, `minimist ^1.2.5`.
- The GitHub `master` branch is already converted to **ESM** (`"type": "module"`, named exports) but is still labeled 3.6.7 and is **unreleased**. Do not copy master-branch import syntax.
- Types: `@types/web-push@3.6.4`, published 2024-10-22. It provides `RequestOptions`, `PushSubscription`, `SendResult`, `WebPushError`, `Urgency`, `ContentEncoding`.

**ESM/TS import gotcha (tested with Node 22.22.0):**
- `import webpush from 'web-push'` → all functions are present.
- `import * as ns from 'web-push'` → only `WebPushError`, `supportedContentEncodings` and `default` are present. **Named imports `sendNotification`, `setVapidDetails` and `generateVAPIDKeys` are undefined.**
- With TS `esModuleInterop: true`, use the default import.

**API** (`index.js` [S22]):
- `generateVAPIDKeys(): { publicKey, privateKey }` returns base64url strings of 65 bytes (uncompressed P-256 point) and 32 bytes. Run it once and store the keys in config or secrets. CLI: `npx web-push generate-vapid-keys`.
- `setVapidDetails(subject, publicKey, privateKey)` validates that the subject is `https:` or `mailto:` (throws "Vapid subject is not a valid URL" for a bare email) and validates the key lengths.
- `sendNotification(subscription, payload?: string|Buffer, options?) : Promise<SendResult>`. Valid option keys, anything else throws (`web-push-lib.js` L119-130): `headers, gcmAPIKey, vapidDetails, TTL, contentEncoding, urgency, topic, proxy, agent, timeout`.
  - `TTL` is seconds. The default is **2,419,200 (4 weeks)** (L13) and it must be ≥ 0.
  - `contentEncoding` defaults to **`aes128gcm`** (L111). The README text saying "'aesgcm', by default" is wrong.
  - `urgency` is one of `very-low|low|normal|high` and defaults to `normal`.
  - `topic` must be ≤ 32 base64url characters.
  - `timeout` is the socket timeout in ms (the default is none).
  - `proxy` is an HTTPS proxy URL or options object. `agent` must be an `https.Agent`.
- Each call builds a **fresh JWT**: `exp = now + 12h` by default (`vapid-helper.js` L14), with a maximum of 24 h. This technically conflicts with Apple's "Don't refresh your JWT more frequently than once per hour" [S3]. It works in practice and low volume is fine. A strict alternative is to cache the headers from `getVapidHeaders(audience, subject, pub, priv, 'aes128gcm', exp)` per audience for about 1 h, then pass `{ vapidDetails: null, headers: { Authorization } }`.
- Transport: Node `https.request`, i.e. **HTTP/1.1** (Apple accepts it).
- **Resolve shape**: `{ statusCode: number, body: string, headers: IncomingHttpHeaders }` for any 2xx status.
- **Reject shape**: `WebPushError` with fields `{ name: 'WebPushError', message: 'Received unexpected response code', statusCode, headers, body, endpoint }` for any non-2xx status (L377-384). Network or timeout failures reject with a plain `Error` (`'Socket timeout'` on timeout).
- Node 22: works. `url.parse()` (used internally) is only documentation-deprecated there. In Node 24+ it is an "Application deprecation (non-`node_modules` code only)", so a dependency calling it triggers no warning [S39].

**Backend example (Node 22 + TS):**

```ts
import webpush from 'web-push';                       // default import — named imports are undefined
import type { PushSubscription as WPSub, WebPushError } from 'web-push';

webpush.setVapidDetails(process.env.VAPID_SUBJECT!,   // e.g. "mailto:you@yourdomain.tld" — NOT localhost/.lan
                        process.env.VAPID_PUBLIC!, process.env.VAPID_PRIVATE!);

export async function pushTo(sub: WPSub, payload: object, opts: { topic?: string; urgent?: boolean } = {}) {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 3993) throw new Error('push payload too large');
  try {
    const res = await webpush.sendNotification(sub, body, {
      TTL: opts.urgent ? 3600 : 86400,              // seconds; keep ≥ 1 for Apple
      urgency: opts.urgent ? 'high' : 'normal',
      ...(opts.topic ? { topic: opts.topic } : {}), // ≤32 chars [A-Za-z0-9_-]
      timeout: 10_000,
    });
    return { ok: true as const, status: res.statusCode, apnsId: res.headers['apns-id'] };
  } catch (e) {
    const err = e as WebPushError;
    if (err.statusCode === 404 || err.statusCode === 410) return { ok: false as const, gone: true };
    if (err.statusCode === 429 || (err.statusCode ?? 0) >= 500) return { ok: false as const, retry: true };
    return { ok: false as const, status: err.statusCode, body: err.body };   // e.g. 403 {"reason":"BadJwtToken"}
  }
}
```

---

## 5. iOS PWA head tags and icons (2026)

### 5.1 Recommended `<head>`

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">            <!-- 180x180, opaque -->
<meta name="apple-mobile-web-app-capable" content="yes">                         <!-- legacy Apple standalone flag -->
<meta name="mobile-web-app-capable" content="yes">                               <!-- standard name; silences Chrome warning -->
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="pve1">
<meta name="theme-color" content="#f5f6f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0d12" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
```

### 5.2 Tag-by-tag status

| Tag | Status | Evidence |
|---|---|---|
| `apple-touch-icon` | Still the primary iOS home-screen icon. BCD: manifest `icons` are used only "when no `apple-touch-icon` is present". Provide **180×180** (iPhone @3x); Apple's archived guide lists 152/167/180. Use opaque artwork, because transparent icons get a system background. | [S20][S32][S2b] |
| `apple-mobile-web-app-capable` | Apple extension: "If content is set to `yes`, the web application runs in full-screen mode." Detect with `navigator.standalone` (WebKit `Navigator.idl` L26). Chrome flags it as deprecated in favor of `mobile-web-app-capable`. Since iOS 26 every Home Screen site opens as a web app anyway. | [S32][S18][S26b][S5] |
| `mobile-web-app-capable` | The standard name Chrome asks for. **Whether Safari reads it is UNVERIFIED**, so emit both. | [S26b] |
| `apple-mobile-web-app-status-bar-style` | Values `default`, `black`, `black-translucent`. "If set to `black-translucent`, the web content is displayed on the entire screen, partially obscured by the status bar." No effect unless in standalone mode. | [S32] |
| `apple-mobile-web-app-title` | Home-screen label; the default is `<title>`. Also set manifest `short_name` to the same string, because precedence is UNVERIFIED. | [S32] |
| `theme-color` (+ `media`) | Safari 15+, with light/dark variants via `media` (WebKit Safari 15 post, via search snippet). **BCD: "From Safari 26, the theme color is only used for installed web apps."** So it still matters for pve1-dash running as a Home Screen app. | [S20][S31b] |
| `apple-touch-startup-image` | iOS does **not** generate a splash from the manifest (`background_color` is unsupported per BCD). Without startup images users report a blank white or black launch screen. Custom splashes still need one `<link rel="apple-touch-startup-image" media="(device-width:…) and (device-height:…) and (-webkit-device-pixel-ratio:…)">` per device size (community/web.dev, **UNVERIFIED** for iOS 26). For a dashboard, set `html{background:#0b0d12}` matching the theme and skip the splash images. | [S20][S26c] |
| `viewport-fit=cover` + `env(safe-area-inset-*)` | `env()` with the four `safe-area-inset-*` variables is Safari 11.1+ (iOS 11.2 renamed `constant()` to `env()`). `viewport-fit=cover` makes the page lay out full-screen so the insets apply. WebKit bugs report iOS 26.x regressions (e.g. `safe-area-inset-top` returning 0); **test on device**. | [S36][S31c] |
| manifest `display_override` | Not supported by Safari (BCD). Optional for Chrome. | [S20] |
| maskable icons | iOS: manifest icons with `purpose:"maskable"` are not used for the home screen (BCD note). macOS Safari 17.2+: "supply at least one opaque, full-bleed `maskable` square icon ... SVG ... or 1024x1024". Ship both kinds. | [S20][S2b] |

### 5.3 Safe areas with black-translucent

```css
:root { background: var(--bg); }  /* explicit root bg: also what Safari 26 tabs sample for toolbar tint */
.app-header { padding-top: max(12px, env(safe-area-inset-top)); }
.app-footer { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
.app { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
```

### 5.4 theme-color and Safari 26 "Liquid Glass" chrome

- **In Safari tabs** (not the web app), Safari 26 no longer uses `theme-color` for toolbar tint (BCD [S20]). Instead the tint derives from the page's root/body background and from fixed or sticky elements at the top and bottom edges. That mechanism comes from community reports and WebKit bug 301756, whose filer says Safari "now automatically derives the top bar tint from the html or body background color" [S31b]. **No official Apple/WebKit doc describing the exact sampling rules was found (UNVERIFIED).**
- **In Home Screen web apps** `theme-color` is still used (BCD).
- Safari 26.2: "Fixed an issue where fullscreen dialog backdrops did not properly extend below the address bar" [S2d].

### 5.5 Splash, icon cache

iOS caches the icon and splash for a Home Screen web app. After changing them, users must delete and re-add the web app (community, **UNVERIFIED**) [S26c].

### 5.6 Standalone detection

```ts
const isStandalone =
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: fullscreen)').matches ||          // iOS quirk, see below
  (navigator as any).standalone === true;                      // iOS-only legacy property
```

BCD on iOS: "In an installed web application with the `display` manifest member set to `standalone`, `display-mode: standalone` is false and `display-mode: fullscreen` is true" (webkit.org/b/264218) [S36]. WebKit `MediaQueryFeatures.cpp` derives `display-mode` from the page's manifest and falls back to `browser` with no manifest [S40c]. A manifest-less iOS 26 web app may therefore report `browser`, so also check `navigator.standalone`.

---

## 6. Service worker for a live dashboard

### 6.1 Caching policy

| Request | Strategy |
|---|---|
| Hashed Vite assets `/assets/*-[hash].(js\|css\|woff2\|svg\|png)` | Precache at install, cache-first, immutable |
| `/` and navigations (`request.mode === 'navigate'`) | Network-first with a ~3 s timeout, falling back to the cached `index.html`. This avoids an old shell talking to a new API. |
| `/manifest.webmanifest`, icons | Stale-while-revalidate |
| **`/api/*` (REST + SSE `/api/events`)** | **Do not intercept.** Return without `respondWith()` so the browser handles it natively. Never cache. |
| `sw.js` itself | Serve with `Cache-Control: no-cache`. Register with `updateViaCache: 'none'`. |

Tooling (npm, 2026-10-10): `vite-plugin-pwa@2.0.0` (published 2026-10-03, needs Node ≥ 20.19, Vite 3 to 8 peer) or the more settled `1.3.0` (2026-05-05). `workbox-*@7.4.1`. Use `injectManifest` mode so you keep your own push and notificationclick code in `sw.js`.

### 6.2 SW skeleton

```js
// sw.js (injectManifest: self.__WB_MANIFEST is replaced at build time)
const SHELL = 'shell-v__BUILD_ID__';
const PRECACHE = (self.__WB_MANIFEST || []).map(e => e.url);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', ...PRECACHE])));
  // no skipWaiting() here → user-controlled update (toast)
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // network, untouched (SSE too)
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r ?? fetch(e.request)));
});
```

### 6.3 notificationclick

```js
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ type: 'open-url', url: target });   // app router navigates
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
```

BCD versions [S36]:
- `Clients.openWindow`, `WindowClient.focus` and `Clients.claim`: Safari 11.1+.
- `WindowClient.navigate()` threw `NotSupportedError` before Safari 16. Prefer the `postMessage` approach above.
- MDN: `openWindow` rejects with `InvalidAccessError` "if none of the windows in the app's origin have transient activation" [S36b]. Inside `notificationclick` this is allowed.

On iOS see §2.8: this handler may not run, so declarative `navigate` covers iOS 18.4+.

### 6.4 Update flow with a "new version" toast

```ts
const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
const offer = (w: ServiceWorker) => showToast('New version available', 'Reload', () => w.postMessage({ type: 'SKIP_WAITING' }));
if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
reg.addEventListener('updatefound', () => {
  const w = reg.installing!;
  w.addEventListener('statechange', () => {
    if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);   // not first install
  });
});
let reloaded = false;
navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open-url') router.navigate(new URL(e.data.url).pathname); });
```

`skipWaiting` is Safari 11.1+ [S36]. Home Screen apps on iOS are often resumed rather than relaunched, which is why `reg.update()` runs on `visibilitychange`.

---

## 7. Safari CSS support (Safari 18 → 27)

Versions are Safari desktop versions; Safari iOS mirrors them. Sources: BCD [S40], caniuse [S30], release notes [S2]/[S5]/[S41].

| Feature | Safari | Chrome | Firefox | Notes |
|---|---|---|---|---|
| `backdrop-filter` (unprefixed) | **18.0** | 76 | 103 | `-webkit-` prefix needed for Safari 9 to 17.x. In WebKit `-webkit-backdrop-filter` is now a cascade alias of `backdrop-filter` (`CSSProperties.json` L11220-11224). For iOS 18+ the prefix is optional; keeping both costs nothing. |
| `backdrop-filter: url(#svg)` | **No rendering at all** | Yes | Yes (UNVERIFIED) | WebKit: `m_canCompositeBackdropFilters = !style.backdropFilter().hasReferenceFilter() && ...` (`RenderLayerBacking.cpp` L921). Any `url()` in the list → the whole backdrop filter is dropped, blur included. The CA path implements only blur, brightness, contrast, grayscale, hue-rotate, invert, opacity, saturate, sepia and drop-shadow (`PlatformCAFiltersCocoa.mm`). There is no software fallback ("FIXME: This would clear the backdrop filters if we had a software implementation", `GraphicsLayerCA.cpp` L955-973). `@supports` cannot detect this, because the value parses. |
| `prefers-reduced-transparency` | **Not supported** (absent from WebKit `MediaQueryFeatures.cpp`) | 118 | flag only | BCD + source [S40][S40c] |
| `prefers-contrast` | 14.1 | 96 | 101 | WebKit values: `no-preference`, `more`, `less`, `custom` (`MediaQueryFeatures.cpp` L570-574) |
| `prefers-reduced-motion` | 10.1 (iOS 10.3) | 74 | 63 | |
| `prefers-color-scheme` | 12.1 (iOS 13) | 76 | 67 | |
| `color-mix()` | 16.2 | 111 | 113 | 26.2: works without a color space (defaults to oklab). 27: more than two colors. |
| `oklch()` / `oklab()` | 15.4 | 111 | 113 | Relative color syntax is correct from Safari 18 (16.4 to 17.x used an older spec) |
| `light-dark()` | 17.5 | 123 | 120 | `<image>` values: Safari 27 |
| `contrast-color()` | 26 | 147 | 146 | Useful for text on tinted glass |
| Size container queries `@container` | 16 | 105 | 110 | Style queries (custom properties): Safari 18. Scroll-state queries: not in Safari. |
| `:has()` | 15.4 | 105 | 121 | Many `:has()` invalidation performance fixes in 26.1 and 27 |
| View Transitions, same-document | **18.0** | 111 | 144 | `startViewTransition({update,types})` 18.2, `document.activeViewTransition` 26.2 |
| View Transitions, cross-document | 18.2 | 126 | 144 (partial) | |
| `scrollbar-gutter` | 18.2 | 94 | 97 | `scrollbar-color`: Safari 26.2 |
| `text-wrap: balance` | 17.5 | 114 (`text-wrap-style` 130) | 121 | `pretty`: Safari 26 |
| `@property` | 16.4 | 85 | 128 | Safari 26.4 fix: "the `initial-value` descriptor can be optional" (per spec this applies to `syntax: "*"`) |
| `env(safe-area-inset-*)` | 11 (`env()` 11.1) | 69 | 65 | |
| Anchor positioning | 26 | — | — | Many fixes in 26.1 to 26.4 |
| Scroll-driven animations | 26 | — | — | |
| `corner-shape` (squircles) | WebKit main has `CSSCornerShapeEnabled: stable, default true` (`UnifiedWebPreferences.yaml` L869-875). **Which Safari version ships it is UNVERIFIED** (no release-note entry found). | | | |

### 7.1 Backdrop root (why blur sometimes "does nothing")

MDN: `backdrop-filter` blurs only what lies between the element and its nearest **backdrop root** [S40b]. Backdrop roots are:
- the root element
- an element with `filter`
- an element with `opacity < 1`
- an element with `mask` / `mask-image` / `mask-border` / `clip-path`
- an element with `backdrop-filter`
- an element with `mix-blend-mode` other than `normal`
- an element with `will-change` naming any of these

Safari 26 also made `will-change: view-transition-name` create one [S5].

Consequences:
- A glass card inside a glass panel blurs only the panel's own content.
- Fading a wrapper with `opacity` while it animates also clips the blur. Animate `transform`/`opacity` on the glass element itself, or accept the effect.

### 7.2 Performance caveats (iOS)

- Each `backdrop-filter` element forces compositing: `RenderLayerCompositor.cpp` L3445 `|| renderer.hasBackdropFilter()) return true;`.
- Each also gets a dedicated Core Animation backdrop layer (`GraphicsLayerCA` `m_backdropLayer`).
- Safari 27 fixed "an extremely slow page load on iPhone caused by blur filters with large radii" [S41]. Older iOS versions are affected.
- Safari 18 fixed "`backdrop-filter: blur` to render for elements not present when the page is loaded" [S2e].

Practical limits (heuristics, **UNVERIFIED** numbers):
- Keep simultaneous visible glass layers small (≈ ≤ 6 to 10).
- Keep blur radius ≤ ~24px.
- Never put `backdrop-filter` on every row of a long scrolling list.
- Do not animate the `backdrop-filter` value itself.
- Prefer one glass layer per chrome element (nav bar, tab bar, sheet).

### 7.3 Glass recipe with accessibility fallbacks

```css
:root {
  --glass-tint: rgb(255 255 255 / .55); --glass-stroke: rgb(255 255 255 / .35); --glass-solid: #f5f6f8;
}
@media (prefers-color-scheme: dark) {
  :root { --glass-tint: rgb(28 30 36 / .55); --glass-stroke: rgb(255 255 255 / .12); --glass-solid: #1c1e24; }
}
.glass {
  background: var(--glass-tint);
  -webkit-backdrop-filter: blur(20px) saturate(180%);   /* iOS ≤17 */
  backdrop-filter: blur(20px) saturate(180%);           /* NO url() here — Safari would drop the whole effect */
  border: 1px solid var(--glass-stroke);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass { background: var(--glass-solid); }
}
@media (prefers-reduced-transparency: reduce) {           /* Chrome only; Safari ignores */
  .glass { background: var(--glass-solid); backdrop-filter: none; -webkit-backdrop-filter: none; }
}
:root[data-transparency="reduced"] .glass {               /* in-app toggle for Safari users */
  background: var(--glass-solid); backdrop-filter: none; -webkit-backdrop-filter: none;
}
@media (prefers-contrast: more) { .glass { background: var(--glass-solid); border-color: CanvasText; } }
@media (prefers-reduced-motion: reduce) { *, ::view-transition-group(*) { animation-duration: .01ms !important; } }
```

---

## 8. SSE (EventSource) on iOS Safari

**WebKit EventSource behavior** (`EventSource.cpp` [S33]):
- The default reconnection delay is **3000 ms** (L66). The server can override it with a `retry: <ms>` field (L423-428).
- When the network request ends normally or fails with a network error, the client reconnects after the delay (`networkRequestEnded` → `scheduleReconnect`, L146-153).
- A response with a **non-200 status, or a `Content-Type` other than `text/event-stream`**, makes the client cancel, fire `error`, and stop for good (L196-231). The spec says the same: "if res's status is not 200, or if res's `Content-Type` is not `text/event-stream`, then fail the connection ... Once the user agent has failed the connection, it does not attempt to reconnect." [S34]
- So a reverse-proxy **502/503/504 while the backend restarts kills the stream permanently**. The client must recreate it.
- A `204` from the server stops reconnection (spec) [S34].
- Back/forward-cache suspension: the client reconnects on resume (L438-458).
- Safari 27 fixed `EventSource` to close on `window.stop()` [S41].
- `EventSourceInit` has only `withCredentials`, so **no custom headers**. Use a same-origin cookie for auth, or a token in the query string [S34].
- On reconnect, the client sends the `Last-Event-ID` request header with the last `id:` it saw [S34].

**Backgrounding on iOS:**
- Apple documents nothing here.
- Community reports say the stream is killed or suspended when the Home Screen app is backgrounded or locked. On iOS 18 the `error` event may not fire, and `readyState` can still read `1` (OPEN) on return.
- Backgrounded clients can leave **zombie connections** on the server (**UNVERIFIED**, community [S35]).
- Mitigation:
  - On `visibilitychange` → `visible` (also `pageshow` and `focus`), close and recreate the `EventSource` if the page was hidden for more than ~10 s or if no heartbeat arrived in 2× the heartbeat interval.
  - On the server, drop clients whose socket write fails or that never acknowledge.

**Connection limits:**
- HTTP/1.1: about **6 concurrent connections per host**. MDN: "When **not used over HTTP/2**, SSE suffers from a limitation to the maximum number of open connections ... (6)" [S35b].
- Apple `URLSessionConfiguration.httpMaximumConnectionsPerHost` default is **6**, and "HTTP/2 and later ... ignore this property" [S35c]. WebKit's `NetworkSessionCocoa.mm` does not override it (no match for `HTTPMaximumConnectionsPerHost`).
- Each open `EventSource` permanently uses one of those 6 slots on HTTP/1.1. Multiple tabs or windows of the dashboard plus REST polling can starve.
- **Serve the dashboard over HTTP/2 at the reverse proxy** and use **one multiplexed SSE stream** (all topics via `event:` names). With HTTP/2 the stream limit is negotiated (MDN: "defaults to 100").

**Heartbeat:**
- WHATWG: "Legacy proxy servers are known to, in certain cases, drop HTTP connections after a short timeout. To protect against such proxy servers, authors can include a comment line (one starting with a ':' character) every 15 seconds or so." [S34]
- Send `: ping\n\n` every **15 s**. Also send `retry: 5000` once.

**Server example (Node/Fastify raw):**

```ts
app.get('/api/events', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',            // nginx: disable proxy buffering for this response (nginx docs; not re-fetched)
  });
  reply.raw.write('retry: 5000\n\n');
  const hb = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
  const send = (event: string, id: string, data: unknown) =>
    reply.raw.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
  const unsub = bus.subscribe(send);       // resume from req.headers['last-event-id'] if supported
  req.raw.on('close', () => { clearInterval(hb); unsub(); });
});
```

**Example wire stream:**

```text
retry: 5000

event: node-status
id: 1791640931-17
data: {"node":"pve1","cpu":0.0731,"mem":{"used":13421772800,"total":67430866944},"uptime":1209600}

: ping

```

**Client reconnect wrapper:**

```ts
let es: EventSource | null = null, hiddenAt = 0, lastMsg = Date.now(), backoff = 1000;
function connect() {
  es?.close();
  es = new EventSource('/api/events');            // same-origin cookie auth
  es.onopen = () => { backoff = 1000; };
  es.addEventListener('node-status', (e) => { lastMsg = Date.now(); /* update store */ });
  es.onerror = () => {
    if (es?.readyState === EventSource.CLOSED) {   // fatal (non-200 / wrong type): browser won't retry
      setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30_000);
    }                                              // CONNECTING: browser retries itself (3 s default / retry:)
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (Date.now() - hiddenAt > 10_000 || Date.now() - lastMsg > 35_000) connect();
});
connect();
```

(Count heartbeats as liveness too. Comment lines don't fire events, so for client-side liveness either send a tiny `event: hb` message instead of a comment, or rely on the visibility rule.)

---

## 9. Apple "Liquid Glass" and the web

- **No official Apple CSS or web guidance for Liquid Glass was found.**
  - Checked: WWDC25 "What's new in Safari and WebKit" (233) and "Learn more about Declarative Web Push" (235); WWDC26 "What's new in WebKit for Safari 27" (204) and the "Safari and Web Technologies Group Lab" (8015) transcripts; Safari 26.0 to 27.2 release notes. None mention Liquid Glass styling for web content [S4][S38][S42][S2].
- Apple's design guidance is for native apps (HIG "Materials") [S43]. Useful principles to mirror:
  - "Liquid Glass forms a distinct functional layer for controls and navigation elements — like tab bars and sidebars — that floats above the content layer".
  - "**Don't use Liquid Glass in the content layer.**" Use standard materials for content.
  - "**Use Liquid Glass effects sparingly.**"
  - Regular vs clear variants. For clear glass over bright content, "consider adding a dark dimming layer of 35% opacity".
  - Variants change with system settings such as reduce transparency and increase contrast. On the web, Safari exposes `prefers-contrast` but **not** `prefers-reduced-transparency`, hence the in-app toggle.
- WebKit internally has `-apple-visual-effect` with values such as `-apple-system-glass-material`, `-apple-system-glass-material-clear` and `-apple-system-blur-material-*` (`CSSProperties.json` L14378+). It is gated by the `useSystemAppearance` setting: `status: embedder`, `defaultValue: false` (`UnifiedWebPreferences.yaml` L6647-6651). That is an app-embedder (WKWebView) feature and **not available to web pages in Safari**. Don't use it.
- Safari 26 platform behaviors that matter:
  - Toolbar tint comes from the page background in tabs; `theme-color` applies only to installed web apps (§5.4).
  - "Added support for applying `backdrop-filter` to content behind a transparent webview" and a new `obscuredContentInsets` WKWebView API. Both are WKWebView-embedder features, not page CSS [S5].
  - Any site can become a web app on iOS (§1).
- Realistic web approximation: `backdrop-filter: blur() saturate()`, a translucent tint, a 1px light inner stroke, and a subtle specular gradient. Refraction effects built on SVG `feDisplacementMap` via `backdrop-filter: url()` work only in Chromium and **disable the backdrop entirely in Safari** (§7).

---

## 10. UNVERIFIED / open items

1. Whether Web Push works in an iOS 26+ Home Screen web app that has **no manifest**. Ship a manifest.
2. Whether WebKit still fires `notificationclick` on iOS (BCD says no; community reports are mixed). Also whether passing `navigate` to `showNotification()` suppresses `notificationclick`.
3. Whether Apple rejects `TTL: 0` (its doc wording says TTL must be "a positive number").
4. The exact Apple success body and header casing; Apple's behavior on reserved TLDs in `mailto:` subjects (community reports only).
5. Safari support for `mobile-web-app-capable`; precedence between `apple-mobile-web-app-title` and manifest `short_name`.
6. iOS 26 `apple-touch-startup-image` behavior, and whether iOS generates any splash.
7. The exact iOS background behavior of EventSource and its timings (community only).
8. The exact Safari 26 tab-bar tint sampling rules (community and WebKit bug only).
9. Which Safari release ships `corner-shape`.
10. The Firefox push endpoint hostname.
11. Safari behavior with self-signed or private-CA certificates for service worker and push on a LAN. Use a publicly trusted certificate (e.g. ACME DNS-01 for a real domain such as `pve1-dash.home.example.net`), or install and **fully trust** the private CA on every iOS device.

---

## Sources

- **[S1]** caniuse `push-api` / `notifications` data (Fyrd/caniuse `fulldata-json/data-2.0.json`, updated 2026-10-06): https://raw.githubusercontent.com/Fyrd/caniuse/main/fulldata-json/data-2.0.json
- **[S2]** Safari 16.4 Release Notes, "Web Apps" section (Web Push for Home Screen apps, manifest `id`, Badging API, third-party Add to Home Screen): https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes
  - **[S2b]** Safari 17.2 Release Notes, Web Apps (maskable icon guidance, `scope` fix, `theme-color` title bar fix): https://developer.apple.com/documentation/safari-release-notes/safari-17_2-release-notes
  - **[S2c]** Safari 18.4 Release Notes ("Added support for Declarative Web Push.") and Safari 18.5 Release Notes ("Added support for Declarative Web Push on macOS."): https://developer.apple.com/documentation/safari-release-notes/safari-18_4-release-notes and https://developer.apple.com/documentation/safari-release-notes/safari-18_5-release-notes
  - **[S2d]** Safari 26.2 Release Notes (`mutable` fix, `color-mix()` default space, `scrollbar-color`, `activeViewTransition`, dialog backdrop under address bar): https://developer.apple.com/documentation/safari-release-notes/safari-26_2-release-notes
  - **[S2e]** Safari 18 Release Notes ("Added support for the unprefixed `backdrop-filter`", blur render fix): https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes
- **[S3]** Apple: "Sending web push notifications in web apps and browsers" (headers, error table, `reason` codes, 4 KB, JWT rules, `*.push.apple.com`): https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers (JSON: https://developer.apple.com/tutorials/data/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers.json)
- **[S4]** WWDC25 session 235 "Learn more about Declarative Web Push" (transcript): https://developer.apple.com/videos/play/wwdc2025/235/
- **[S5]** Safari 26.0 Release Notes (any website can become a web app; SVG and `data:` icons; `backdrop-filter` behind transparent webview; `obscuredContentInsets`; `will-change: view-transition-name` backdrop root): https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes
- **[S6]** WebKit `Source/WebCore/rendering/RenderLayerBacking.cpp` L916-921 (reference filters prevent backdrop compositing): https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/rendering/RenderLayerBacking.cpp
- **[S7]** WebKit `GraphicsLayerCA.cpp` L955-973 and `PlatformCAFiltersCocoa.mm` (supported CA filter ops): https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/graphics/ca/GraphicsLayerCA.cpp , https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/graphics/ca/cocoa/PlatformCAFiltersCocoa.mm
- **[S10]** WebKit `Source/WebCore/Modules/push-api/PushManager.cpp` L79-181: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/push-api/PushManager.cpp
- **[S11]** WebKit `Source/WebCore/Modules/notifications/Notification.cpp` L419-450: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/Notification.cpp
- **[S12]** WebKit `Source/WebCore/page/LocalDOMWindow.cpp` L201 (`defaultTransientActivationDuration { 5_s }`): https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/LocalDOMWindow.cpp
- **[S13]** WebKit `Source/WebCore/Modules/notifications/NotificationData.h` L42-43 (`silentPushTimeoutForProduction { 30_s }`): https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/NotificationData.h
- **[S14]** WebKit `Source/WebKit/Shared/WebPushDaemonConstants.h` L34-35; `Source/WebKit/webpushd/PushService.mm` L645-669; `Source/WebKit/webpushd/WebPushDaemon.mm` L681-745; `Source/WebCore/Modules/push-api/PushDatabase.cpp` L728-762: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/Shared/WebPushDaemonConstants.h (others under the same repo path)
- **[S15]** WebKit `Source/WebCore/workers/service/context/ServiceWorkerThread.cpp` L299-380: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/workers/service/context/ServiceWorkerThread.cpp
- **[S16]** W3C Push API editor's draft source, "Declarative push message" section (members, parser, receive steps): https://raw.githubusercontent.com/w3c/push-api/gh-pages/index.html
  - **[S16a]** WebKit `Source/WebCore/Modules/notifications/NotificationJSONParser.cpp`: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/Modules/notifications/NotificationJSONParser.cpp
  - **[S16b]** WebKit explainer (older, superseded design): https://raw.githubusercontent.com/WebKit/explainers/main/DeclarativeWebPush/README.md
- **[S17]** WebKit IDLs `PushEvent.idl`, `PushManager.idl`, `PushSubscriptionOptionsInit.idl`, `NotificationOptions.idl`, `Notification.idl`, `NotificationEvent.idl` (under `Source/WebCore/Modules/push-api/` and `Source/WebCore/Modules/notifications/`): https://github.com/WebKit/WebKit/tree/main/Source/WebCore/Modules/push-api
- **[S18]** WebKit `Source/WebCore/page/WorkerNavigator.idl` L37, `Source/WebCore/Modules/badge/NavigatorBadge.idl` L27-30, `Source/WebCore/page/Navigator.idl` L26 (`standalone`).
- **[S19]** WebKit `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml`: `PushAPIEnabled` L4985, `DeclarativeWebPush` L1849, `NotificationEventEnabled` L4483, `UseSystemAppearance` L6647, `CSSCornerShapeEnabled` L869: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml
- **[S20]** MDN browser-compat-data: `manifests/webapp/*.json` (display, display_override, id, scope, start_url, icons, name, short_name, theme_color, background_color, shortcuts, orientation, description) and `html/elements/meta.json` (theme-color note "From Safari 26, the theme color is only used for installed web apps."): https://raw.githubusercontent.com/mdn/browser-compat-data/main/manifests/webapp/display.json (etc.), https://raw.githubusercontent.com/mdn/browser-compat-data/main/html/elements/meta.json
- **[S21]** `web-push@3.6.7` npm tarball README (localhost BadJwtToken note at README L196; FCM endpoint example): `npm pack web-push@3.6.7`
  - **[S21b]** web-push GitHub master README (unreleased; "mailto:user@localhost ... 403 BadJwtToken"): https://raw.githubusercontent.com/web-push-libs/web-push/master/README.md
- **[S22]** `web-push@3.6.7` published source: `src/index.js`, `src/web-push-lib.js` (L13 DEFAULT_TTL, L111-130 defaults and options, L377-390 resolve/reject), `src/vapid-helper.js` (L14, L17, L68-89, L221, L234), `src/web-push-error.js`. `npm view web-push` / `@types/web-push`. Local tests on Node v22.22.0 (ESM import shape, header generation, JWT claims, 3993/4096 sizes).
- **[S23]** RFC 8291 source draft (webpush-wg), payload size paragraph: https://raw.githubusercontent.com/webpush-wg/webpush-encryption/master/draft-ietf-webpush-encryption.md
- **[S24]** RFC 8292 (VAPID) source draft (webpush-wg), `sub` and `exp` claims: https://raw.githubusercontent.com/webpush-wg/webpush-vapid/master/draft-ietf-webpush-vapid.md
- **[S25]** Community reports of Apple `403 BadJwtToken` with localhost or reserved-TLD subjects (via web search): https://github.com/openclaw/openclaw/issues/83134 , https://github.com/alphastorm/omp-session-gateway/issues/173 , https://github.com/amiantos/lurker/pull/1058
- **[S26b]** Chrome deprecation warning for `apple-mobile-web-app-capable` (community): https://github.com/vercel/next.js/issues/70272 , https://github.com/flutter/flutter/issues/154596
- **[S26c]** iOS splash / `apple-touch-startup-image` (community + web.dev, via search): https://web.dev/learn/pwa/enhancements , https://github.com/elegantapp/pwa-asset-generator
- **[S27]** Apple Developer Forums 719990, "Web Push response is always success, even if subscription no longer valid" (201 from web.push.apple.com): https://developer.apple.com/forums/thread/719990
- **[S28]** Community: subscription removed while permission stays granted: https://github.com/besidka/besidka/pull/398
  - **[S28b]** Apple forums on `notificationclick` / `openWindow` on iOS: https://developer.apple.com/forums/thread/733604 , https://developer.apple.com/forums/thread/768448
- **[S29]** WebKit blog "Web Push for Web Apps on iOS and iPadOS" (2023; read via search snippet only, webkit.org unreachable): https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- **[S30]** caniuse data (push-api notes #3/#5/#7, notifications, backdrop-filter, view-transitions, container queries, :has, text-wrap-balance, env, http2, eventsource): https://raw.githubusercontent.com/Fyrd/caniuse/main/fulldata-json/data-2.0.json
  - **[S30a]** Safari 16.1 Release Notes ("Added Web Push Notifications support on macOS Ventura."): https://developer.apple.com/documentation/safari-release-notes/safari-16_1-release-notes
  - **[S30b]** Safari 17 Release Notes (web apps on macOS Sonoma; Web Push per profile): https://developer.apple.com/documentation/safari-release-notes/safari-17-release-notes
- **[S31]** WebKit blog "WebKit Features in Safari 26.0" (manifest no longer required; read via search snippet): https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
  - **[S31b]** WebKit bug 301756 (Safari 26 top bar tint from html/body background; via search snippet) and community write-ups: https://bugs.webkit.org/show_bug.cgi?id=301756 , https://developer.apple.com/forums/thread/801239
  - **[S31c]** WebKit blog "Designing Websites for iPhone X" (`viewport-fit`, `env()`; via search snippet): https://webkit.org/blog/7929/designing-websites-for-iphone-x/
- **[S32]** Apple Safari HTML Reference, "Supported Meta Tags" (`apple-mobile-web-app-capable`, `status-bar-style` values), and Safari Web Content Guide "Configuring Web Applications" (apple-touch-icon sizes, startup image, title): https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html , https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
- **[S33]** WebKit `Source/WebCore/page/EventSource.cpp` (L66, L146-176, L196-231, L273-311, L423-458): https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/page/EventSource.cpp
- **[S34]** WHATWG HTML source, Server-sent events (EventSourceInit; fail-the-connection rules; 204; Last-Event-ID; "every 15 seconds or so"): https://raw.githubusercontent.com/whatwg/html/main/source
- **[S35]** Community reports on iOS PWA SSE backgrounding (via search): https://github.com/CodeVachon/family-chat/pull/85 , https://github.com/jundot/omlx/issues/2868
  - **[S35b]** MDN `EventSource` (6-connection note): https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/eventsource/index.md
  - **[S35c]** Apple `URLSessionConfiguration.httpMaximumConnectionsPerHost` (default 6; ignored by HTTP/2): https://developer.apple.com/documentation/foundation/urlsessionconfiguration/httpmaximumconnectionsperhost
- **[S36]** MDN browser-compat-data `api/*.json`: PushManager, PushSubscription, PushSubscriptionOptions, PushEvent, Navigator (setAppBadge), Window (pushManager), Notification, ServiceWorkerRegistration, ServiceWorkerGlobalScope, Clients, WindowClient; `css/at-rules/media.json` (display-mode notes): https://github.com/mdn/browser-compat-data/tree/main/api
  - **[S36b]** MDN `Clients.openWindow()`: https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/clients/openwindow/index.md
- **[S37]** WWDC22 session 10098 "Meet Web Push for Safari" (transcript): https://developer.apple.com/videos/play/wwdc2022/10098/
- **[S38]** WWDC25 session 233 "What's new in Safari and WebKit" (transcript): https://developer.apple.com/videos/play/wwdc2025/233/
- **[S39]** Node.js deprecations DEP0169 (docs for Node v26.11.1): https://nodejs.org/api/deprecations.html
- **[S40]** MDN browser-compat-data `css/properties/backdrop-filter.json`, `css/at-rules/media.json`, `css/types/color.json`, `css/at-rules/container.json`, `css/selectors/has.json`, `css/properties/scrollbar-gutter.json`, `css/properties/text-wrap*.json`, `css/at-rules/property.json`, `css/types/env.json`, `api/Document.json`, `api/ViewTransition.json`: https://github.com/mdn/browser-compat-data/tree/main/css
  - **[S40b]** MDN `backdrop-filter` (Backdrop root section): https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/css/reference/properties/backdrop-filter/index.md
  - **[S40c]** WebKit `Source/WebCore/css/query/MediaQueryFeatures.cpp` (supported media features; `prefers-contrast` L570-600; `display-mode` L765-797) and `Source/WebCore/css/CSSProperties.json` (`-webkit-backdrop-filter` alias L11220-11224; `-apple-visual-effect` L14378+): https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/css/query/MediaQueryFeatures.cpp , https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/css/CSSProperties.json
- **[S41]** Safari 27 Release Notes (released 2026-09-14; blur performance fix, `color-mix()` variadic, EventSource `window.stop()`): https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes
- **[S42]** WWDC26 session 204 "What's new in WebKit for Safari 27" and 8015 "Safari and Web Technologies Group Lab" (transcripts): https://developer.apple.com/videos/play/wwdc2026/204/ , https://developer.apple.com/videos/play/wwdc2026/8015/
- **[S43]** Apple Human Interface Guidelines, "Materials" (Liquid Glass guidance): https://developer.apple.com/design/human-interface-guidelines/materials
- npm registry (2026-10-10): `vite-plugin-pwa` 2.0.0 (2026-10-03), 1.3.0 (2026-05-05); `workbox-window`/`workbox-build` 7.4.1; `vite` 8.3.4; `@types/web-push` 3.6.4 (2024-10-22).
