# Playback destination seam

- Status: Accepted
- Date: 2026-08-10
- Issue: [#534](https://github.com/lklynet/aurral/issues/534)

## Context

`WeeklyFlowPlaylistManager` creates path-first playlist snapshots. A settings-driven registry sends each snapshot to every configured playback destination. Navidrome and Plex resolve snapshot tracks to their own song IDs and store playlist pointers. Both destinations publish the same Aurral playlists, but their configuration and identity rules are different.

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

The Navidrome adapter resolves snapshot paths and metadata to Subsonic song IDs. It stores a Navidrome playlist ID for each Aurral entity and owner. If Navidrome has not indexed a track, a post-scan catch-up retries the API playlist. The adapter adopts and removes legacy M3U playlists during migration. It owns Navidrome naming, migration cleanup, library setup, and scans.

The Plex adapter resolves snapshot paths to Plex rating keys. It keeps section IDs, user tokens, playlist pointers, owner-specific titles, library setup, and scans inside the adapter.

The registry and playback contract remain unchanged. Navidrome's Subsonic API behavior stays inside its adapter, and Plex retains its existing behavior. The registry checks saved settings, runs every configured destination, and records one destination failure without blocking another destination.

## Deliberate non-goals

- Do not add a generic integration host.
- Do not add plugin loading or uploaded code.
- Do not make Settings forms part of this contract.
- Do not move vendor behavior out of destination adapters.
