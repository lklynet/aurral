const text = (value) => String(value || "").trim();

const trackNumberOf = (track) =>
  Number(
    track?.trackNumber ||
      track?.position ||
      track?.albums?.[0]?.trackNumber ||
      0,
  );

const titleKey = (track) => text(track?.title || track?.trackName).toLocaleLowerCase();

const metadataDuration = (track) => {
  const duration = Number(track?.length ?? track?.durationMs ?? track?.duration ?? 0);
  return duration > 0 ? duration : null;
};

export function mergeAlbumMetadataTracks(
  ownedTracks,
  metadataTracks,
  album,
  artist = null,
) {
  const owned = Array.isArray(ownedTracks) ? ownedTracks : [];
  const metadata = Array.isArray(metadataTracks) ? metadataTracks : [];
  const usedOwned = new Set();
  const albumMbid = album?.mbid || album?.releaseGroupMbid || null;
  const artistName = artist?.name || album?.artistName || album?.albumArtist || "";
  const artistMbid = artist?.mbid || album?.artistMbid || null;

  const findOwned = (entry) => {
    const mbid = text(entry?.mbid || entry?.id);
    const number = trackNumberOf(entry);
    const title = titleKey(entry);
    const candidates = owned.filter((track) => !usedOwned.has(track));
    return (
      candidates.find((track) => mbid && text(track?.mbid) === mbid) ||
      candidates.find((track) => number > 0 && trackNumberOf(track) === number) ||
      candidates.find((track) => title && titleKey(track) === title) ||
      null
    );
  };

  const tracks = metadata.map((entry, index) => {
    const number = trackNumberOf(entry) || index + 1;
    const existing = findOwned(entry);
    if (existing) {
      usedOwned.add(existing);
      return existing;
    }

    const mbid = text(entry?.mbid || entry?.id) || null;
    return {
      id: `metadata:${album?.id || "album"}:${mbid || number}`,
      mbid,
      title: text(entry?.title || entry?.trackName) || "Unknown Track",
      trackName: text(entry?.trackName || entry?.title) || "Unknown Track",
      artistName,
      artistMbid,
      albumName: album?.title || album?.albumName || "Unknown Album",
      albumMbid,
      albumId: album?.id,
      trackNumber: number,
      durationMs: metadataDuration(entry),
      metadata: metadataDuration(entry) ? { durationMs: metadataDuration(entry) } : {},
      albums: [{ albumId: album?.id, discNumber: 1, trackNumber: number }],
      files: [],
      sources: [],
      available: false,
    };
  });

  owned.forEach((track) => {
    if (!usedOwned.has(track)) tracks.push(track);
  });

  return tracks.sort((left, right) => {
    const numberDifference = trackNumberOf(left) - trackNumberOf(right);
    return numberDifference || titleKey(left).localeCompare(titleKey(right));
  });
}
