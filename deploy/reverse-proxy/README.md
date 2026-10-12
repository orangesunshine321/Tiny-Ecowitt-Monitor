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

After the proxy works, put the URL into `/etc/pve1-dash/config.yaml` as `publicUrl: https://dash.home.lan` (the
installer asked for it) and `systemctl restart pve1-dash` inside the container.

## ⚡ Why HTTP/2 matters

Browsers allow only **6 connections per host over HTTP/1.1**, across all tabs. Each open dashboard tab holds one of
them for the live stream forever, so with a few tabs (or the Home Screen app plus Safari) the page starts hanging on
ordinary requests. Over **HTTP/2** everything shares one connection and the limit is about 100 streams. Turn HTTP/2 on
in every recipe below (Caddy and Traefik do it by default).

## What every proxy must do

| Need | Why |
|---|---|
| Forward everything to `http://10.0.0.50:8080` | the app, the API, `/setup/guest.sh` and `/healthz` live on one port |
| No buffering and a long read timeout for `/api/stream` | live updates; the server sends a heartbeat every 15 s and `X-Accel-Buffering: no` |
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
6. **Access List:** "Publicly Accessible", or an access list that only allows your LAN (see
   [Adding a login](#-adding-a-login-in-front)).

**SSL** tab:

1. **SSL Certificate:** request a new Let's Encrypt certificate (DNS challenge for a LAN-only name) or pick an
   existing one.
2. **Force SSL:** ON.
3. **HTTP/2 Support:** ON.
4. HSTS: optional.

**Advanced** tab, **Custom Nginx Configuration** (NPM inserts it into the `server` block):

```nginx
# pve1-dash live updates (Server-Sent Events): stream immediately, keep the connection open.
location /api/stream {
    include conf.d/include/proxy.conf;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}
```

`conf.d/include/proxy.conf` is NPM's own file with the `proxy_pass` and `X-Forwarded-*` lines, so this location
behaves like the default one plus the streaming settings. (Built from NPM's templates and checked against its source;
not run inside an NPM container. If NPM rejects it, save without the Advanced snippet: streaming still works because
the server sends `X-Accel-Buffering: no`, it is just less explicit.)

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
  192.168.1.0/24` and `deny all`; nginx: `allow`/`deny` in the `server` block.
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

Still stuck? [docs/TROUBLESHOOTING.md → "Live updates stop or never start"](../../docs/TROUBLESHOOTING.md#-live-updates-stop-or-never-start-sse-through-the-proxy).
