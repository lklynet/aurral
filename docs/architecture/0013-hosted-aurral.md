# Hosted Aurral

Status: Accepted

## Problem

People want to reach their server from any browser without remembering its address, and some use more than one server. Today every server serves its own copy of the app at its own address, and a browser tab knows only that one.

## Decision

The Aurral web app also runs at `music.aurral.org` as a client that calls servers' APIs directly. aurral.org serves static files and never carries a server's traffic.

- **The hosted app is only a client.** `vite build --mode hosted` builds the normal frontend with a small loader as its entry. It keeps its servers in localStorage and sets the API base per page load, never through `VITE_API_URL`.
- **The server owns sign-in.** A signed-in user opens `https://music.aurral.org/pair#<code>.<address>` from Settings, or types a code from Settings. Browsers never send a fragment, so aurral.org never sees the code. The client shows the address and asks before it calls anything, then trades the code for an ordinary session. Codes are random, single use, bound to the session that issued it, and expire after ten minutes. A paired session never counts as recently authenticated.
- **Cross-origin calls authenticate with a Bearer token.** CORS allows `AURRAL_APP_ORIGIN` on `/api` and nothing else beyond `CORS_ORIGIN`. A cross-site request never takes a no-auth path: not onboarding, not a server with sign-in off, not the local network bypass, not proxy-auth headers. Media and the websocket carry the session token in the URL, as the server's own UI already does.
- **Exact builds.** Each release and nightly is published under `/r/<version>/`, with characters outside `[A-Za-z0-9._-]` replaced by `-`, and its hashed assets in a shared `/assets/`. On every load the loader reads the active server's public bootstrap and fetches the build whose version matches exactly. A 404 means "this version isn't supported here". Source builds and forks report a commit hash, which is never published.
- **The site is rebuilt from a store.** Each publish uploads its build to R2 and redeploys `hosted/` from every stored build: releases first, then nightlies newest first, until the Workers file limit. Nightlies expire after 14 days. The root page runs the newest release.
- **One server per page load.** Switching servers reloads. localStorage keys that hold a server's data are prefixed with the server's address, so two servers' user 1 never share a queue or a cache.
- **Bytes never touch aurral.org.** Audio, artwork, and API responses go between the browser and the server.

## Later: Connect

Pairing works for any server that already has an HTTPS address. Connect, a paid add-on, would give every server a stable hostname through a managed tunnel, on a listener where no request counts as local and only pairing-issued tokens are accepted.

## Traps

- **The loader and the server list are a contract across builds.** The root page runs the latest build, and every retained build reads `aurral.servers`. Change its shape, or the `/r/` path rule, only in a way every retained build still reads.
- **Missing builds must 404.** The site's fallback serves the root page only to navigations. A fetch for a missing `/r/` path that returned the root page would load the wrong build.
- **Every build on the origin can read every saved token.** Retained builds are pruned, and raising the minimum supported version deletes every build below it.
- An HTTPS page can't call a plain HTTP address, so the hosted app can't reach a server by its LAN address. Native apps can.
- A forward-auth proxy's redirect or 401 carries no CORS headers, so the client can only say it couldn't reach the server.
- Flows that return to the server's own address (Last.fm, OIDC and Google linking, Spotify import, setting a password on an SSO account) hand off to the same page on the server instead of running in the hosted app.
- Supporting older servers is permanent work. Every field the hosted app reads is part of the [app API contract](../src/content/docs/api/app-contract.mdx).

## Alternatives

- **Proxy through aurral.org.** The project would carry users' music and pay for every request.
- **One hosted build for every server version.** Every client change would need to work against every supported server. Exact builds keep the client and server in step.
- **Short-lived media tickets.** Keeps tokens out of URLs, but adds a mint call before every stream and artwork batch, and the server's own UI already puts tokens in media URLs.
