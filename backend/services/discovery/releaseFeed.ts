import { FACTORY_MONITOR_RULES, releaseMatchesRules } from "../monitoring.ts";
import { withCoverUrls } from "../releaseGroupCoverService.ts";
import { getFreshReleasesByArtists } from "./freshReleases.ts";
import { getRecentMissingReleases, toDay, type ReleaseWindow } from "./recentReleases.ts";
import { getUserDiscovery } from "./userDiscovery.ts";

type RecommendedRelease = ReturnType<typeof getFreshReleasesByArtists>[number];

const recommendedReleases = (userId: number | null) => {
  const ids = getUserDiscovery(userId, 0).body.recommendations.map(({ id }) => id);
  return ids.length
    ? getFreshReleasesByArtists(ids).filter((release) =>
        releaseMatchesRules(
          {
            id: release.mbid,
            type: release.albumType,
            secondaryTypes: release.secondaryTypes,
            releaseStatuses: [],
            firstReleaseDate: release.releaseDate,
          },
          FACTORY_MONITOR_RULES,
        ),
      )
    : [];
};

const month = (releaseDate: string) => releaseDate.slice(0, 7);

async function releasesIn(
  when: ReleaseWindow,
  count: number,
  recommended: RecommendedRelease[],
  now: number,
) {
  const fromLibrary = await getRecentMissingReleases(count + 1, { when, now });
  const libraryIds = new Set(fromLibrary.map((album) => album.mbid));
  const today = toDay(now);
  const fromRecommendations = recommended.filter(
    ({ mbid, releaseDate }) =>
      !libraryIds.has(mbid) && (when === "upcoming" ? releaseDate > today : releaseDate <= today),
  );
  const direction = when === "upcoming" ? 1 : -1;
  return [...fromLibrary, ...fromRecommendations].sort(
    (left, right) =>
      direction * month(left.releaseDate).localeCompare(month(right.releaseDate)) ||
      Number(libraryIds.has(right.mbid)) - Number(libraryIds.has(left.mbid)) ||
      direction * left.releaseDate.localeCompare(right.releaseDate),
  );
}

export async function getReleaseFeed({
  userId,
  when,
  offset = 0,
  limit,
  now = Date.now(),
}: {
  userId: number | null;
  when: ReleaseWindow;
  offset?: number;
  limit: number;
  now?: number;
}) {
  const end = offset + limit;
  const releases = await releasesIn(when, end, recommendedReleases(userId), now);
  return { releases: withCoverUrls(releases.slice(offset, end)), hasMore: releases.length > end };
}

export async function getReleaseRail({
  userId,
  limit,
  now = Date.now(),
}: {
  userId: number | null;
  limit: number;
  now?: number;
}) {
  const recommended = recommendedReleases(userId);
  const released = (await releasesIn("released", limit, recommended, now)).slice(0, limit);
  const upcoming =
    released.length < limit
      ? await releasesIn("upcoming", limit - released.length, recommended, now)
      : [];
  return withCoverUrls([...released, ...upcoming].slice(0, limit));
}
