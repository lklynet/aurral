import * as v from "valibot";
import { listenbrainzRequest } from "../apiClients/index.ts";
import { lenient } from "../integrationData.ts";
import { VARIOUS_ARTISTS_MBID } from "../trackMatching/titleText.ts";

const FRESH_RELEASES_TTL_MS = 6 * 60 * 60 * 1000;
const FRESH_RELEASES_RETRY_MS = 15 * 60 * 1000;
const FRESH_RELEASE_TYPES = new Set(["Album", "EP", "Single"]);

const nullableText = lenient(v.nullable(v.string()));
const freshReleaseSchema = v.fallback(
  v.looseObject({
    artist_credit_name: nullableText,
    artist_mbids: lenient(v.nullable(v.array(v.string()))),
    release_date: nullableText,
    release_group_mbid: nullableText,
    release_group_primary_type: nullableText,
    release_group_secondary_type: nullableText,
    release_name: nullableText,
    caa_id: lenient(v.nullable(v.number())),
    caa_release_mbid: nullableText,
  }),
  {},
);
const freshReleasesSchema = v.looseObject({
  payload: lenient(v.looseObject({ releases: lenient(v.array(freshReleaseSchema)) })),
});
type ListenbrainzFreshRelease = v.InferOutput<typeof freshReleaseSchema>;

const slim = (release: ListenbrainzFreshRelease) => {
  const releaseGroupMbid = release.release_group_mbid?.trim();
  const title = release.release_name?.trim();
  const type = release.release_group_primary_type || "";
  const secondaryType = release.release_group_secondary_type?.trim();
  const artistMbids = (release.artist_mbids || []).filter(
    (mbid) => mbid && mbid !== VARIOUS_ARTISTS_MBID,
  );
  return releaseGroupMbid &&
    title &&
    release.release_date &&
    artistMbids.length > 0 &&
    FRESH_RELEASE_TYPES.has(type)
    ? [
        {
          releaseGroupMbid,
          title,
          type,
          secondaryTypes: secondaryType ? [secondaryType] : [],
          artistMbids,
          artistName: release.artist_credit_name?.trim() || "Unknown Artist",
          releaseDate: release.release_date,
          coverUrl:
            release.caa_id && release.caa_release_mbid
              ? `https://imagecache.lidarr.audio/v1/caa/${release.caa_release_mbid}/${release.caa_id}-500.jpg`
              : null,
        },
      ]
    : [];
};

let snapshot: { fetchedAt: number; releases: ReturnType<typeof slim> } | null = null;
let refreshing: Promise<void> | null = null;

export async function fetchFreshReleases(days: number, { timeoutMs = 30_000 } = {}) {
  const data = await listenbrainzRequest(
    "/1/explore/fresh-releases/",
    { days, past: "true", future: "true" },
    { timeoutMs, cache: false },
  );
  return (v.parse(freshReleasesSchema, data).payload?.releases ?? []).flatMap(slim);
}

export function refreshFreshReleases() {
  refreshing ??= fetchFreshReleases(30)
    .then((releases) => {
      snapshot = { fetchedAt: Date.now(), releases };
    })
    .catch(() => {
      snapshot = {
        fetchedAt: Date.now() - FRESH_RELEASES_TTL_MS + FRESH_RELEASES_RETRY_MS,
        releases: snapshot?.releases || [],
      };
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export function getFreshReleasesByArtists(artistMbids: Iterable<string | null | undefined>) {
  if (!snapshot || Date.now() - snapshot.fetchedAt >= FRESH_RELEASES_TTL_MS) {
    void refreshFreshReleases();
  }
  const wanted = new Set([...artistMbids].filter(Boolean));
  return (snapshot?.releases || []).flatMap((release) => {
    const artistMbid = release.artistMbids.find((mbid) => wanted.has(mbid));
    return artistMbid
      ? [
          {
            id: release.releaseGroupMbid,
            providerId: release.releaseGroupMbid,
            artistId: artistMbid,
            artistName: release.artistName,
            artistMbid,
            foreignArtistId: artistMbid,
            mbid: release.releaseGroupMbid,
            releaseGroupMbid: release.releaseGroupMbid,
            foreignAlbumId: release.releaseGroupMbid,
            albumName: release.title,
            title: release.title,
            releaseDate: release.releaseDate,
            coverUrl: release.coverUrl,
            albumType: release.type,
            secondaryTypes: release.secondaryTypes,
            releaseStatuses: [],
            available: false,
            trackCount: 0,
            availableTrackCount: 0,
            statistics: { trackCount: 0, trackFileCount: 0, sizeOnDisk: 0, percentOfTracks: 0 },
          },
        ]
      : [];
  });
}
