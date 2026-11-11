import type { LibraryAlbum, LibraryTrack } from "../../frontend/src/utils/libraryPageData.ts";
import type { ActivityRequest } from "../../lib/activity.ts";

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

export const activityRequest = (overrides: Partial<ActivityRequest> = {}): ActivityRequest => ({
  id: "activity-1",
  source: "aurral",
  type: "activity",
  title: "Track",
  subtitle: null,
  status: "completed",
  statusLabel: null,
  requestedAt: "2026-01-01T00:00:00Z",
  href: null,
  kind: "track_download",
  playlistId: "library",
  playlistName: null,
  jobId: null,
  trackName: null,
  artistName: null,
  albumName: null,
  albumMbid: null,
  albumId: null,
  libraryAlbumId: null,
  requestGroupId: null,
  requestedBy: null,
  sourceFilename: null,
  releaseTitle: null,
  upgrade: null,
  inQueue: false,
  ...overrides,
});
