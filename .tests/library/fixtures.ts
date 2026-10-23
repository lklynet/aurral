import type { buildLibraryReadModel } from "../../backend/services/libraryReadModel.ts";
import type { LibraryAlbum, LibraryTrackFile } from "../../backend/services/libraryQueryService.ts";

type ReadInput = Parameters<typeof buildLibraryReadModel>[0];

export const readArtist = (overrides: Partial<ReadInput["artists"][number]> = {}) => ({
  id: 1,
  identityKey: "artist:fixture",
  mbid: null,
  name: "Artist",
  sortName: null,
  metadata: null,
  sources: [],
  available: false,
  ...overrides,
});

export const readAlbum = (overrides: Partial<LibraryAlbum> = {}): LibraryAlbum => ({
  id: 2,
  identityKey: "album:fixture",
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

export const readTrack = (overrides: Partial<ReadInput["tracks"][number]> = {}) => ({
  id: 3,
  identityKey: "track:fixture",
  mbid: null,
  title: "Track",
  artistName: null,
  metadata: null,
  createdAt: 0,
  monitored: false,
  keepFile: false,
  albums: [],
  files: [],
  sources: [],
  available: false,
  ...overrides,
});

export const readFile = (overrides: Partial<LibraryTrackFile> = {}): LibraryTrackFile => ({
  id: 4,
  albumId: null,
  source: "aurral",
  path: "/music/fixture.flac",
  format: null,
  size: 0,
  mtimeMs: null,
  durationMs: null,
  quality: null,
  available: false,
  createdAt: 0,
  ...overrides,
});
