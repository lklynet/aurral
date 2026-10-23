import type { LibraryAlbum, LibraryTrack } from "../../frontend/src/utils/libraryPageData.ts";

export const libraryAlbum = (overrides: Partial<LibraryAlbum> = {}): LibraryAlbum => ({
  id: 1,
  identityKey: "album-1",
  mbid: null,
  releaseGroupMbid: null,
  artistId: 1,
  title: "Album",
  albumArtist: null,
  releaseDate: null,
  createdAt: 0,
  metadata: null,
  trackIds: [],
  sources: [],
  available: false,
  ...overrides,
});

export const libraryTrack = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 1,
  identityKey: "track-1",
  title: "Track",
  artistName: null,
  albums: [],
  files: [],
  ...overrides,
});

export const libraryFile = (
  overrides: Partial<LibraryTrack["files"][number]> = {},
): LibraryTrack["files"][number] => ({
  available: true,
  format: null,
  durationMs: null,
  ...overrides,
});
