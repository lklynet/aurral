# Aurral Connect

Status: Proposed

## Problem

Most Aurral servers run on a home network behind NAT with no public HTTPS address. Without one, `music.aurral.org` cannot reach the server (browsers block mixed HTTPS-to-HTTP requests), mobile and desktop apps need a VPN or reverse proxy off-network, and Subsonic clients only work at home. Cloudflare's non-Enterprise terms prohibit streaming audio through its proxy, and relaying media traffic has real ongoing bandwidth and operating costs.

## Decision

Offer **Aurral Connect**, an optional paid relay service ($5/month or $50/year after a 14-day free trial) that gives each server a stable `https://<slug>.aurral.dev` address, automatic sign-in across clients, and Connect-backed listen links.

- **Software stays free; hosted infrastructure is paid.** Every native feature, `music.aurral.org`, desktop, mobile, and Subsonic remains free forever with a user's own domain, reverse proxy, or VPN. There is no free forever tunnel tier: most users run one server, so a free tier would prevent conversion, saturate relay ports with non-paying traffic, and invite abuse.
- **One simple plan.** One subscription covers up to 3 servers under the account and household users on those servers (capped per server, e.g. 10 linked users, to prevent public multi-tenant streaming over a single tunnel). Billing runs through a Merchant of Record (Polar) in `hub/`.
- **Dedicated tunnel domain (`*.aurral.dev`).** User tunnels live on `https://<slug>.aurral.dev` with DNS-only (unproxied) records pointing to the relay, never on `*.aurral.org` and never orange-clouded through Cloudflare. This isolates cookies and domain reputation from `aurral.org` and `music.aurral.org`, stays compliant with Cloudflare's terms, and benefits from `.dev` HSTS preloading.
- **Canonical web UX at `music.aurral.org`.** Navigating to `https://<slug>.aurral.dev/` in a browser redirects to `https://music.aurral.org`, keeping static UI assets on Cloudflare's edge instead of the user's home upload and relay bandwidth. `/api/*`, `/ws`, `/rest/*`, and `/share/*` route straight to the server.
- **Wildcard TLS on a stateless relay.** Caddy on an unmetered VPS (starting on OVHcloud) terminates a single `*.aurral.dev` wildcard certificate in front of a small open-source TypeScript/Node relay in `relay/` that shares the tunnel framing protocol with `backend/` through `lib/`. Each Aurral server opens one persistent outbound multiplexed TLS connection (port 443, pure TypeScript in Aurral with no external tunnel binary) using a short-lived Ed25519 tunnel ticket minted by `hub/`. The relay verifies tickets locally with no database and logs no payloads, tokens, or stream contents. If a relay box dies, spinning up a replacement and flipping DNS reconnects every server automatically.
- **Dedicated Connect listener, never local.** Tunnel traffic enters Aurral on a dedicated internal listener/context where no request ever counts as local: no onboarding, no auth-disabled mode, no local-network bypass, and no proxy-auth headers. It accepts Bearer session tokens on `/api/*` and `/ws`, Subsonic auth (`apiKey` and standard user/token) on `/rest/*`, active listen links on `/share/*`, and public bootstrap for `music.aurral.org`, with rate limiting on login, exchange, and Subsonic auth.
- **Local accounts vs Aurral accounts.** Local accounts continue to own library profiles, permissions, playlists, play history, and offline LAN access. Free social linking keeps its one-way trust per [0014](./0014-accounts-and-the-hub.md). Enabling Connect explicitly opts the server into **"Sign in with Aurral"** for linked users, behind a Settings toggle the admin can turn off at any time.
- **Zero-config sign-in across clients.** On `music.aurral.org`, mobile, and desktop frontend-only mode, signing in with `aurral.org` fetches the user's linked servers (`GET /v1/connect/servers`). When one server is linked (or after picking from a list), the client exchanges a short-lived, single-use Ed25519 assertion minted by `hub/` (`aud: instanceId`, `sub: accountId`, `jti`, 60s expiry) at `POST https://<slug>.aurral.dev/api/auth/connect-exchange` for an ordinary local Bearer session token. After exchange, `aurral.org` is out of the auth loop and the client talks directly to the server.
- **Broader `aurral.org` sign-in.** Add email magic link (and Apple/Google sign-in as needed for mobile app review and non-technical `Aurral.dmg` users) alongside Discord and GitHub in `hub/`.
- **LAN-first routing for native clients.** Servers can publish local LAN address hints alongside their Connect URL. Desktop (frontend-only) and mobile apps probe LAN first with a short timeout and stream directly on Wi-Fi without touching the relay, falling back to `https://<slug>.aurral.dev` off-network. `music.aurral.org` stays HTTPS-only because of browser mixed-content rules.
- **Listen links on Connect.** When Connect is active, listen links advertise `https://<slug>.aurral.dev` instead of starting `cloudflared` quick tunnels. The share lookup in `aurral.org` accepts verified `*.aurral.dev` origins alongside `*.trycloudflare.com` (see [0005](./0005-listen-links.md)).
- **Every way in has a way out.** Disabling Connect, revoking a link, or letting a subscription lapse stops new tunnel tickets and remote sign-in while leaving local accounts, sessions on LAN, and self-hosted remote access intact.

