<div align="center" width="100%">
  <img src="frontend/public/arralogo.svg" width="128" height="128" alt="Aurral Logo" />
</div>

# Aurral

[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Flklynet%2Faurral-blue?logo=docker&logoColor=white)](https://ghcr.io/lklynet/aurral) ![GitHub Release](https://img.shields.io/github/v/release/lklynet/aurral) ![GitHub License](https://img.shields.io/github/license/lklynet/aurral)
[![Build](https://img.shields.io/github/actions/workflow/status/lklynet/aurral/release.yml?branch=main)](https://github.com/lklynet/aurral/actions/workflows/release.yml) ![Discord](https://img.shields.io/discord/1457052417580339285?style=flat) [![Discussions](https://img.shields.io/github/discussions/lklynet/aurral)](https://github.com/lklynet/aurral/discussions) ![GitHub Sponsors](https://img.shields.io/github/sponsors/lklynet)

Self-hosted music discovery and request management for Lidarr with library-aware recommendations, granular monitoring controls, and optional Weekly Flow playlists powered by Soulseek + Navidrome.

---

## What is Aurral?

- Search for artists via MusicBrainz and add them to Lidarr with the monitoring behavior you want
- Browse your existing library in a clean UI
- Discover new artists using recommendations derived from your library and (optionally) Last.fm
- Track requests and download/import progress
- Generate weekly playlists and download the tracks into a separate “Weekly Flow” library

Aurral is designed to be safe for your collection: it does not write into your main music library directly. Library changes go through Lidarr’s API, and Weekly Flow writes into its own directory.

---

## Quick Start (Docker Compose)

Create a `docker-compose.yml`:

```yaml
services:
  aurral:
    image: ghcr.io/lklynet/aurral:latest
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      - DOWNLOAD_FOLDER=${DL_FOLDER:-./data/downloads}
    volumes:
      - ${DL_FOLDER:-./data/downloads}:/app/downloads
      - ${STORAGE:-./data}:/app/backend/data
```

You can optionally set `DL_FOLDER` and `STORAGE` in a `.env` file next to your compose file. If you leave them unset, Aurral uses `./data/downloads` and `./data`.

Start it:

```bash
docker compose up -d
```

Open: http://localhost:3001

---

## Requirements & Recommended Stack

### Required

- Lidarr (reachable from Aurral)
- Last.fm API key (api key required, username needed for scrobbling)
- A MusicBrainz contact email (used for the MusicBrainz User-Agent policy)

### Recommended stack for new users

- Lidarr Nightly
- Tubifarry
- slskd
- Navidrome

### For Weekly Flow

- Navidrome (optional but recommended if you want playlist/library integration)
- A downloads directory mounted into the container (for the Weekly Flow library)

---

## Features

### Discovery

- Daily Discover recommendations based on your library, tags, and trends

### Lidarr Management

- Add artists with granular monitor options (None / All / Future / Missing / Latest / First)
- Add specific albums from release groups
- Library view with quick navigation into artist details
- Request tracking with queue/history awareness

### Weekly Flow (Optional)

Weekly Flow generates playlists from your library and listening context, then downloads tracks via a built-in Soulseek client into a dedicated folder.

- Multiple flows with adjustable mix (Discover / Mix / Trending) and size
- Automatic weekly refresh scheduling
- Optional Navidrome smart playlists and a dedicated “Aurral Weekly Flow” library

---

## Screenshots

<p align="center">
  <img src="frontend/images/discover.webp" width="900" alt="Aurral UI" />
</p>

<p align="center">
  <img src="frontend/images/recommended.webp" width="440" alt="Recommendations" />
  <img src="frontend/images/artist.webp" width="440" alt="Artist details" />
</p>

---

## Data, Volumes, and Safety

### Downloads and Weekly Flow library

Mount a downloads folder for Weekly Flow and optional Navidrome integration:

- Container path: `/app/downloads`
- Weekly Flow output: `/app/downloads/aurral-weekly-flow/<flow-id>/<artist>/<album>/<track>`

### A note on your main library

Aurral does not write to your root music folder directly. Changes to your main collection happen via Lidarr (add/monitor/request/import).

---

## Weekly Flow + Navidrome Setup (Optional)

If you want Weekly Flow to appear as a separate library inside Navidrome:

1. In Aurral: Settings → Integrations → Navidrome (URL, username, password)
2. Ensure your compose config maps a host folder into `/app/downloads`
3. Set `DL_FOLDER` once and use it for both `DOWNLOAD_FOLDER` and the `/app/downloads` volume

Example:

- `DL_FOLDER=/data/downloads/tmp`
- Volume: `${DL_FOLDER}:/app/downloads`
- Env: `DOWNLOAD_FOLDER=${DL_FOLDER}`

Aurral will:

- Create a Navidrome library pointing to `<DOWNLOAD_FOLDER>/aurral-weekly-flow`
- Write smart playlist files (`.nsp`) into the Weekly Flow library folder

Navidrome should be configured to purge missing tracks so Weekly Flow rotations don’t leave stale entries:

- `ND_SCANNER_PURGEMISSING=always` (or `full`)

---

## Authentication & Reverse Proxy

### Local users (default)

Aurral uses local user accounts created in onboarding. Authentication is HTTP Basic Auth at the API layer. Use HTTPS when exposing it publicly.

### Reset forgotten admin password (terminal)

If you forget your admin password, you can reset it from the terminal:

```bash
npm run auth:reset-admin-password -- --password "new-password"
```

Or generate a random password:

```bash
npm run auth:reset-admin-password -- --generate
```

The `--` after `npm run auth:reset-admin-password` tells npm to pass the remaining flags to the reset script.

### Reverse-proxy auth (OAuth2/OIDC)

If you want SSO, place Aurral behind an auth-aware reverse proxy and forward the authenticated username in a header.

Environment variables:

```bash
AUTH_PROXY_ENABLED=true
AUTH_PROXY_HEADER=X-Forwarded-User
AUTH_PROXY_TRUSTED_IPS=10.0.0.1,10.0.0.2
AUTH_PROXY_ADMIN_USERS=alice,bob
AUTH_PROXY_ROLE_HEADER=X-Forwarded-Role
AUTH_PROXY_DEFAULT_ROLE=user
```

### Proxy headers (trust proxy)

If you are behind a reverse proxy, set `TRUST_PROXY` so Aurral interprets `X-Forwarded-*` correctly:

```bash
TRUST_PROXY=true
```

---

## Configuration Reference (Environment Variables)

Most configuration is done in the web UI, but some settings are controlled by environment variables.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `3001` |
| `TRUST_PROXY` | Express trust proxy setting (`true`/`false`/number) | `1` |
| `DOWNLOAD_FOLDER` | Weekly Flow root folder path used for Navidrome library creation | `${DL_FOLDER:-./data/downloads}` (in compose example) |
| `PUID` / `PGID` | Run container as this UID/GID (when starting as root) | `1001/1001` |
| `LIDARR_INSECURE` | Allow invalid TLS certificates (`true`/`1`) | unset |
| `LIDARR_TIMEOUT_MS` | Lidarr request timeout | `8000` |
| `SOULSEEK_USERNAME` / `SOULSEEK_PASSWORD` | Optional fixed Soulseek creds | autogenerated if missing |
| `AUTH_PROXY_*` | Reverse-proxy auth options (above) | unset |

---

## Notifications

Aurral can send notifications via **Gotify** and/or **Webhooks** (Settings → Notifications).

### Webhooks

Configure one or more webhook URLs. For each webhook:

- **No body** → `GET` request
- **With body** → `POST` with `Content-Type: application/json`
- **Headers** → Custom request headers can be added per webhook

Body supports two variables: `$flowPath` (music directory, empty for discovery updates) and `$flowName` (flow name). Example: `{"src": "$flowPath", "playlist": "$flowName"}`.

Event triggers (Discover updated, Weekly Flow done) apply to all configured webhooks at once and can be used to send notifications via different mediums or to automate library management (beets, Plex sync, etc.). Webhooks are invoked sequentially in the order in which they are defined.

---

## Troubleshooting

- Lidarr connection fails: confirm Lidarr URL is reachable and API key is correct (Settings → Integrations → Lidarr)
- Discovery looks empty: add some artists to Lidarr and/or configure Last.fm; initial discovery refresh can take a bit
- MusicBrainz is slow: MusicBrainz is rate-limited; Aurral respects it and may take longer on first runs
- Weekly Flow does not show in Navidrome: verify `DOWNLOAD_FOLDER` matches your host path mapping and Navidrome purge settings
- Permission errors writing `./data`: set `PUID`/`PGID` to match your host directory ownership

---

## Support

- Community + questions: https://discord.gg/cpPYfgVURJ
- Troubleshooting + help: https://github.com/lklynet/aurral/discussions
- Bugs + feature requests: https://github.com/lklynet/aurral/issues

---

## Star History

<a href="https://www.star-history.com/?repos=lklynet%2Faurral&type=timeline&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=lklynet/aurral&type=timeline&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=lklynet/aurral&type=timeline&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=lklynet/aurral&type=timeline&legend=top-left" />
 </picture>
</a>
