<div align="center" width="100%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/readme.svg" />
    <img src="docs/src/assets/readme-dark.svg" width="600" alt="Aurral" />
  </picture>
</div>

<p align="center">
  <a href="https://github.com/lklynet/aurral/releases"><img src="https://img.shields.io/github/v/release/lklynet/aurral" alt="Release" /></a>
  <a href="https://github.com/lklynet/aurral/pkgs/container/aurral"><img src="https://img.shields.io/badge/dynamic/json?url=https://ghcr-badge.elias.eu.org/api/lklynet/aurral/aurral&query=downloadCount&label=downloads&logo=docker&color=2496ed" alt="Downloads" /></a>
  <a href="https://discord.gg/cpPYfgVURJ"><img src="https://img.shields.io/discord/1457052417580339285?style=flat" alt="Discord" /></a>
  <a href="https://github.com/sponsors/lklynet/"><img src="https://img.shields.io/github/sponsors/lklynet?label=Sponsor&logo=GitHub-Sponsors&logoColor=fe8a76" alt="Sponsor" /></a>
</p>

<p align="center">Find new music, get it, and play it, all on your own server.</p>

<p align="center">
  <a href="https://aurral.org">Website</a> ·
  <a href="https://docs.aurral.org/">Docs</a> ·
  <a href="https://discord.gg/cpPYfgVURJ">Discord</a> ·
  <a href="https://github.com/sponsors/lklynet/">Sponsor</a>
</p>

<p align="center">
  <img src="web/screenshots/discover.webp" width="900" alt="Aurral Discover page" />
</p>

- **Discover** artists you'll love, with the reason for every pick. Start from your Spotify history.
- **Flows** turn your taste into scheduled playlists that download themselves.
- **Import** playlists from Spotify, YouTube Music, Last.fm, and ListenBrainz.
- **Library** that Aurral manages for you. Lidarr is optional.
- **Listen** in the browser, any Subsonic client, or Navidrome, Plex, and Jellyfin through the Library folder.
- **Share** anything as a link, and let friends play it from your Library.

Downloads through yt-dlp, slskd, Usenet, Tidarr, and deemix. Everything is optional. [Read the docs](https://docs.aurral.org/) for the full tour.

## Quick start

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
      - ./config:/config
      - ./data:/data
```

Run `docker compose up -d`, open `http://localhost:3001`, and create your admin account. Want the latest changes early? Use the [`nightly`](https://docs.aurral.org/getting-started/docker/#choose-an-image-tag) tag.

## Thanks

Built on [BrainzMash](https://github.com/statichum/brainzmash-hearring-aid), [Honker](https://github.com/russellromney/honker), and [MusicBrainz](https://musicbrainz.org). Chat on [Discord](https://discord.gg/cpPYfgVURJ), report bugs in [Issues](https://github.com/lklynet/aurral/issues).

## Sponsors

<p align="center">Aurral is free and open source. <a href="https://github.com/sponsors/lklynet/">Sponsors</a> keep it that way.</p>

<p align="center">
  <a href="https://github.com/bmikaili"><img src="https://github.com/bmikaili.png?size=120" width="60" alt="@bmikaili" /></a>
  <a href="https://github.com/booxter"><img src="https://github.com/booxter.png?size=120" width="60" alt="@booxter" /></a>
  <a href="https://github.com/Barosky"><img src="https://github.com/Barosky.png?size=120" width="60" alt="@Barosky" /></a>
  <a href="https://github.com/robertdistefano"><img src="https://github.com/robertdistefano.png?size=120" width="60" alt="@robertdistefano" /></a>
  <a href="https://github.com/pcsokonay"><img src="https://github.com/pcsokonay.png?size=120" width="60" alt="@pcsokonay" /></a>
  <a href="https://github.com/okcodemaybe"><img src="https://github.com/okcodemaybe.png?size=120" width="60" alt="@okcodemaybe" /></a>
  <a href="https://github.com/jakobbjelver"><img src="https://github.com/jakobbjelver.png?size=120" width="60" alt="@jakobbjelver" /></a>
  <a href="https://github.com/zachyzissou"><img src="https://github.com/zachyzissou.png?size=120" width="60" alt="@zachyzissou" /></a>
  <a href="https://github.com/erleijen"><img src="https://github.com/erleijen.png?size=120" width="60" alt="@erleijen" /></a>
  <a href="https://github.com/bahraoui"><img src="https://github.com/bahraoui.png?size=120" width="60" alt="@bahraoui" /></a>
</p>

<p align="center">
  <a href="https://macroscope.com/open-source">
    <img src="docs/src/assets/macroscope-open-source-sponsor.webp" width="500" alt="Sponsored by Macroscope" />
  </a>
</p>
