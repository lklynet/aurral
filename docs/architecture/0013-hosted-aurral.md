# Hosted Aurral

Status: Proposed

## Problem

People want to reach their server from a browser or a desktop app away from home without opening ports, running a reverse proxy, or installing Tailscale. Some run more than one server, or use a friend's, and want them in one app. Today every server serves its own copy of the app at its own address, and a browser tab knows only that one.

## Decision

The Aurral web app also runs at `music.aurral.org` and in desktop apps as a client that calls servers' APIs directly. aurral.org helps a client find a server and never carries its traffic.

- **The hosted app is only a client.** It is the normal frontend build on Cloudflare Pages. It keeps its list of servers in browser storage and sets the API base per server at runtime, never through `VITE_API_URL` at build time. It holds no state on aurral.org.
- **The server owns sign-in.** A signed-in user creates a pairing link or QR code in Settings: `https://music.aurral.org/pair#<instanceId>.<code>.<address>`. Browsers never send a fragment, so aurral.org never sees the code. The client trades the code with the server for an ordinary session for that user, with that user's permissions. Codes are random, single use, and expire after ten minutes. Settings lists each signed-in device and can sign it out.
- **Cross-origin calls authenticate with a Bearer token.** The server allows any origin without credentials mode, and a cross-origin request never authenticates by IP address, cookie, or proxy-auth header. HTML5 audio and native WebSockets can't send the header, so media and sockets use short-lived, single-purpose tickets minted with the token.
- **Server identity.** `GET /api/health/bootstrap` reports the instance ID, which is the share instance ID, registered with aurral.org before it is exposed. A client checks it before sending a token, so an address that now belongs to another machine never receives one. The ID is public, so it guards against picking the wrong server by accident, not against an attacker.
- **Several servers.** The client keeps a list of servers, each with its instance ID, name, routes, and session, and one is active. Each server gets its own WebSocket, auth storage, query cache, media URLs, and service worker caches. A session belongs to the routes the user paired or added: a new address needs pairing again, and an authenticated request never follows a redirect to another origin. Only the hosted and desktop builds have the switcher. A server's own UI keeps `connect-src 'self'`.
- **Versions both ways.** A server below the client's minimum version says to update the server. A server with a newer API version than the client knows says to update the app. An endpoint the hosted app uses is removed only after the minimum version has passed it.
- **Desktop apps.** An Electron shell that loads the bundled client, in two modes. The client adds plain HTTP LAN addresses, media keys, and `aurral://pair` links. The other mode also runs a normal Aurral server on bundled Node, not Electron's.
- **Bytes never touch aurral.org.** Audio, artwork, and API responses go between the client and the server.

## Later: Connect

Pairing works for any server that already has an HTTPS address. Connect, a paid add-on, removes the setup for the rest:

- **Remote access without setup.** Each server gets a stable hostname on a separate domain, so a user's server can't set cookies on aurral.org. The transport is a Cloudflare named tunnel or a relay that routes by hostname without decrypting.
- **A listener of its own.** Connect traffic arrives on a listener separate from the main app. `cloudflared` and a relay client connect from 127.0.0.1, so on this listener no request counts as local: loopback trust, the local network bypass, and proxy auth headers are off, and only pairing-issued tokens are accepted.
- **Push.** iOS notifications come from the project, which holds Apple's push key.
- **Signing in to a server with an Aurral account.** Doing this safely needs the one-time challenge and local link check that the tunnel gives, so pairing covers it until then.

## Traps

- An HTTPS page can't call a plain HTTP address, so the hosted app can't reach a server by its LAN address. The desktop and iOS apps can.
- Allowing any origin is safe only because these calls authenticate with a header. If a cross-origin request could authenticate with a cookie, an address, or a proxy header, any site could act as the user.
- Media needs CORS too. `Cross-Origin-Resource-Policy: same-origin` blocks streams and artwork from other origins, and streams skip the middleware through `sendViaNode`, so they set their own headers. Canvas and Web Audio reads of artwork and streams need real CORS headers, not just a permissive policy.
- A forward-auth proxy has to let cross-origin `/api` and media requests through, as it already does for `/rest`.
- Supporting older servers is permanent work. Every field the hosted app reads is part of the [app API contract](../src/content/docs/api/app-contract.mdx).

## Alternatives

- **Proxy through aurral.org.** The project would carry users' music and pay for every request.
- **The server's own UI at a tunnel address.** Avoids supporting older servers, but a quick tunnel address changes on every restart, which signs browsers out, and one tab still sees one server.
- **Quick tunnels for remote access.** No cost to the project, but no uptime guarantee, a cap on requests in flight, and Cloudflare calls them a testing tool.
