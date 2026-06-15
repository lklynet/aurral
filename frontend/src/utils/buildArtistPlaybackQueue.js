import { getLibraryTracks, getReleaseGroupTracks } from "./api";
import {
  isDownloadedLibraryAlbum,
  normalizePreviewTrack,
  normalizeQueueTrack,
} from "./audioQueue";

const RELEASE_GROUP_FETCH_BATCH = 8;

function isLibraryStreamTrack(track) {
  return track?.previewProvider === "lidarr" || !!track?.streamPath;
}

function getRecordingKey(track) {
  const key =
    track?.mbid ||
    track?.recordingId ||
    track?.recordingMbid ||
    track?.foreignRecordingId;
  return key ? `rec:${key}` : null;
}

function findLibraryAlbumForReleaseGroup(libraryAlbums, releaseGroupId) {
  return libraryAlbums.find(
    (album) =>
      String(album.mbid || album.foreignAlbumId) === String(releaseGroupId),
  );
}

async function fetchReleaseGroupTracks(
  releaseGroup,
  { artistName, artistMbid, libraryAlbums, localCache },
) {
  const releaseGroupId = releaseGroup?.id;
  if (!releaseGroupId) return [];

  const libraryAlbum = findLibraryAlbumForReleaseGroup(
    libraryAlbums,
    releaseGroupId,
  );
  const cacheKey = libraryAlbum?.id
    ? String(libraryAlbum.id)
    : String(releaseGroupId);

  if (localCache[cacheKey]) {
    return localCache[cacheKey];
  }

  const context = {
    artistName,
    albumTitle: releaseGroup.title || libraryAlbum?.title || "",
    releaseType: releaseGroup["primary-type"] || "",
    releaseDate: releaseGroup["first-release-date"] || "",
    deezerAlbumId: releaseGroup._deezerAlbumId || "",
  };

  try {
    const tracks = libraryAlbum?.id
      ? await getLibraryTracks(
          libraryAlbum.id,
          releaseGroupId,
          {
            ...context,
            albumTitle: libraryAlbum.title || context.albumTitle,
          },
        )
      : await getReleaseGroupTracks(releaseGroupId, {
          artistMbid: artistMbid || "",
          ...context,
        });
    const normalized = Array.isArray(tracks) ? tracks : [];
    localCache[cacheKey] = normalized;
    return normalized;
  } catch {
    localCache[cacheKey] = [];
    return [];
  }
}

export async function buildArtistPlaybackQueue({
  artistName,
  artistMbid = "",
  previewTracks = [],
  existsInLibrary = false,
  libraryArtist = null,
  libraryAlbums = [],
  downloadStatuses = {},
  albumTracksCache = {},
  releaseGroups = [],
} = {}) {
  const queue = [];
  const seen = new Set();
  const localCache = { ...albumTracksCache };

  const remember = (keys) => {
    for (const key of keys) {
      if (key) seen.add(key);
    }
  };

  const hasSeen = (keys) => keys.some((key) => key && seen.has(key));

  const pushTrack = (track, rawTrack = null) => {
    if (!track?.src) return;
    const keys = [
      track.src,
      track.id,
      getRecordingKey(rawTrack || track),
    ].filter(Boolean);
    if (hasSeen(keys)) return;
    remember(keys);
    queue.push(track);
  };

  if (existsInLibrary && libraryArtist?.id && Array.isArray(libraryAlbums)) {
    const downloaded = libraryAlbums.filter((album) =>
      isDownloadedLibraryAlbum(album, downloadStatuses),
    );
    for (const album of downloaded) {
      const cacheKey = String(album.id ?? "");
      let tracks = localCache[cacheKey];
      if (!tracks) {
        tracks = await getLibraryTracks(
          album.id,
          album.mbid || album.foreignAlbumId,
          {
            artistName,
            albumTitle: album.title,
          },
        );
        localCache[cacheKey] = tracks;
      }
      for (const track of tracks) {
        if (!track?.preview_url || !isLibraryStreamTrack(track)) continue;
        pushTrack(
          normalizeQueueTrack({
            id: track.id ?? track.mbid ?? `lib-${album.id}-${track.trackNumber}`,
            title: track.title || track.trackName,
            artist: artistName,
            album: album.title,
            src: track.preview_url,
            streamFormat: track.streamFormat,
            quality: track.quality,
          }),
          track,
        );
      }
    }

    if (queue.length > 0) {
      return queue;
    }
  }

  for (const track of previewTracks) {
    if (!track?.preview_url) continue;
    pushTrack(normalizePreviewTrack(track, artistName), track);
  }

  const sortedReleaseGroups = [...releaseGroups]
    .filter((releaseGroup) => releaseGroup?.id)
    .sort((a, b) => (b?.fans || 0) - (a?.fans || 0));

  const pendingReleaseGroups = sortedReleaseGroups.filter((releaseGroup) => {
    const libraryAlbum = findLibraryAlbumForReleaseGroup(
      libraryAlbums,
      releaseGroup.id,
    );
    const cacheKey = libraryAlbum?.id
      ? String(libraryAlbum.id)
      : String(releaseGroup.id);
    return !localCache[cacheKey];
  });

  for (let i = 0; i < pendingReleaseGroups.length; i += RELEASE_GROUP_FETCH_BATCH) {
    const batch = pendingReleaseGroups.slice(i, i + RELEASE_GROUP_FETCH_BATCH);
    await Promise.all(
      batch.map((releaseGroup) =>
        fetchReleaseGroupTracks(releaseGroup, {
          artistName,
          artistMbid,
          libraryAlbums,
          localCache,
        }),
      ),
    );
  }

  for (const releaseGroup of sortedReleaseGroups) {
    const libraryAlbum = findLibraryAlbumForReleaseGroup(
      libraryAlbums,
      releaseGroup.id,
    );
    const cacheKey = libraryAlbum?.id
      ? String(libraryAlbum.id)
      : String(releaseGroup.id);
    const tracks = localCache[cacheKey] || [];
    const albumTitle =
      libraryAlbum?.title || releaseGroup.title || "Unknown Album";

    for (const track of tracks) {
      if (!track?.preview_url) continue;
      pushTrack(
        normalizePreviewTrack(
          {
            id: track.id ?? track.mbid,
            title: track.title || track.trackName,
            preview_url: track.preview_url,
          },
          artistName,
          { album: albumTitle },
        ),
        track,
      );
    }
  }

  return queue;
}
