export interface ActiveDownloadTrack {
  id?: string | number | null;
  mbid?: string | null;
  trackMbid?: string | null;
  recordingId?: string | null;
  foreignRecordingId?: string | null;
  artistName?: string | null;
  artist?: string | null;
  trackName?: string | null;
  title?: string | null;
}

export interface ActiveDownloads {
  albums: string[];
  artists: string[];
  tracks: ActiveDownloadTrack[];
}

const EMPTY_ACTIVE_DOWNLOADS: ActiveDownloads = { albums: [], artists: [], tracks: [] };

const normalizeName = (value: string | null | undefined) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase();
const trackNameKey = (
  artistName: string | null | undefined,
  trackName: string | null | undefined,
) => {
  const artist = normalizeName(artistName);
  const track = normalizeName(trackName);
  return artist && track ? `${artist}\u0000${track}` : "";
};

export const normalizeActiveDownloads = (
  data: Partial<ActiveDownloads> | null | undefined,
): ActiveDownloads => ({
  albums: Array.isArray(data?.albums) ? data.albums : [],
  artists: Array.isArray(data?.artists) ? data.artists : [],
  tracks: Array.isArray(data?.tracks) ? data.tracks : [],
});

export const indexActiveDownloads = (
  data: Partial<ActiveDownloads> | null | undefined = EMPTY_ACTIVE_DOWNLOADS,
) => {
  const active = normalizeActiveDownloads(data);
  const trackMbids = new Set<string>();
  const trackNames = new Set<string>();
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

type ActiveDownloadIndex = ReturnType<typeof indexActiveDownloads>;

export const isAlbumDownloading = (
  index: ActiveDownloadIndex,
  albumMbid: string | null | undefined,
) => Boolean(albumMbid) && index.albums.has(String(albumMbid));

export const isArtistDownloading = (
  index: ActiveDownloadIndex,
  artistMbid: string | null | undefined,
) => Boolean(artistMbid) && index.artists.has(String(artistMbid));

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isTrackDownloading = (
  index: ActiveDownloadIndex,
  track: ActiveDownloadTrack | null | undefined,
) => {
  if (!track) return false;
  const mbids: (string | number | null | undefined)[] = [
    track.trackMbid,
    track.mbid,
    track.recordingId,
    track.foreignRecordingId,
  ];
  if (MBID_PATTERN.test(String(track.id || ""))) mbids.push(track.id);
  return (
    mbids.some((mbid) => mbid && index.trackMbids.has(String(mbid))) ||
    index.trackNames.has(
      trackNameKey(track.artistName ?? track.artist, track.trackName ?? track.title),
    )
  );
};

export const hasActiveDownloads = (data: Partial<ActiveDownloads> | null | undefined) => {
  const active = normalizeActiveDownloads(data);
  return active.albums.length > 0 || active.artists.length > 0 || active.tracks.length > 0;
};

export const addActiveDownload = (
  data: Partial<ActiveDownloads> | null | undefined,
  {
    albumMbid,
    artistMbid,
    track,
  }: { albumMbid?: string | null; artistMbid?: string | null; track?: ActiveDownloadTrack } = {},
) => {
  const active = normalizeActiveDownloads(data);
  return {
    albums: albumMbid ? [...new Set([...active.albums, albumMbid])] : active.albums,
    artists: artistMbid ? [...new Set([...active.artists, artistMbid])] : active.artists,
    tracks: track ? [...active.tracks, track] : active.tracks,
  };
};

export const finishedActiveDownloads = (
  previous: Partial<ActiveDownloads> | null | undefined,
  next: Partial<ActiveDownloads> | null | undefined,
) => {
  const before = indexActiveDownloads(previous);
  const after = indexActiveDownloads(next);
  const missing = (from: Set<string>, to: Set<string>) => [...from].some((key) => !to.has(key));
  return (
    missing(before.albums, after.albums) ||
    missing(before.trackMbids, after.trackMbids) ||
    missing(before.trackNames, after.trackNames)
  );
};
