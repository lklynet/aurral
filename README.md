<div align="center" width="100%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/readme.svg" />
    <img src="docs/src/assets/readme-dark.svg" width="600" alt="Aurral" />
  </picture>
</div>

[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Flklynet%2Faurral-blue?logo=docker&logoColor=white)](https://ghcr.io/lklynet/aurral)
[![Downloads](https://img.shields.io/badge/dynamic/json?url=https://ghcr-badge.elias.eu.org/api/lklynet/aurral/aurral&query=downloadCount&label=downloads&logo=docker&color=2496ed)](https://github.com/lklynet/aurral/pkgs/container/aurral)
![GitHub Release](https://img.shields.io/github/v/release/lklynet/aurral)
![GitHub License](https://img.shields.io/github/license/lklynet/aurral)
[![Build](https://img.shields.io/github/actions/workflow/status/lklynet/aurral/ci.yml?label=build)](https://github.com/lklynet/aurral/actions/workflows/ci.yml)
![Discord](https://img.shields.io/discord/1457052417580339285?style=flat)
[![Sponsor](https://img.shields.io/github/sponsors/lklynet?label=Sponsor&logo=GitHub-Sponsors&logoColor=fe8a76)](https://github.com/sponsors/lklynet/)

Aurral is the Lidarr companion for self-hosted music discovery. Best-in-class recommendations, rotating flows, and playlist downloads, built on Lidarr instead of replacing it.

## Quick Links

- [Website](https://aurral.org)
- [Documentation](https://docs.aurral.org/)
- [Discord](https://discord.gg/cpPYfgVURJ)

## Features

- **Discover**: Best-in-class personalized recommendations, trends, tags, recent releases, discover playlists, and nearby shows.
- **Search**: Find artists and albums, preview tracks, and add to Lidarr with your defaults.
- **Library**: Browse and search artists already in Lidarr.
- **Playlists**: Run scheduled flows, adopt discover playlists like Release Radar, import spotify playlists, and convert flows to fixed tracklists.
- **Activity**: Queue, review, and history for Lidarr requests, yt-dlp / slskd / Usenet downloads, and Aurral playlist jobs.
- **Integrations**: Lidarr, Last.fm, ListenBrainz, Koito, yt-dlp, slskd, SABnzbd/NZBGet, Navidrome, Plex, Ticketmaster, Gotify, and webhooks.
- **Playback**: Stream through API-synced Navidrome or Plex/Plexamp playlists from a dedicated download folder.
- **Multi-user**: Per-user profiles, discovery layout, permissions, local auth, LAN auto-login, reverse-proxy SSO, and native OIDC.

## Screenshots

<p align="center">
  <img src="docs/src/assets/screenshots/discover.webp" width="900" alt="Aurral Discover page" />
</p>

<p align="center">
  <img src="docs/src/assets/screenshots/playback.webp" width="205" alt="Aurral artist details and playback" />
  <img src="docs/src/assets/screenshots/search.webp" width="205" alt="Aurral search results" />
  <img src="docs/src/assets/screenshots/playlists.webp" width="205" alt="Aurral playlists" />
</p>

## Quick Start

Create a `docker-compose.yml`:

```yaml
services:
  aurral:
    image: ghcr.io/lklynet/aurral:latest
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      - PUID=1000
      - PGID=1000
    volumes:
      - ${MEDIA_ROOT:-/srv/media}:/data
      - ./config:/config
```

Set `MEDIA_ROOT` to the **same host media path that Lidarr already mounts**. Keep `/data` as the container path and use that same mapping for your download clients and Navidrome or Plex. Then set Aurral's Downloads Folder to a container path such as `/data/downloads/aurral`. See [Filesystem and mounts](https://docs.aurral.org/getting-started/storage/).

```bash
docker compose up -d
```

Open `http://localhost:3001`, create your admin account, and connect Lidarr.

Want the latest merged changes? Use `ghcr.io/lklynet/aurral:nightly`. Nightly
builds may be less stable than releases; see the [Docker image channels](https://docs.aurral.org/getting-started/docker/#which-image-tag-to-use).

For a stack with Lidarr, slskd, and Navidrome, see [`docker-compose.example.yml`](docker-compose.example.yml). For Plex, see the [Plex setup guide](https://docs.aurral.org/integrations/plex/).

## Documentation

Full setup and usage guides live at [docs.aurral.org](https://docs.aurral.org/).

> [!NOTE]
> **AI disclosure** - Aurral is built with a hybrid approach to development. The foundation is hand-written code. For feature work, specifications are written by a developer, and any AI-generated code is thoroughly reviewed before being merged.

## Support

Aurral builds on open metadata, listening data, and infrastructure from the projects below.

| Project                                                            | Contribution                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| [BrainzMash](https://github.com/statichum/brainzmash-hearring-aid) | Hosted artist and album metadata for discovery and search  |
| [Honker](https://github.com/russellromney/honker)                  | Durable SQLite queues and background workers across Aurral |
| [MusicBrainz](https://musicbrainz.org)                             | Canonical release metadata and artist identifiers          |

- Community: [Discord](https://discord.gg/cpPYfgVURJ)
- Bugs and feature requests: [GitHub Issues](https://github.com/lklynet/aurral/issues)

## Sponsors

![sponsors badge](https://readme-contribs.as93.net/sponsors/lklynet)
