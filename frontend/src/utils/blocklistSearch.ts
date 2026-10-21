type ArtistCandidate = {
  id?: string | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
  name?: string | null;
  artistName?: string | null;
};

type BlocklistSearchResponse = {
  top?: (ArtistCandidate & { type?: string }) | null;
  catalog?: { artists?: ArtistCandidate[] | null } | null;
  library?: { artists?: ArtistCandidate[] | null } | null;
};

function normalizeArtist(artist: ArtistCandidate | null | undefined) {
  return {
    id: artist?.id || artist?.mbid || artist?.foreignArtistId || null,
    name: String(artist?.name || artist?.artistName || "").trim(),
  };
}

export function buildBlocklistArtistSuggestions(response: BlocklistSearchResponse, limit = 6) {
  const candidates = [
    response?.top?.type === "artist" ? response.top : null,
    ...(Array.isArray(response?.catalog?.artists) ? response.catalog.artists : []),
    ...(Array.isArray(response?.library?.artists) ? response.library.artists : []),
  ];
  const seenIds = new Set();
  const seenNames = new Set();
  const suggestions = [];
  const maxSuggestions = Math.max(1, Number(limit) || 6);

  for (const candidate of candidates) {
    const artist = normalizeArtist(candidate);
    const idKey = String(artist.id || "")
      .trim()
      .toLowerCase();
    const nameKey = artist.name.toLowerCase();
    if (!nameKey || (idKey && seenIds.has(idKey)) || seenNames.has(nameKey)) continue;

    if (idKey) seenIds.add(idKey);
    seenNames.add(nameKey);
    suggestions.push(artist);
    if (suggestions.length >= maxSuggestions) break;
  }

  return suggestions;
}
