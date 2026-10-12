# 🔐 Putting pve1-dash behind your HTTPS reverse proxy

pve1-dash listens on plain HTTP inside its container (`http://<container-ip>:8080`). Your reverse proxy adds HTTPS,
which the dashboard needs for the things that make it feel like an app:

- **Add to Home Screen + Web Push on iPhone/iPad** only work on an `https://` origin, and the certificate has to be
  trusted by the device: a public one (Let's Encrypt via a DNS challenge works fine for LAN-only names) or your own CA
  installed **and fully trusted** on every device (Settings → General → About → Certificate Trust Settings).
- **Live updates** use one Server-Sent Events stream at `/api/stream`. The proxy must pass it through without buffering.

Recipes below: [Nginx Proxy Manager](#nginx-proxy-manager) · [plain nginx](#plain-nginx) · [Caddy](#caddy) ·
[Traefik](#traefik). Replace `dash.home.lan` with your name and `10.0.0.50` with the container's IP (the installer
prints it; `pct exec <ctid> -- ip -4 addr show eth0` shows it again).

**Before you start:**

- **The container's address must not move.** The proxy forwards to an IP address. If the container got its address by
  DHCP (the installer's default), reserve it in your router for the container's MAC (the install summary prints it;
  `pct config <ctid> | grep net0` shows `hwaddr=`), or make it static by re-running the installer with
  `PVE1_DASH_IP=<address>/24 PVE1_DASH_GATEWAY=<router>` (applied in place). Otherwise a reboot can turn your
  dashboard into a 502.
- **`publicUrl`** in `/etc/pve1-dash/config.yaml` should be this URL (the installer asked for it; set it later with
  `pve1-dash-config` in the container, or by re-running the installer with `PVE1_DASH_PUBLIC_URL=https://...`).
- **`listen.allowedSources`**: if the dashboard only accepts your LAN (the installer's default, e.g. `10.10.10.0/24`),
  the **proxy's own address** must be inside it, because the proxy is what connects. A proxy elsewhere gets HTTP 403.

## ⚡ Why HTTP/2 matters

Browsers allow only **6 connections per host over HTTP/1.1**, across all tabs. Each open dashboard tab holds one of
them for the live stream forever, so with a few tabs (or the Home Screen app plus Safari) the page starts hanging on
ordinary requests. Over **HTTP/2** everything shares one connection and the limit is about 100 streams. Turn HTTP/2 on
in every recipe below (Caddy and Traefik do it by default).

## What every proxy must do

| Need | Why |
|---|---|
| Forward everything to `http://10.0.0.50:8080` | the app, the API, `/setup/guest.sh` and `/healthz` live on one port |
| No buffering of `/api/stream`, read timeout above 15 s | live updates; the server sends `X-Accel-Buffering: no` (nginx and NPM honour it) and a heartbeat every 15 s |
| Don't cache `/sw.js`, `/index.html`, `/manifest.webmanifest` | the server sends the right `Cache-Control` headers; a proxy cache that ignores them breaks updates of the app |
| Pass `Host` and `X-Forwarded-Proto/For` | used for links when `publicUrl` is not set, and for logs |
| Keep it on the LAN | there is no login; see [docs/SECURITY.md](../../docs/SECURITY.md) |

---

## Nginx Proxy Manager

In the NPM web UI: **Hosts → Proxy Hosts → Add Proxy Host**.

**Details** tab:

1. **Domain Names:** `dash.home.lan`
2. **Scheme:** `http` · **Forward Hostname / IP:** `10.0.0.50` · **Forward Port:** `8080`
3. **Cache Assets: OFF.** NPM's asset cache keeps every `.js`/`.css`/image for 30 minutes and ignores the app's
   `Cache-Control` headers, so it would serve a stale `sw.js` and the app would never update.
4. **Block Common Exploits:** on (fine either way).
5. **Websockets Support: ON.** pve1-dash uses SSE, not WebSockets, but the toggle also switches on the HTTP/1.1
   upgrade headers and does no harm.
6. **Access List:** one that only allows your LAN, e.g. `allow 10.10.10.0/24` + `deny all` (see
   [Adding a login](#-adding-a-login-in-front)), or "Publicly Accessible" if the proxy is only reachable from your LAN.

**SSL** tab:

1. **SSL Certificate:** request a new Let's Encrypt certificate (DNS challenge for a LAN-only name) or pick an
   existing one.
2. **Force SSL:** ON.
3. **HTTP/2 Support:** ON.
4. HSTS: optional.

**Advanced** tab: **leave it empty.** Nothing is needed there: the server switches nginx's buffering off for the live
stream itself (`X-Accel-Buffering: no`), sends a heartbeat every 15 s (NPM's read timeout is 90 s), and NPM already
speaks HTTP/1.1 to the backend.

> ⚠️ **Never put a `location` block into the Advanced tab of a host that has an Access List.** NPM applies the access
> list only inside the locations it generates itself, so a hand-written `location /api/stream { ... }` there would let
> everyone read the live stream, which carries the whole snapshot (every guest, address, service and task), past your
> allow-list. If you ever want explicit settings for a path, use the **Custom Locations** tab instead: location
> `/api/stream`, scheme `http`, the same forward host and port, and in its gear-icon box
> `proxy_buffering off; proxy_read_timeout 1h;`. Custom Locations keep the access list. (From NPM's templates and
> source; not run inside an NPM container.)

Save, open `https://dash.home.lan`, and check the live dot in the toolbar turns green.

---

## Plain nginx

`/etc/nginx/sites-available/pve1-dash` (then `ln -s` it into `sites-enabled` and `nginx -t && systemctl reload nginx`):

```nginx
server {
    listen 80;
    server_name dash.home.lan;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;                      # nginx >= 1.25.1; older versions: "listen 443 ssl http2;" and drop this line
    server_name dash.home.lan;

    ssl_certificate     /etc/ssl/dash.home.lan/fullchain.pem;
    ssl_certificate_key /etc/ssl/dash.home.lan/privkey.pem;

    # Live updates (Server-Sent Events)
    location /api/stream {
        proxy_pass http://10.0.0.50:8080;
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
        proxy_pass http://10.0.0.50:8080;
        proxy_http_version 1.1;    # the default is 1.0 before nginx 1.29.7
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

nginx gotcha: `proxy_set_header` lines from an outer block are inherited **only** when a location defines none, which
is why each location repeats them.

---

## Caddy

Caddy flushes `text/event-stream` responses immediately and speaks HTTP/2 by default, so nothing special is needed:

```caddyfile
dash.home.lan {
	tls internal              # or your ACME / DNS-challenge setup
	encode zstd gzip          # optional; Caddy never holds back SSE
	reverse_proxy 10.0.0.50:8080
}
```

With `tls internal`, install Caddy's root certificate on your devices and trust it fully, or Safari won't allow
Web Push.

---

## Traefik

Traefik flushes SSE immediately (Go's reverse proxy does that for `text/event-stream`) and serves HTTP/2 on TLS
entry points. Docker labels on a container that runs next to Traefik can't point at the LXC, so use the file provider:

```yaml
# dynamic/pve1-dash.yml
http:
  routers:
    pve1-dash:
      rule: "Host(`dash.home.lan`)"
      entryPoints: [websecure]
      service: pve1-dash
      tls:
        certResolver: letsencrypt   # or your own TLS setup
  services:
    pve1-dash:
      loadBalancer:
        servers:
          - url: "http://10.0.0.50:8080"
```

If you prefer Docker labels (for example on a small placeholder container next to Traefik), the equivalent is below.
Pointing a label-defined service at an outside URL needs `loadbalancer.server.url`, which only newer Traefik v3
releases accept (**UNVERIFIED** which version added it); the file provider above works everywhere.

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.pve1-dash.rule=Host(`dash.home.lan`)
  - traefik.http.routers.pve1-dash.entrypoints=websecure
  - traefik.http.routers.pve1-dash.tls.certresolver=letsencrypt
  - traefik.http.services.pve1-dash.loadbalancer.server.url=http://10.0.0.50:8080
```

If you use Traefik's `compress` middleware, SSE still works; you can add `excludedContentTypes: [text/event-stream]`
to be safe. (Caddy and Traefik behaviour was checked in their source, not live-tested.)

---

## 🔑 Adding a login in front

pve1-dash itself has no login: it is read-only and meant for your LAN. If more people or devices share that LAN than
you'd like, restrict it at the proxy:

- **IP allow-list (friendliest):** allow only your LAN/VPN ranges. NPM: Access Lists → Access tab with `allow
  10.10.10.0/24` and `deny all`, picked on the proxy host's Details tab; nginx: `allow`/`deny` in the `server` block.
  Two NPM caveats (see [docs/SECURITY.md](../../docs/SECURITY.md#lan-only-no-login)): the list doesn't cover
  `location` blocks typed into the Advanced tab, and NPM trusts the `X-Real-IP` header from every private network,
  so a device on another private subnet (an IoT VLAN) can pretend to be on your LAN. Optional hardening, untested
  inside NPM: put only `set_real_ip_from 127.0.0.1;` into that host's Advanced tab (it replaces NPM's list of trusted
  networks for this host).
- **The dashboard's own allow-list** (`listen.allowedSources`) closes the direct way around the proxy
  (`http://<container-ip>:8080`) and can't be fooled by headers; keep the proxy's address in it.
- **The real fix for untrusted devices** is at the router: don't let the IoT VLAN reach your LAN at all.
- **Proxy authentication:** NPM Access List with users, nginx `auth_basic`, Caddy `basic_auth`, Traefik `basicAuth`
  middleware, or an SSO forward-auth such as Authelia/Authentik. Note: how the iOS Home Screen app behaves with HTTP
  Basic auth (re-prompts, background push registration) is **UNVERIFIED**; an IP allow-list or SSO with long sessions
  avoids the question.

Never forward the dashboard to the internet without one of these. See [docs/SECURITY.md](../../docs/SECURITY.md).

## ✅ Check it

```bash
curl -sI https://dash.home.lan/ | grep -iE '^(HTTP|content-security-policy)'
curl -sN https://dash.home.lan/api/stream | head -c 300   # should print "retry: 3000" and an event right away
curl -s --http2 -o /dev/null -w '%{http_version}\n' https://dash.home.lan/   # 2 means HTTP/2 is on
```

With an access list, check that it covers the live stream too, **from a machine outside the allowed network** that
can still reach the proxy (e.g. a laptop on the IoT or guest VLAN):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://dash.home.lan/api/stream   # must print 403
```

And inside the container, `pve1-dash-doctor` checks the dashboard end to end.

Still stuck? [docs/TROUBLESHOOTING.md → "Live updates stop or never start"](../../docs/TROUBLESHOOTING.md#-live-updates-stop-or-never-start-sse-through-the-proxy).
