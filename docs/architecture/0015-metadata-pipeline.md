# Metadata pipeline (AurralBrainz / `data.aurral.org`)

Status: Accepted

## Problem

Aurral depended on a hosted BrainzMash relay for every artist page, album page, and search, plus per-album hydration loops, ListenBrainz popularity calls, and Deezer lookups to assemble one artist view. A busy relay slowed down every install, and per-page fan-out multiplied load on shared infrastructure.

## Decision

**AurralBrainz** serves static v1 JSON files built daily from open MetaBrainz data (MusicBrainz, ListenBrainz, and Cover Art Archive, enriched with Wikimedia Commons, Fanart.tv, and TheAudioDB artwork) at `https://data.aurral.org/v1`, cached at Cloudflare's edge and locally in each install's SQLite database:

- `v1/artist/<mbid>`: artist profile, hydrated albums (with release dates, covers, track counts, ratings, and listener counts), appears-on list (up to 100), top tracks (up to 20), and similar artists (up to 30, scored from ListenBrainz listening data, each with its genres).
- `v1/album/<mbid>`: release group details, releases, tracks, non-trivial per-track credits, and a popular flag on up to three of its most-listened tracks.
- `v1/genre/<slug>` and `v1/genres`: top artists per genre (up to 200) and the genre index.
- `v1/search`, `v1/search/artist`, `v1/search/album`, and `v1/search/track`: served by a Cloudflare Worker over D1 FTS5 indexes built from the same MusicBrainz + ListenBrainz dataset, ranked by exact/prefix match and listener counts, cached at Cloudflare's edge for an hour. Album and track search take an `artist` filter.

When an artist or album MBID is not yet in the daily build (`404`), Aurral falls back directly to MusicBrainz (`musicbrainzHttp.ts`) and caches the fallback for an hour so the install picks up the static file after the next daily publish. Aurral does not fall back to BrainzMash. Artist artwork resolves strictly from AurralBrainz (`artist.images`) and Cover Art Archive (`albums[].cover`), without runtime Deezer artist-photo lookups. Deezer stays an optional fallback for lazy track previews, playlists, and missing top tracks or related artists when an artist file lacks them.

## Request rules

- Routine entity reads hit static files on R2 and never run a Worker.
- `data.aurral.org` requires the `Aurral/<version>` User-Agent and enforces per-IP rate limits at the Cloudflare edge.
- Installs cache entity responses in SQLite, coalesce in-flight requests, and fetch only what the user is looking at.
- Background work fetches for what changed, never in proportion to Library size.
- Search is the only path with a hard limit: the Worker allows each IP 60 uncached searches a minute. A search sent while serving a request goes straight out and fails at once on a `429`. Every other search, such as one from a scan, an import, or a download, takes a turn every two seconds across all processes and waits out `Retry-After`. That leaves half the limit for people typing.
- A search answer holds the top 50. Aurral asks for all 50 once and pages locally, so each query is one Worker request and one edge cache key.
- With an artist MBID in hand, an album is matched against that artist's file before any search. The file is static, cached for a week, and answers for every album by that artist.
- A file is fresh for a week and usable for 30 more days while it refreshes. A refresh no request is waiting on goes out one per second, so a job that reads every monitored artist does not send a burst.
- Monitoring learns about new releases from ListenBrainz's fresh-release feed and refreshes only the artists whose cached file lacks a release the feed names. The weekly refresh stays as the backstop, because the feed is keyed by release date and misses older releases added to MusicBrainz later.
- Recommendations read a candidate's genres from the similar list that named it. A list from before genres shipped has none, and the candidate's own file answers instead.
- The perf baseline (`.tests/perf/baseline.json`) counts outbound calls per scenario. Warm page loads make zero metadata calls.
- The base URL stays configurable (`METADATA_BASE_URL` or Settings → Metadata) so forks and self-hosters can serve their own files.
