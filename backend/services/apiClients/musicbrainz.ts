import * as v from "valibot";
import createCache from "./simpleCache.ts";
import {
  getArtistByMbid as getMetadataArtistByMbid,
  getArtistNameByMbid as getMetadataArtistNameByMbid,
  listArtistAlbums as listMetadataArtistAlbums,
} from "../providers/metadataProvider.ts";
import { getLinkedArtistProviderIds } from "../providers/metadataMappers.ts";
import { scoreTextMatch } from "../providers/metadataRanking.ts";
import { buildStableImageProxyUrl } from "../imageProxyService.ts";
import { artistCreditSchema, musicbrainzGet, releaseGroupSchema } from "./musicbrainzHttp.ts";
import { readMany } from "../integrationData.ts";

type ArtistAlbum = Awaited<ReturnType<typeof listMetadataArtistAlbums>>[number];

const musicbrainzArtistNameCache = createCache<string | null>(3600);
const musicbrainzReleaseGroupsCache = createCache<ReturnType<typeof toReleaseGroup>[]>(300);
const musicbrainzTagArtistsCache = createCache<{
  total: number;
  nextOffset: number;
  artists: { mbid: string; name: string }[];
}>(6 * 60 * 60, 200);
const musicbrainzTrackReleaseGroupCache = createCache<string | null>(6 * 60 * 60, 500);
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";
const PRIMARY_RELEASE_TYPES = ["Album", "EP", "Single"];
const SECONDARY_RELEASE_TYPES = [
  "Live",
  "Remix",
  "Compilation",
  "Demo",
  "Broadcast",
  "Soundtrack",
  "Spokenword",
  "Other",
];

const tagSearchSchema = v.looseObject({
  count: v.optional(v.number()),
  artists: v.array(v.unknown()),
});

const tagArtistSchema = v.looseObject({ id: v.string(), name: v.string() });

const releaseSchema = v.looseObject({
  id: v.optional(v.string()),
  title: v.optional(v.string()),
  status: v.nullish(v.string()),
  date: v.optional(v.string()),
  "artist-credit": releaseGroupSchema.entries["artist-credit"],
  "release-group": releaseGroupSchema,
});

const recordingSearchSchema = v.looseObject({ recordings: v.array(v.unknown()) });

const recordingSchema = v.looseObject({
  title: v.optional(v.string()),
  releases: v.optional(v.array(v.unknown())),
});

type MusicBrainzArtistCredit = v.InferOutput<typeof artistCreditSchema>;

type MusicBrainzRelease = v.InferOutput<typeof releaseSchema>;

const toReleaseGroup = (item: ArtistAlbum) => ({
  id: item.id,
  title: item.title || "",
  "first-release-date": item.firstReleaseDate || null,
  "primary-type": item.type || "Album",
  "secondary-types": Array.isArray(item.secondaryTypes) ? item.secondaryTypes : [],
  rating: item.rating || null,
  listenerCount: item.listeners > 0 ? item.listeners : null,
  coverUrl: buildStableImageProxyUrl(item.cover),
  "artist-credit": item.artistName
    ? [
        {
          name: item.artistName,
          artist: item.artistId
            ? { id: item.artistId, name: item.artistName }
            : { name: item.artistName },
        },
      ]
    : [],
});

export async function musicbrainzGetArtistReleaseGroups(
  mbid: string,
  selectedReleaseTypes: string[] | null = null,
  { signal }: { signal?: AbortSignal } = {},
) {
  const cacheKey = `full:${mbid}:${JSON.stringify(selectedReleaseTypes || [])}`;
  const cached = musicbrainzReleaseGroupsCache.get(cacheKey);
  if (cached) return cached;
  try {
    const items = await listMetadataArtistAlbums(mbid, {
      releaseTypes: selectedReleaseTypes || [],
      signal,
    });
    const mapped = items.map(toReleaseGroup);
    musicbrainzReleaseGroupsCache.set(cacheKey, mapped);
    return mapped;
  } catch {
    return [];
  }
}

const artistCreditIncludesMbid = (
  artistCredit: MusicBrainzArtistCredit,
  mbid: string | null | undefined,
) => {
  const normalizedMbid = String(mbid || "")
    .trim()
    .toLowerCase();
  if (!normalizedMbid || !artistCredit) return false;
  return artistCredit.some(
    (credit) =>
      String(credit?.artist?.id || "")
        .trim()
        .toLowerCase() === normalizedMbid,
  );
};

