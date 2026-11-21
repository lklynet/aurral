# Metadata pipeline (`data.aurral.org`)

Status: Accepted

## Problem

Aurral depended on a hosted BrainzMash relay for every artist page, album page, and search, plus per-album hydration loops, ListenBrainz popularity calls, and Deezer lookups to assemble one artist view. A busy relay slowed down every install, and per-page fan-out multiplied load on shared infrastructure.

## Decision

Aurral serves static v1 JSON files built from MusicBrainz and ListenBrainz at `https://data.aurral.org/v1`, cached at Cloudflare's edge and locally in each install's SQLite database:

- `v1/artist/<mbid>`: artist profile, hydrated albums (with release dates, covers, track counts, ratings, and listener counts), appears-on list (up to 100), top tracks (up to 20), and similar artists (up to 30, scored from ListenBrainz listening data).
- `v1/album/<mbid>`: release group details, releases, tracks, and non-trivial per-track credits.
- `v1/genre/<slug>` and `v1/genres`: top artists per genre (up to 200) and the genre index.
- `v1/search`, `v1/search/artist`, `v1/search/album`, and `v1/search/track`: served by a Cloudflare Worker over D1 FTS5 indexes built from the same MusicBrainz + ListenBrainz dataset, ranked by exact/prefix match and listener counts, cached at Cloudflare's edge for an hour.

When an artist or album MBID is not yet in the daily build (`404`), Aurral falls back directly to MusicBrainz (`musicbrainzHttp.ts`) and caches the fallback for an hour so the install picks up the static file after the next daily publish. Aurral does not fall back to BrainzMash. Deezer stays an optional fallback for previews, playlists, and missing artwork, top tracks, or related artists when an artist file lacks them.

## Request rules

- Routine entity reads hit static files on R2 and never run a Worker.
- Installs cache entity responses in SQLite, coalesce in-flight requests, and fetch only what the user is looking at.
- Background work fetches for what changed, never in proportion to Library size.
- The perf baseline (`.tests/perf/baseline.json`) counts outbound calls per scenario. Warm page loads make zero metadata calls.
- The base URL stays configurable (`METADATA_BASE_URL` or Settings → Metadata) so forks and self-hosters can serve their own files.
