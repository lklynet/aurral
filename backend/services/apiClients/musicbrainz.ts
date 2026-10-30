import * as v from "valibot";
import createCache from "./simpleCache.ts";
import {
  getArtistByMbid as getMetadataArtistByMbid,
  getArtistNameByMbid as getMetadataArtistNameByMbid,
  listArtistAlbums as listMetadataArtistAlbums,
} from "../providers/brainzmashProvider.ts";
import { getLinkedArtistProviderIds } from "../providers/brainzmashMappers.ts";
import { musicbrainzGet, releaseGroupSchema } from "./musicbrainzHttp.ts";
import { readMany } from "../integrationData.ts";
import { runSharedInflight } from "../sharedInflight.ts";
import { logger } from "../logger.ts";
import { asAppError } from "../../../lib/errors.ts";

type ArtistAlbum = Awaited<ReturnType<typeof listMetadataArtistAlbums>>[number];

const musicbrainzArtistNameCache = createCache(3600);
const musicbrainzReleaseGroupsCache = createCache(300);
const musicbrainzAppearsOnCache = createCache(6 * 60 * 60, 200);
const musicbrainzTagArtistsCache = createCache(6 * 60 * 60, 200);
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";
const APPEARS_ON_PAGE_SIZE = 100;
const APPEARS_ON_MAX_RELEASES = 1000;
const musicbrainzInflightRequests = new Map();
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

const releasePageSchema = v.looseObject({
  "release-count": v.optional(v.number()),
  releases: v.array(v.unknown()),
});

const releaseSchema = v.looseObject({
  id: v.optional(v.string()),
  title: v.optional(v.string()),
  status: v.nullish(v.string()),
  date: v.optional(v.string()),
  "artist-credit": releaseGroupSchema.entries["artist-credit"],
  "release-group": releaseGroupSchema,
});

type MusicBrainzArtistCredit = v.InferOutput<typeof releaseGroupSchema>["artist-credit"];

type MusicBrainzRelease = v.InferOutput<typeof releaseSchema>;

interface AppearsOnScanState {
  byReleaseGroupId: Map<string, ReturnType<typeof mapAppearsOnReleaseGroup>>;
  nextOffset: number;
  complete: boolean;
}

