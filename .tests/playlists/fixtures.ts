import assert from "node:assert/strict";
import type { PlaylistTrack } from "../../backend/services/playlists/flowPlaylistConfig.ts";

export function requireFixture<T>(value: T) {
  assert.ok(value != null, "Expected fixture to exist");
  return value;
}

export function playlistTrack(
  track: Pick<PlaylistTrack, "artistName" | "trackName"> & Partial<PlaylistTrack>,
): PlaylistTrack {
  return {
    albumName: null,
    artistMbid: null,
    albumMbid: null,
    trackMbid: null,
    releaseYear: null,
    durationMs: null,
    artistAliases: [],
    reason: null,
    ...track,
  };
}
