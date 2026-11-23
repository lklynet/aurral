import { isSameArtist } from "../../../lib/artistMatch.ts";
import type { ArtistFeedbackSource } from "./artistTaste.ts";
import type { UnifiedSearchItem } from "../../../backend/services/unifiedSearchService.ts";

type ArtistBucket = { artists?: (ArtistFeedbackSource | null)[] | null } | null;

type BlocklistSearchResponse = {
  catalog?: (ArtistBucket & { top?: UnifiedSearchItem | null }) | null;
  library?: ArtistBucket;
};

function normalizeArtist(artist: ArtistFeedbackSource | null | undefined) {
  return {
    id: artist?.id || artist?.mbid || artist?.foreignArtistId || null,
    name: String(artist?.name || artist?.artistName || "").trim(),
  };
}

export function buildBlocklistArtistSuggestions(response: BlocklistSearchResponse, limit = 6) {
  const top = response.catalog?.top;
  const candidates = [
    top?.type === "artist" ? top : null,
    ...(response.catalog?.artists ?? []),
    ...(response.library?.artists ?? []),
  ];
  const suggestions: ReturnType<typeof normalizeArtist>[] = [];
  const maxSuggestions = Math.max(1, Number(limit) || 6);

  for (const candidate of candidates) {
    const artist = normalizeArtist(candidate);
    if (!artist.name || suggestions.some((seen) => isSameArtist(seen, artist))) continue;
    suggestions.push(artist);
    if (suggestions.length >= maxSuggestions) break;
  }

  return suggestions;
}
