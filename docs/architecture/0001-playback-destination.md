# Playback destination seam

- Status: Accepted
- Date: 2026-08-10
- Issue: [#534](https://github.com/lklynet/aurral/issues/534)

## Context

`WeeklyFlowPlaylistManager` currently controls playlist files, Navidrome, and Plex. Navidrome reads track paths from M3U files. Plex resolves track paths to Plex track IDs and stores Plex playlist pointers. Both destinations publish the same Aurral playlists, but their configuration and identity rules are different.

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

The Navidrome adapter can write snapshot paths to M3U files after it applies Navidrome path mappings. It can keep Navidrome file naming and playlist deletion rules inside the adapter.

The Plex adapter can resolve snapshot paths to Plex rating keys. It can keep section IDs, user tokens, playlist pointers, and owner-specific titles inside the adapter.

This decision does not change current Navidrome or Plex behavior. Later roadmap issues will move each existing flow behind this seam.

## Deliberate non-goals

- Do not add a generic integration host.
- Do not add plugin loading or uploaded code.
- Do not migrate Navidrome from M3U files to the Subsonic API.
- Do not make Settings forms part of this contract.
- Do not move current destination behavior in this issue.
