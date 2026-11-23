import { getFreshReleases } from "../providers/metadataProvider.ts";

const FRESH_RELEASES_TTL_MS = 6 * 60 * 60 * 1000;
const FRESH_RELEASES_RETRY_MS = 15 * 60 * 1000;
const SNAPSHOT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type FreshRelease = Awaited<ReturnType<typeof getFreshReleases>>[number];

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

let snapshot: { fetchedAt: number; releases: FreshRelease[] } | null = null;
let refreshing: Promise<void> | null = null;

export async function fetchFreshReleases(days: number) {
  const now = Date.now();
  const from = dayOf(now - days * DAY_MS);
  const to = dayOf(now + days * DAY_MS);
  return (await getFreshReleases()).filter(
    (release) => release.releaseDate >= from && release.releaseDate <= to,
  );
}

export function refreshFreshReleases() {
  refreshing ??= fetchFreshReleases(SNAPSHOT_DAYS)
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

const isStale = () => !snapshot || Date.now() - snapshot.fetchedAt >= FRESH_RELEASES_TTL_MS;

export async function loadFreshReleasesByArtists(artistMbids: Iterable<string | null | undefined>) {
  if (isStale()) await refreshFreshReleases();
  return getFreshReleasesByArtists(artistMbids);
}

export function getFreshReleasesByArtists(artistMbids: Iterable<string | null | undefined>) {
  if (isStale()) void refreshFreshReleases();
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
