# Playback destination seam

- Status: Accepted
- Date: 2026-08-10
- Issue: [#534](https://github.com/lklynet/aurral/issues/534)

## Context

`WeeklyFlowPlaylistManager` creates path-first playlist snapshots. A settings-driven registry sends each snapshot to every configured playback destination. Navidrome, Jellyfin, and Plex resolve snapshot tracks to their own song IDs and store playlist pointers. Each destination publishes the same Aurral playlists, but their configuration and identity rules are different.

## Decision

`backend/services/playback/playbackDestination.js` is the seam between playlist orchestration and playback destinations. A destination is an object with these methods:

- `testConnection()`
- `ensureLibrary()`
- `publishPlaylist(snapshot)`
- `deletePlaylist(identity)`
- `requestScan()`

Each method returns a promise for one operation result. Success is `{ ok: true }`. Failure is `{ ok: false, error: { code, message, retryable } }`. A destination must not return credentials, vendor IDs, stored pointers, or Settings form values.

The playlist identity is `entityId + ownerUserId`. `ownerUserId` is `null` for a global playlist. The display name is not part of the identity. A rename must publish the same identity with a new display name.

A playlist snapshot contains:

- `entityId`
- `ownerUserId`
- `displayName`
- An optional `description`
- An ordered `tracks` array

Each track contains its exact Aurral-readable local `path`, `title`, and `artist`. Path validation does not trim valid filename whitespace. A track can also contain `album`, `durationMs`, and a recording `mbid`. The snapshot is immutable. Each adapter converts local paths to its destination paths or track IDs.

Destination adapters own their names, authentication, configuration, vendor IDs, stored pointers, owner policy, and detailed connection state. Callers only use the contract values above.

## Compatibility

The Navidrome adapter resolves snapshot paths or exact recording MBIDs to Subsonic song IDs. It never substitutes a metadata search result for an unindexed file. It stores a Navidrome playlist ID for each Aurral entity and owner. If Navidrome has not indexed a track, a post-scan catch-up retries the API playlist. The adapter adopts and removes legacy M3U playlists during migration. It owns Navidrome naming, migration cleanup, library setup, and scans.

The Plex adapter resolves snapshot paths to Plex rating keys. It keeps section IDs, user tokens, playlist pointers, owner-specific titles, library setup, and scans inside the adapter.

The Jellyfin adapter resolves exact library paths first and unique MusicBrainz recording IDs second. It keeps the Jellyfin user ID, playlist pointers, API requests, library reads, and scans inside the adapter.

The registry and playback contract remain unchanged. Navidrome's Subsonic API behavior stays inside its adapter, Jellyfin's REST API behavior stays inside its adapter, and Plex retains its existing behavior. The registry checks saved settings, runs every configured destination, and records one destination failure without blocking another destination.

## Native Aurral playback

The built-in player reads canonical artists, albums, and tracks, then requests an authenticated Aurral stream for each canonical track. This path does not depend on Navidrome. Weekly Flow items keep their existing owner-scoped playlist stream, so a flow item remains playable without changing its ownership rules.

The native playback health section reports whether canonical media is indexed and readable. A stale or missing file returns a clear stream failure and leaves the user with a library refresh path instead of silently falling back to a playback destination.

## Deliberate non-goals

- Do not add a generic integration host.
- Do not add plugin loading or uploaded code.
- Do not make Settings forms part of this contract.
- Do not move vendor behavior out of destination adapters.
