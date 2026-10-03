const EMPTY_ACTIVE_DOWNLOADS = { albums: [], artists: [], tracks: [] };

const normalizeName = (value) => String(value || "").trim().toLocaleLowerCase();
const trackNameKey = (artistName, trackName) => {
  const artist = normalizeName(artistName);
  const track = normalizeName(trackName);
  return artist && track ? `${artist}\u0000${track}` : "";
};

export const normalizeActiveDownloads = (data) => ({
  albums: Array.isArray(data?.albums) ? data.albums : [],
  artists: Array.isArray(data?.artists) ? data.artists : [],
  tracks: Array.isArray(data?.tracks) ? data.tracks : [],
});

export const indexActiveDownloads = (data = EMPTY_ACTIVE_DOWNLOADS) => {
  const active = normalizeActiveDownloads(data);
  const trackMbids = new Set();
  const trackNames = new Set();
  for (const track of active.tracks) {
    if (track?.mbid) trackMbids.add(String(track.mbid));
    const key = trackNameKey(track?.artistName, track?.trackName);
    if (key) trackNames.add(key);
  }
  return {
    albums: new Set(active.albums.map(String)),
    artists: new Set(active.artists.map(String)),
    trackMbids,
    trackNames,
  };
};

export const isAlbumDownloading = (index, albumMbid) =>
  Boolean(albumMbid) && index.albums.has(String(albumMbid));

export const isArtistDownloading = (index, artistMbid) =>
  Boolean(artistMbid) && index.artists.has(String(artistMbid));

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isTrackDownloading = (index, track) => {
  if (!track) return false;
  const mbids = [track.trackMbid, track.mbid, track.recordingId, track.foreignRecordingId];
  if (MBID_PATTERN.test(String(track.id || ""))) mbids.push(track.id);
  return (
    mbids.some((mbid) => mbid && index.trackMbids.has(String(mbid))) ||
    index.trackNames.has(
      trackNameKey(track.artistName ?? track.artist, track.trackName ?? track.title),
    )
  );
};

export const hasActiveDownloads = (data) => {
  const active = normalizeActiveDownloads(data);
  return active.albums.length > 0 || active.artists.length > 0 || active.tracks.length > 0;
};

export const addActiveDownload = (data, { albumMbid, artistMbid, track } = {}) => {
  const active = normalizeActiveDownloads(data);
  return {
    albums: albumMbid ? [...new Set([...active.albums, albumMbid])] : active.albums,
    artists: artistMbid ? [...new Set([...active.artists, artistMbid])] : active.artists,
    tracks: track ? [...active.tracks, track] : active.tracks,
  };
};

export const finishedActiveDownloads = (previous, next) => {
  const before = indexActiveDownloads(previous);
  const after = indexActiveDownloads(next);
  const missing = (from, to) => [...from].some((key) => !to.has(key));
  return (
    missing(before.albums, after.albums) ||
    missing(before.trackMbids, after.trackMbids) ||
    missing(before.trackNames, after.trackNames)
  );
};