export async function musicbrainzGetArtistReleaseGroups(
  mbid: string,
  selectedReleaseTypes: string[] | null = null,
  {
    includeTrackCounts = true,
    hydrateLimit = includeTrackCounts ? 30 : 6,
    signal,
  }: { includeTrackCounts?: boolean; hydrateLimit?: number; signal?: AbortSignal } = {},
) {
  const safeHydrateLimit =
    Number.isFinite(Number(hydrateLimit)) && Number(hydrateLimit) >= 0
      ? Math.min(100, Math.floor(Number(hydrateLimit)))
      : includeTrackCounts
        ? 30
        : 6;
  const cacheKey = `full:${mbid}:${JSON.stringify(selectedReleaseTypes || [])}:${includeTrackCounts ? "rated" : "dated"}:${safeHydrateLimit}`;
  const cached = musicbrainzReleaseGroupsCache.get(cacheKey);
  if (cached) return cached;
  try {
    const items = await listMetadataArtistAlbums(mbid, {
      releaseTypes: selectedReleaseTypes || [],
      includeTrackCounts,
      hydrateLimit: safeHydrateLimit,
      signal,
    });
    const mapped = items.map((item: ArtistAlbum) => ({
      id: item.id,
      title: item.title || "",
      "first-release-date": item.firstReleaseDate || null,
      "primary-type": item.type || "Album",
      "secondary-types": Array.isArray(item.secondaryTypes) ? item.secondaryTypes : [],
      rating: item.rating || null,
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
    }));
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

const browseMusicbrainzTrackArtistReleases = (
  mbid: string,
  { offset = 0, signal }: { offset?: number; signal?: AbortSignal } = {},
) =>
  musicbrainzGet(
    releasePageSchema,
    "/release",
    {
      track_artist: mbid,
      inc: "release-groups+artist-credits",
      limit: APPEARS_ON_PAGE_SIZE,
      offset,
    },
    { signal },
  );

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

const mapAppearsOnReleaseGroup = (release: MusicBrainzRelease) => {
  const releaseGroup = release["release-group"];
  const artistCredit = releaseGroup["artist-credit"]?.length
    ? releaseGroup["artist-credit"]
    : (release["artist-credit"] ?? []);
  return {
    id: releaseGroup.id,
    title: releaseGroup.title || release.title || "Untitled release",
    "first-release-date": releaseGroup["first-release-date"] || release.date || null,
    "primary-type": releaseGroup["primary-type"] || "Album",
    "secondary-types": releaseGroup["secondary-types"] ?? [],
    rating: null,
    "artist-credit": artistCredit,
    releases: release.id
      ? [
          {
            id: release.id,
            status: release.status || null,
            date: release.date || null,
            title: release.title || releaseGroup.title || "Untitled release",
          },
        ]
      : [],
  };
};

const scanAppearsOnPage = async (
  mbid: string,
  state: AppearsOnScanState,
  signal: AbortSignal | undefined,
) => {
  const data = await browseMusicbrainzTrackArtistReleases(mbid, {
    offset: state.nextOffset,
    signal,
  });
  const releases = readMany(releaseSchema, data.releases, {
    service: "MusicBrainz",
    endpoint: "/release",
  });
  for (const release of releases) {
    const releaseGroupId = release["release-group"].id;
    if (!releaseGroupId || state.byReleaseGroupId.has(releaseGroupId)) continue;
    if (
      artistCreditIncludesMbid(release["artist-credit"], mbid) ||
      artistCreditIncludesMbid(release["release-group"]["artist-credit"], mbid)
    ) {
      continue;
    }
    state.byReleaseGroupId.set(releaseGroupId, mapAppearsOnReleaseGroup(release));
  }
  state.nextOffset += data.releases.length;
  const releaseCount = Number(data["release-count"]);
  state.complete =
    data.releases.length === 0 ||
    state.nextOffset >= APPEARS_ON_MAX_RELEASES ||
    (Number.isFinite(releaseCount) && state.nextOffset >= releaseCount);
  musicbrainzAppearsOnCache.set(mbid, state);
  return state;
};

export async function musicbrainzGetArtistAppearsOnReleaseGroups(
  mbid: string,
  {
    limit = 24,
    offset = 0,
    signal,
    scanPageBudget = 1,
  }: { limit?: number | null; offset?: number; signal?: AbortSignal; scanPageBudget?: number } = {},
) {
  if (!mbid) return [];
  const safeLimit = Math.min(250, Math.max(1, Number.parseInt(String(limit), 10) || 24));
  const safeOffset = Math.min(250, Math.max(0, Number.parseInt(String(offset), 10) || 0));
  const targetCount = Math.min(250, safeOffset + safeLimit);
  const parsedScanPageBudget = Number.parseInt(String(scanPageBudget), 10);
  const safeScanPageBudget = Math.min(
    10,
    Math.max(0, Number.isFinite(parsedScanPageBudget) ? parsedScanPageBudget : 1),
  );

  let state = musicbrainzAppearsOnCache.get(mbid) || {
    byReleaseGroupId: new Map(),
    nextOffset: 0,
    complete: false,
  };
  try {
    for (
      let scannedPages = 0;
      state.byReleaseGroupId.size < targetCount &&
      !state.complete &&
      scannedPages < safeScanPageBudget;
      scannedPages += 1
    ) {
      const current = state;
      state = await runSharedInflight(
        musicbrainzInflightRequests,
        `appears-on-page:${mbid}`,
        (sharedSignal: AbortSignal) => scanAppearsOnPage(mbid, current, sharedSignal),
        { signal },
      );
    }
  } catch (error) {
    const failure = asAppError(error);
    if (!signal?.aborted && failure?.name !== "AbortError") {
      logger.warn("musicbrainz", "Artist appearances lookup failed", {
        mbid,
        message: failure?.message,
      });
    }
    throw error;
  }

  return [...state.byReleaseGroupId.values()]
    .sort((left, right) =>
      String(right["first-release-date"] || "").localeCompare(
        String(left["first-release-date"] || ""),
      ),
    )
    .slice(safeOffset, targetCount);
}

export const getMusicbrainzAppearsOnScanState = (mbid: string) => {
  const state = musicbrainzAppearsOnCache.get(mbid);
  if (!state) return { complete: false, nextOffset: 0 };
  return {
    complete: state.complete,
    nextOffset: state.nextOffset,
  };
};

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
  } catch (e) {
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
