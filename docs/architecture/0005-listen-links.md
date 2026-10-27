# Listen links

Status: Accepted

## Problem

People want to let friends hear music from their Library, but most Aurral servers are only on a home network. A listen link must play and optionally download the original files without exposing the server's address, without opening anything else on the server, and without a paid service. Aurral is free software with no revenue, so the project's Cloudflare account must stay on free plans.

## Decision

Use Cloudflare quick tunnels, started by Aurral, with a lookup on aurral.org.

- **Share-only listener.** Aurral starts a second HTTP server on `127.0.0.1` with a random port while at least one listen link is live. It knows only `/share/...` routes and never runs the app's auth middleware. `cloudflared` connects from the same machine, so pointing it at the main app would make every visitor look local and could skip sign-in.
- **Tunnel lifetime.** The listener and one `cloudflared tunnel --url` process run while any link is live. They stop when the last link expires or is stopped and restart with Aurral. `cloudflared` binds metrics to loopback. The Docker image bundles `cloudflared`, pinned by digest.
- **Lookup.** New hosted links use `aurral.org/s/<code>`. The 16-character code is `s` followed by the first 15 characters of the random share token. A unique expression index resolves it to the full token and instance without another mapping table. The prefix keeps codes separate from encoded legacy links. Older instance/token URLs and links with an encoded item before `~` still resolve. Aurral sends its current address to `PUT /api/instances/<instanceId>` on aurral.org. aurral.org accepts only `https://*.trycloudflare.com` addresses and checks that `<tunnel>/share/.well-known/aurral` returns the same instance ID. The first secret to claim an ID owns it, and aurral.org stores only its SHA-256 hash.
- **D1, not KV.** The lookup lives in D1 because the free plan allows 100,000 row writes a day, against 1,000 KV writes. Each tunnel start is one write.
- **Bytes never touch aurral.org.** The share page reads the track list from the tunnel and points `<audio>` and download links at the tunnel, so audio and downloads travel from the user's server to the listener through Cloudflare's tunnel network.
- **Original files.** Playback and downloads serve the Library's canonical file with HTTP ranges. Formats browsers cannot play, such as ALAC, are transcoded to MP3 as they stream. Download all streams a stored (uncompressed) ZIP, with ZIP64 for large artists, built as it goes with a known length.
- **Metadata survives file access.** New shares keep a bounded metadata snapshot in D1, authenticated with the instance secret. This lets a playlist's complete order survive an offline sender without putting a playlist in a URL. File expiry and stopping a track, album, or artist share leave that snapshot intact, since it holds only public metadata. Those shares then leave the sender's list, and details-only ones are never stored locally. Stopping a playlist removes its snapshot but reserves its code so another instance cannot take over a stopped link. Names-only shares never start the listener or tunnel.
- **Scope.** New links restrict playback and downloads to the files named in their snapshot. Legacy links still resolve their reference on each request, so older artist links include albums added later. Files from flows are never shared. File access ends when it expires, is stopped, or its owner is disabled.
- **Playlist snapshots refresh daily, file scope never grows.** A daily task republishes each hosted playlist share only when its tracks change, so updates need no tunnel and unchanged playlists cost no D1 writes. A refresh keeps file paths only for tracks the previous snapshot already exposed, so later additions are details only. Deleting the playlist stops the share.
- **Only synced playlist imports acquire.** A synced playlist import is an `aurral-share` import source and downloads missing tracks with the recipient's own sources, like a Spotify import. Details-only imports leave monitoring off and keep missing playlist entries as saved jobs. Shared-file transfers use the existing pipeline with a persisted share reference and explicit source selection. They bypass optional search integrations and cannot fall through to them on failure or retry. The recipient resolves the share again before each transfer so stopping sharing or removing download permission applies to queued work.

## Alternatives

A relay on aurral.org (an outbound WebSocket from Aurral to a Durable Object) gives stable links without a binary or lookup, but every byte runs on the project's account. On the free plan the daily duration allowance covers roughly a day of transfer across all users, and original-file downloads would exhaust it and stop sharing for everyone. Keep tunnel code in `backend/services/shareLinks/tunnel.ts` so a relay or a user's own named tunnel can replace it later without changing tokens, routes, or the share page.

## Risks

Cloudflare describes quick tunnels as being for testing and development, with no uptime guarantee and a limit of 200 concurrent requests per tunnel. If Cloudflare throttles or blocks them at scale, sharing stops until the tunnel service is replaced.

## Setup

The aurral.org Pages project needs a D1 database bound as `SHARE_DB` for production and preview. The share page and lookup create their table on first use. Without the binding, listen links show the regular share page with "This isn't available to listen to right now."

`AURRAL_SHARE_ORIGIN` points a development server at another share site, such as a Pages preview deployment.
