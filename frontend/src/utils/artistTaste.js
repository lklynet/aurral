export const getArtistRecordId = (artist) =>
  artist?.id || artist?.mbid || artist?.foreignArtistId;

const uniqueTextList = (values) => {
  const seen = new Set();
  const out = [];
  for (const entry of values) {
    const normalized = String(entry || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
};

export const buildArtistFeedbackPayload = (
  artist,
  action,
  { sourceContext = null, seedArtistName = null } = {},
) => {
  const tagContext = uniqueTextList([
    ...(Array.isArray(artist?.matchedTags) ? artist.matchedTags : []),
    ...(Array.isArray(artist?.tags) ? artist.tags : []),
    ...(Array.isArray(artist?.genres) ? artist.genres : []),
  ]);
  const seedContext = uniqueTextList([
    ...(Array.isArray(artist?.supportingSeeds)
      ? artist.supportingSeeds.map((seed) => seed?.artistName)
      : []),
    ...(Array.isArray(artist?.sourceArtists) ? artist.sourceArtists : []),
    seedArtistName,
    artist?.sourceArtist,
  ]);

  return {
    artistId: getArtistRecordId(artist),
    artistName: artist?.name || artist?.artistName || null,
    action,
    sourceContext:
      sourceContext ||
      artist?.sourceType ||
      artist?.discoveryTier ||
      artist?.tagResultSource ||
      null,
    tagContext,
    seedContext,
  };
};
