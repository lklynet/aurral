# Hosted Aurral

Status: Proposed

## Problem

People want to reach their server from a browser or a desktop app away from home without opening ports, running a reverse proxy, or installing Tailscale. Some run more than one server, or use a friend's, and want them in one app. Today every server serves its own copy of the app at its own address, and a browser tab knows only that one.

## Decision

The Aurral web app also runs at `music.aurral.org` and in desktop apps as a client that calls servers' APIs directly. aurral.org helps a client find a server and never carries its traffic.

- **The hosted app is only a client.** It is the normal frontend build on Cloudflare Pages. It keeps its list of servers in browser storage and sets the API base per server at runtime, never through `VITE_API_URL` at build time. It holds no state on aurral.org.
- **The server owns sign-in.** A signed-in user creates a pairing link or QR code in Settings: `https://music.aurral.org/pair#...`. The fragment carries the instance ID, a code, and the address the link came from, and browsers never send a fragment, so aurral.org never sees the code. The client trades the code with the server for an ordinary session for that user, with that user's permissions. Codes are random, single use, and expire after ten minutes. Settings lists each paired device and can sign it out.
- **Cross-origin calls authenticate with a header.** The server accepts cross-origin API calls that carry a session token in a header and never authenticates them with cookies. Media and WebSocket requests can't send that header, so they use short-lived tickets in the URL.
- **Server identity.** `GET /api/health/bootstrap` reports the instance ID alongside the API version and features. A client checks the instance ID before sending a token, so an address that now belongs to another machine never receives one.
- **Several servers.** Each server keeps its own session, queue, and Library. The client switches between them. It never merges them.
- **Older servers.** Servers update on their owners' schedule and the hosted app on every deploy. The hosted app hides features a server doesn't list and refuses servers older than a minimum version. An endpoint the hosted app uses is removed only after the minimum version has passed it.
- **Desktop apps.** An Electron shell around the same client, in two modes: a client for existing servers, and one that also runs its own server. The second is a normal Aurral server with its data dir in the user's app data.
- **Bytes never touch aurral.org.** Audio, artwork, and API responses go between the client and the server.

## Later: Connect

Pairing works for any server that already has an HTTPS address. Connect, a paid add-on, removes the setup for the rest:

- **Remote access without setup.** Each server gets a stable hostname on a separate domain, so a user's server can't set cookies on aurral.org. The transport is a Cloudflare named tunnel or a relay that routes by hostname without decrypting.
- **A listener of its own.** Connect traffic arrives on a listener separate from the main app. `cloudflared` and a relay client connect from 127.0.0.1, so on this listener no request counts as local: loopback trust, the local network bypass, and proxy auth headers are off, and only pairing-issued tokens are accepted.
- **Push.** iOS notifications come from the project, which holds Apple's push key.

## Traps

- An HTTPS page can't call a plain HTTP address, so the hosted app can't reach a server by its LAN address. The desktop and iOS apps can.
- Allowing any origin is safe only because these calls authenticate with a header. If a cross-origin request could authenticate with a cookie, any site could act as the user.
- Supporting older servers is permanent work. Every field the hosted app reads is part of the [app API contract](../src/content/docs/api/app-contract.mdx).

## Alternatives

- **Proxy through aurral.org.** The project would carry users' music and pay for every request.
- **The server's own UI at a tunnel address.** Avoids supporting older servers, but a quick tunnel address changes on every restart, which signs browsers out, and one tab still sees one server.
- **Quick tunnels for remote access.** No cost to the project, but no uptime guarantee, a cap on requests in flight, and Cloudflare calls them a testing tool.
