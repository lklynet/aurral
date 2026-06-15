

# Aurral

[Docker](https://ghcr.io/lklynet/aurral)
[Downloads](https://github.com/lklynet/aurral/pkgs/container/aurral)
GitHub Release
GitHub License
[Build](https://github.com/lklynet/aurral/actions/workflows/release.yml)
Discord
[Sponsor](https://github.com/sponsors/lklynet/)

Aurral is a self-hosted music discovery app for the Lidarr stack. Find new artists, request albums, run scheduled flows, import playlists, and follow everything from recommendation to playback without writing generated files into your main library.

## Quick Links

- [Website](https://aurral.org)
- [Documentation](https://docs.aurral.org/)
- [Discord](https://discord.gg/cpPYfgVURJ)

## Features

- **Discover** — Personalized recommendations, trends, tags, recent releases, discover playlists, and nearby shows.
- **Search** — Find artists and albums, preview tracks, and add to Lidarr with your defaults.
- **Library** — Browse and search artists already in Lidarr.
- **Playlists** — Run scheduled flows, adopt discover playlists like Release Radar, import static playlists, and convert flows to fixed tracklists.
- **History** — One timeline for Lidarr requests, slskd downloads, and Aurral playlist activity.
- **Integrations** — Lidarr, Last.fm, ListenBrainz, slskd, Navidrome, Plex, Ticketmaster, Gotify, and webhooks.
- **Playback** — Stream through Navidrome (M3U playlists) or Plex/Plexamp (API-synced playlists) from a dedicated download folder.
- **Multi-user** — Per-user profiles, discovery layout, permissions, local auth, LAN auto-login, and reverse-proxy SSO.

## Screenshots





## Recommended Stack

Aurral only needs Lidarr to get started. It works best with the stack self-hosters already trust:


| App or service                             | Role                                                        |
| ------------------------------------------ | ----------------------------------------------------------- |
| [Lidarr](https://github.com/Lidarr/Lidarr) | Library management, artist and album requests, queue status |
| [slskd](https://github.com/slskd/slskd)    | Soulseek-backed downloads for flows and playlists           |
| [Navidrome](https://www.navidrome.org)     | Streaming and playback via generated M3U playlists          |
| [Plex](https://www.plex.tv)                | Flow playlists in Plexamp (optional)                      |


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
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
    volumes:
      - ${MEDIA_ROOT:-/data}:/data
      - ${CONFIG:-./config}:/config
```

Change `${MEDIA_ROOT:-/srv/media}` to the host path you use for media. For file reuse, slskd downloads, and generated playlists, mount the **same root directory** into Aurral, Lidarr, slskd, and your player (Navidrome or Plex) at the same container path (for example `/srv/media:/data`). See [shared storage](https://docs.aurral.org/getting-started/storage/).

```bash
docker compose up -d
```

Open `http://localhost:3001` and complete onboarding.

For a full stack with Lidarr, slskd, and Navidrome or Plex, see [`docker-compose.example.yml`](docker-compose.example.yml). Plex setup: [docs](https://docs.aurral.org/integrations/plex/).

## macOS app

A native thin client for Apple Silicon Macs is available on [GitHub Releases](https://github.com/lklynet/aurral/releases). It connects to your self-hosted server. It does not replace Docker or another backend.

macOS may block the first launch because the app is not notarized yet. Control-click **Aurral → Open** in Applications, or run:

```bash
xattr -dr com.apple.quarantine /Applications/Aurral.app
```

See [macOS app](https://docs.aurral.org/getting-started/macos-app/) in the docs for install steps and details.

## Documentation

Full setup and usage guides live at [docs.aurral.org](https://docs.aurral.org/).

## Support

Aurral builds on open metadata, listening data, and infrastructure from the projects below.


| Project                                                            | Contribution                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| [BrainzMash](https://github.com/statichum/brainzmash-hearring-aid) | Hosted artist and album metadata for discovery and search  |
| [Honker](https://github.com/russellromney/honker)                  | Durable SQLite queues and background workers across Aurral |
| [Last.fm](https://www.last.fm)                                     | Listening history, tags, and personalized recommendations  |
| [MusicBrainz](https://musicbrainz.org)                             | Canonical release metadata and artist identifiers          |


- Community: [Discord](https://discord.gg/cpPYfgVURJ)
- Bugs and feature requests: [GitHub Issues](https://github.com/lklynet/aurral/issues)

## Sponsors

sponsors badge

## License

Aurral is released under the [MIT License](LICENSE).