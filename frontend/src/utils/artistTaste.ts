import type {
  ArtistIdentity,
  DiscoveryRecommendation,
} from "../../../backend/services/discovery/recommendationPipeline.ts";

export type ArtistFeedbackSource = Omit<ArtistIdentity, "id"> & {
  id?: string | number | null;
} & Pick<
    DiscoveryRecommendation,
    "tags" | "matchedTags" | "supportingSeeds" | "sourceArtist" | "sourceArtists"
  > & {
    genres?: string[] | null;
    sourceType?: string | null;
    discoveryTier?: string | null;
  };

export type ArtistFeedbackAction = "more_like_this" | "less_like_this" | "block_artist";

type ArtistRecordFields<Id> = {
  id?: Id | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
};

export function getArtistRecordId(
  artist: ArtistRecordFields<string> | null | undefined,
): string | null | undefined;
export function getArtistRecordId(
  artist: ArtistRecordFields<string | number> | null | undefined,
): string | number | null | undefined;
export function getArtistRecordId(artist: ArtistRecordFields<string | number> | null | undefined) {
  return artist?.id || artist?.mbid || artist?.foreignArtistId;
}

const uniqueTextList = (values: (string | null | undefined)[]) => {
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
  artist: ArtistFeedbackSource | null | undefined,
  action: ArtistFeedbackAction,
  {
    sourceContext = null,
    seedArtistName = null,
  }: { sourceContext?: string | null; seedArtistName?: string | null } = {},
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
    sourceContext: sourceContext || artist?.sourceType || artist?.discoveryTier || null,
    tagContext,
    seedContext,
  };
};
