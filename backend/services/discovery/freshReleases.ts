import { listenbrainzRequest } from "../apiClients/index.ts";

const FRESH_RELEASES_TTL_MS = 6 * 60 * 60 * 1000;
const FRESH_RELEASES_RETRY_MS = 15 * 60 * 1000;
const FRESH_RELEASE_TYPES = new Set(["Album", "EP", "Single"]);

type ListenbrainzFreshRelease = {
  artist_credit_name?: string | null;
  artist_mbids?: string[] | null;
  release_date?: string | null;
  release_group_mbid?: string | null;
  release_group_primary_type?: string | null;
  release_name?: string | null;
};

const slim = (release: ListenbrainzFreshRelease) => {
  const releaseGroupMbid = release.release_group_mbid?.trim();
  const title = release.release_name?.trim();
  const type = release.release_group_primary_type || "";
  const artistMbids = (release.artist_mbids || []).filter(Boolean);
  return releaseGroupMbid && title && release.release_date && FRESH_RELEASE_TYPES.has(type)
    ? [
        {
          releaseGroupMbid,
          title,
          type,
          artistMbids,
          artistName: release.artist_credit_name?.trim() || "Unknown Artist",
          releaseDate: release.release_date,
        },
      ]
    : [];
};

let snapshot: { fetchedAt: number; releases: ReturnType<typeof slim> } | null = null;
let refreshing: Promise<void> | null = null;

export function refreshFreshReleases() {
  refreshing ??= listenbrainzRequest(
    "/1/explore/fresh-releases/",
    { days: 30, past: "true", future: "true" },
    { timeoutMs: 30_000 },
  )
    .then((data: { payload?: { releases?: ListenbrainzFreshRelease[] } } | null) => {
      snapshot = { fetchedAt: Date.now(), releases: (data?.payload?.releases || []).flatMap(slim) };
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
            albumType: release.type,
            secondaryTypes: [],
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