## Traps

- **Let's Encrypt 50 certs/week limit.** Per-server DNS-01 certificates on one apex domain hit Let's Encrypt's weekly cap during launch. Wildcard TLS at the relay avoids this cliff; moving to end-to-end SNI passthrough later requires a Let's Encrypt rate-limit exemption or Public Suffix List entry first.
- **`.dev` HSTS preload.** Browsers always force HTTPS on `*.aurral.dev`. Local development and staging need a configurable connect domain override (e.g. `AURRAL_CONNECT_DOMAIN`) or valid local TLS.
- **Subdomain takeover and reserved slugs.** Reserve infrastructure and common names (`relay`, `us`, `eu`, `api`, `www`, `mail`, `status`, `admin`, `auth`, `connect`, `music`, `hub`, `docs`, `data`, `share`, `app`, `cdn`, `static`, `staging`, `dev`, `test`) before launch, and hold released slugs for 90 days (matching handles in [0014](./0014-accounts-and-the-hub.md)) so another user cannot claim an old Subsonic or listen-link hostname.
- **Root redirect scope.** Redirecting `https://<slug>.aurral.dev/` to `https://music.aurral.org` must only match browser HTML navigations to the root, never `/api/*`, `/ws`, `/rest/*`, `/share/*`, or CORS preflights.
- **Cloudflare DNS proxy flag.** All `*.aurral.dev` and relay DNS records must remain DNS-only (grey-clouded) so media streams never pass through Cloudflare.
- **Laptop sleep (`Aurral.dmg` Full Mode).** Closing a laptop drops the tunnel. The relay reports live online/offline status to `hub/` so clients show a clear "server is offline or asleep" state instead of a generic connection failure, and desktop Full Mode should stay alive in the menu bar when the window closes.
- **Restored backup duplicate connections.** Two instances restored from the same backup share an `instanceId` and link credentials. The relay should accept the latest connection and close the older one cleanly (with a warning surfaced to the admin) instead of allowing reconnect loops.

## Alternatives

- **End-to-end SNI passthrough from day one.** Strongest privacy story, but adds ACME client logic in Aurral, DNS-01 plumbing, 30-90s activation latency, renewal failure modes on user machines, and Let's Encrypt's 50 certs/week cap. Worth revisiting only after Connect has revenue and a rate-limit exemption.
- **Cloudflare Tunnel or Enterprise.** Non-Enterprise plans forbid audio streaming; Enterprise quotes start around $5,000/month.
- **Shared `music.aurral.org` Subsonic endpoint.** Local usernames collide across servers (`admin`), routing requires decrypting every request at a central proxy, and it would pull `music.aurral.org` off Cloudflare's static edge.
- **Free forever tunnel tier.** Would saturate relay capacity with non-paying traffic, attract abuse, and remove the main reason single-server users subscribe.