const isSpecialPurposeArtist = (artist: v.InferOutput<typeof tagArtistSchema>) =>
  artist.id === VARIOUS_ARTISTS_MBID || /^\[.*\]$/.test(artist.name);

export async function musicbrainzSearchArtistsByTag(
  tag: string,
  { limit = 25, offset = 0 }: { limit?: number; offset?: number } = {},
) {
  const normalizedTag = String(tag || "")
    .trim()
    .toLowerCase();
  if (!normalizedTag) return { total: 0, nextOffset: 0, artists: [] };
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 25));
  const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const cacheKey = `${normalizedTag}:${safeLimit}:${safeOffset}`;
  const cached = musicbrainzTagArtistsCache.get(cacheKey);
  if (cached) return cached;
  const data = await musicbrainzGet(tagSearchSchema, "/artist", {
    query: `tag:"${normalizedTag.replace(/["\\]/g, "\\$&")}"`,
    limit: safeLimit,
    offset: safeOffset,
  });
  const artists = readMany(tagArtistSchema, data.artists, {
    service: "MusicBrainz",
    endpoint: "/artist",
  });
  const result = {
    total: data.count ?? 0,
    nextOffset: safeOffset + data.artists.length,
    artists: artists
      .filter((artist) => !isSpecialPurposeArtist(artist))
      .map((artist) => ({ mbid: artist.id, name: artist.name })),
  };
  musicbrainzTagArtistsCache.set(cacheKey, result);
  return result;
}

// The release group a song is on, found from the song itself, for a song whose
// album is not one of the artist's own, such as a soundtrack credited to the
// game. The album the song came with wins, then a release crediting the artist.
export async function musicbrainzFindTrackReleaseGroup({
  artistMbid,
  trackName,
  albumName,
}: {
  artistMbid: string;
  trackName: string;
  albumName: string;
}) {
  const cacheKey = JSON.stringify(
    [artistMbid, trackName, albumName].map((part) => part.toLowerCase()),
  );
  const cached = musicbrainzTrackReleaseGroupCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const data = await musicbrainzGet(recordingSearchSchema, "/recording", {
    query: `recording:"${trackName.replace(/["\\]/g, "\\$&")}" AND arid:${artistMbid}`,
    limit: 10,
  });
  const source = { service: "MusicBrainz", endpoint: "/recording" };
  const rank = (release: MusicBrainzRelease) =>
    2 * Number(scoreTextMatch(release["release-group"].title, albumName) >= 85) +
    Number(artistCreditIncludesMbid(release["artist-credit"], artistMbid));
  const [best] = readMany(recordingSchema, data.recordings, source)
    .filter((recording) => scoreTextMatch(recording.title, trackName) >= 85)
    .flatMap((recording) => readMany(releaseSchema, recording.releases ?? [], source))
    .toSorted(
      (left, right) =>
        rank(right) - rank(left) || (left.date || "9999").localeCompare(right.date || "9999"),
    );
  const releaseGroupId = best?.["release-group"].id ?? null;
  musicbrainzTrackReleaseGroupCache.set(cacheKey, releaseGroupId);
  return releaseGroupId;
}

export async function musicbrainzGetArtistNameByMbid(
  mbid: string,
  { signal }: { signal?: AbortSignal } = {},
) {
  if (!mbid) return null;
  const cached = musicbrainzArtistNameCache.get(mbid);
  if (cached !== undefined) return cached;
  try {
    const name = await getMetadataArtistNameByMbid(mbid, { signal });
    const normalized = name && typeof name === "string" ? name.trim() : null;
    musicbrainzArtistNameCache.set(mbid, normalized);
    return normalized;
  } catch {
    musicbrainzArtistNameCache.set(mbid, null);
    return null;
  }
}

export async function musicbrainzGetArtistIdentityByMbid(
  mbid: string | null | undefined,
  { signal }: { signal?: AbortSignal } = {},
) {
  const normalizedMbid = String(mbid || "").trim();
  if (!normalizedMbid) return null;
  try {
    const artist = await getMetadataArtistByMbid(normalizedMbid, { signal });
    return {
      mbid: normalizedMbid,
      name: artist.name || null,
      aliases: [...new Set(artist.aliases)],
      providerIds: getLinkedArtistProviderIds(artist.links),
    };
  } catch {
    return null;
  }
}

export {
  PRIMARY_RELEASE_TYPES,
  SECONDARY_RELEASE_TYPES,
  musicbrainzArtistNameCache,
  musicbrainzReleaseGroupsCache,
  musicbrainzTagArtistsCache,
};
