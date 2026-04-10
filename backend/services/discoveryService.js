import { dbOps } from "../config/db-helpers.js";
import { GENRE_KEYWORDS } from "../config/constants.js";
import {
  lastfmRequest,
  getLastfmApiKey,
  deezerSearchArtist,
  musicbrainzGetCachedArtistMbidByName,
} from "./apiClients.js";
import { websocketService } from "./websocketService.js";

const getLastfmUsername = () => {
  const settings = dbOps.getSettings();
  return settings.integrations?.lastfm?.username || null;
};

const LASTFM_PERIODS = [
  "none",
  "7day",
  "1month",
  "3month",
  "6month",
  "12month",
  "overall",
];
const getLastfmDiscoveryPeriod = () => {
  const settings = dbOps.getSettings();
  const p = settings.integrations?.lastfm?.discoveryPeriod;
  return p && LASTFM_PERIODS.includes(p) ? p : "1month";
};

const clampInt = (value, fallback, min, max) => {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const getDiscoveryAutoRefreshHours = () => {
  const settings = dbOps.getSettings();
  return clampInt(
    settings.integrations?.lastfm?.discoveryAutoRefreshHours,
    168,
    1,
    168,
  );
};

export const getDiscoveryRecommendationsPerRefresh = () => {
  const settings = dbOps.getSettings();
  return clampInt(
    settings.integrations?.lastfm?.discoveryRecommendationsPerRefresh,
    100,
    10,
    500,
  );
};

const createLastfmHealth = () => ({
  success: 0,
  failure: 0,
});

const getLastfmFailureRatio = (health) => {
  const total = health.success + health.failure;
  if (total === 0) return 0;
  return health.failure / total;
};

const recordLastfmResult = (health, payload) => {
  if (payload && !payload.error) {
    health.success += 1;
  } else {
    health.failure += 1;
  }
};

const emitDiscoveryProgress = (
  phase,
  progressMessage,
  progress,
  extra = {},
) => {
  websocketService.emitDiscoveryUpdate({
    phase,
    progress,
    progressMessage,
    isUpdating: true,
    configured: true,
    ...extra,
  });
};

let discoveryCache = {
  recommendations: [],
  globalTop: [],
  basedOn: [],
  topTags: [],
  topGenres: [],
  lastUpdated: null,
  isUpdating: false,
};

const dbData = dbOps.getDiscoveryCache();
if (
  dbData.recommendations?.length > 0 ||
  dbData.globalTop?.length > 0 ||
  dbData.topGenres?.length > 0
) {
  discoveryCache = {
    recommendations: dbData.recommendations || [],
    globalTop: dbData.globalTop || [],
    basedOn: dbData.basedOn || [],
    topTags: dbData.topTags || [],
    topGenres: dbData.topGenres || [],
    lastUpdated: dbData.lastUpdated || null,
    isUpdating: false,
  };
}

export const getDiscoveryCache = () => {
  const dbData = dbOps.getDiscoveryCache();
  if (
    (dbData.recommendations?.length > 0 &&
      (!discoveryCache.recommendations ||
        discoveryCache.recommendations.length === 0)) ||
    (dbData.globalTop?.length > 0 &&
      (!discoveryCache.globalTop || discoveryCache.globalTop.length === 0)) ||
    (dbData.topGenres?.length > 0 &&
      (!discoveryCache.topGenres || discoveryCache.topGenres.length === 0))
  ) {
    Object.assign(discoveryCache, {
      recommendations:
        dbData.recommendations || discoveryCache.recommendations || [],
      globalTop: dbData.globalTop || discoveryCache.globalTop || [],
      basedOn: dbData.basedOn || discoveryCache.basedOn || [],
      topTags: dbData.topTags || discoveryCache.topTags || [],
      topGenres: dbData.topGenres || discoveryCache.topGenres || [],
      lastUpdated: dbData.lastUpdated || discoveryCache.lastUpdated || null,
    });
  }
  return discoveryCache;
};

export const updateDiscoveryCache = async () => {
  if (discoveryCache.isUpdating) {
    console.log("Discovery update already in progress, skipping...");
    return;
  }
  discoveryCache.isUpdating = true;
  console.log("Starting background update of discovery recommendations...");
  emitDiscoveryProgress("starting", "Preparing discovery refresh", 5);

  try {
    const { libraryManager } = await import("./libraryManager.js");
    emitDiscoveryProgress("loading_sources", "Loading library artists", 12);
    const [recentLibraryArtists, allLibraryArtistsRaw] = await Promise.all([
      libraryManager.getRecentArtists(25),
      libraryManager.getAllArtists(),
    ]);
    const allLibraryArtists = Array.isArray(allLibraryArtistsRaw)
      ? allLibraryArtistsRaw
      : [];
    const libraryArtists =
      recentLibraryArtists.length > 0
        ? recentLibraryArtists
        : allLibraryArtists.slice(0, 25);
    console.log(`Found ${allLibraryArtists.length} artists in library.`);

    const existingArtistIds = new Set(
      allLibraryArtists
        .map((a) => a.mbid || a.foreignArtistId || a.id)
        .filter(Boolean),
    );

    const hasLastfmKey = !!getLastfmApiKey();
    const lastfmHealth = createLastfmHealth();
    const lastfmUsername = getLastfmUsername();
    const hasLastfmUser = hasLastfmKey && lastfmUsername;

    if (hasLastfmKey && !lastfmUsername) {
      console.log(
        "Last.fm API key configured but username not set. User-specific recommendations will not be available.",
      );
    }

    if (allLibraryArtists.length === 0 && !hasLastfmKey) {
      console.log(
        "No artists in library and no Last.fm key. Skipping discovery and clearing cache.",
      );
      discoveryCache.recommendations = [];
      discoveryCache.globalTop = [];
      discoveryCache.basedOn = [];
      discoveryCache.topTags = [];
      discoveryCache.topGenres = [];
      discoveryCache.lastUpdated = null;
      discoveryCache.isUpdating = false;

      dbOps.updateDiscoveryCache({
        recommendations: [],
        globalTop: [],
        basedOn: [],
        topTags: [],
        topGenres: [],
        lastUpdated: null,
      });
      websocketService.emitDiscoveryUpdate({
        recommendations: [],
        globalTop: [],
        basedOn: [],
        topTags: [],
        topGenres: [],
        lastUpdated: null,
        isUpdating: false,
        configured: false,
        phase: "completed",
        progress: 100,
        progressMessage: "Discovery refresh completed",
      });
      return;
    }

    let lastfmArtists = [];
    emitDiscoveryProgress(
      "collecting_seeds",
      "Collecting recommendation seed artists",
      20,
    );
    if (hasLastfmUser) {
      const discoveryPeriod = getLastfmDiscoveryPeriod();
      if (discoveryPeriod === "none") {
        console.log(
          "Last.fm discovery period set to 'none', skipping Last.fm user top artists.",
        );
      } else {
        console.log(
          `Fetching Last.fm user top artists for ${lastfmUsername} (period: ${discoveryPeriod})...`,
        );
        try {
          const userTopArtists = await lastfmRequest("user.getTopArtists", {
            user: lastfmUsername,
            limit: 50,
            period: discoveryPeriod,
          });
          recordLastfmResult(lastfmHealth, userTopArtists);

          if (!userTopArtists) {
            console.warn(
              "Last.fm user.getTopArtists returned null - check API key and username",
            );
          } else if (userTopArtists.error) {
            console.error(
              `Last.fm API error: ${
                userTopArtists.message || userTopArtists.error
              }`,
            );
          } else if (userTopArtists?.topartists?.artist) {
            const artists = Array.isArray(userTopArtists.topartists.artist)
              ? userTopArtists.topartists.artist
              : [userTopArtists.topartists.artist];

            const artistsWithMbids = [];
            const artistsWithoutMbids = [];

            for (const artist of artists) {
              if (artist.mbid) {
                artistsWithMbids.push(artist);
              } else if (artist.name) {
                artistsWithoutMbids.push(artist);
              }
            }

            for (const artist of artistsWithMbids) {
              lastfmArtists.push({
                mbid: artist.mbid,
                artistName: artist.name,
                playcount: parseInt(artist.playcount || 0),
              });
            }

            console.log(
              `Found ${lastfmArtists.length} Last.fm artists with MBIDs.`,
            );
          } else {
            console.warn(
              `Last.fm user.getTopArtists response missing expected data structure. Response:`,
              JSON.stringify(userTopArtists).substring(0, 200),
            );
          }
        } catch (e) {
          console.error(`Failed to fetch Last.fm user artists: ${e.message}`);
          console.error(`Stack trace:`, e.stack);
        }
      }
    } else if (hasLastfmKey) {
      console.log(
        "Last.fm API key is configured but username is missing. Set Last.fm username in Settings to enable user-specific recommendations.",
      );
    }

    const allSourceArtists = [
      ...libraryArtists.map((a) => ({
        mbid: a.mbid,
        artistName: a.artistName,
        source: "library",
      })),
      ...lastfmArtists.map((a) => ({
        mbid: a.mbid,
        artistName: a.artistName,
        source: "lastfm",
      })),
    ];

    const uniqueArtists = [];
    const seenMbids = new Set();
    for (const artist of allSourceArtists) {
      if (artist.mbid && !seenMbids.has(artist.mbid)) {
        seenMbids.add(artist.mbid);
        uniqueArtists.push(artist);
      }
    }

    const tagCounts = new Map();
    const genreCounts = new Map();
    const profileSampleBase = Math.min(25, uniqueArtists.length);
    const profileFailureRatio = getLastfmFailureRatio(lastfmHealth);
    const profileSampleLimit =
      profileFailureRatio >= 0.5
        ? Math.min(8, profileSampleBase)
        : profileFailureRatio >= 0.3
          ? Math.min(14, profileSampleBase)
          : profileSampleBase;
    const profileSample = [...uniqueArtists]
      .sort(() => 0.5 - Math.random())
      .slice(0, profileSampleLimit);

    console.log(
      `Sampling tags/genres from ${profileSample.length} artists (${libraryArtists.length} library, ${lastfmArtists.length} Last.fm)...`,
    );
    emitDiscoveryProgress(
      "building_genres",
      "Building genre and tag profile",
      35,
    );

    let tagsFound = 0;
    await Promise.all(
      profileSample.map(async (artist) => {
        let foundTags = false;
        if (getLastfmApiKey()) {
          try {
            const data = await lastfmRequest("artist.getTopTags", {
              mbid: artist.mbid,
            });
            recordLastfmResult(lastfmHealth, data);
            if (data?.toptags?.tag) {
              const tags = Array.isArray(data.toptags.tag)
                ? data.toptags.tag
                : [data.toptags.tag];
              tags.slice(0, 15).forEach((t) => {
                tagCounts.set(
                  t.name,
                  (tagCounts.get(t.name) || 0) + (parseInt(t.count) || 1),
                );
                const l = t.name.toLowerCase();
                if (GENRE_KEYWORDS.some((g) => l.includes(g)))
                  genreCounts.set(t.name, (genreCounts.get(t.name) || 0) + 1);
              });
              foundTags = true;
              tagsFound++;
            }
          } catch (e) {
            console.warn(
              `Failed to get Last.fm tags for ${artist.artistName}: ${e.message}`,
            );
          }
        }
      }),
    );
    console.log(
      `Found tags for ${tagsFound} out of ${profileSample.length} artists`,
    );

    discoveryCache.topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map((t) => t[0]);
    discoveryCache.topGenres = Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map((t) => t[0]);

    console.log(
      `Identified Top Genres: ${discoveryCache.topGenres.join(", ")}`,
    );

    if (getLastfmApiKey()) {
      console.log("Fetching Global Trending (real-time style) from Last.fm...");
      emitDiscoveryProgress(
        "fetching_trending",
        "Fetching global trending artists",
        50,
      );
      try {
        const trackData = await lastfmRequest("chart.getTopTracks", {
          limit: getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 60 : 100,
        });
        recordLastfmResult(lastfmHealth, trackData);
        const seenMbids = new Set();
        const seenNames = new Set();
        const artistsFromTracks = [];
        if (trackData?.tracks?.track) {
          const tracks = Array.isArray(trackData.tracks.track)
            ? trackData.tracks.track
            : [trackData.tracks.track];
          for (const t of tracks) {
            const artist = t.artist;
            if (!artist) continue;
            const mbid = (artist.mbid && artist.mbid.trim()) || null;
            const name = artist.name || artist["#text"];
            if (!name) continue;
            if (
              (mbid && seenMbids.has(mbid)) ||
              (!mbid && seenNames.has(name.toLowerCase()))
            )
              continue;
            if (mbid) seenMbids.add(mbid);
            seenNames.add(name.toLowerCase());
            let img = null;
            if (t.image && Array.isArray(t.image)) {
              const i =
                t.image.find((im) => im.size === "extralarge") ||
                t.image.find((im) => im.size === "large");
              if (
                i &&
                i["#text"] &&
                !i["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
              )
                img = i["#text"];
            }
            artistsFromTracks.push({
              id: mbid,
              name,
              image: img,
              type: "Artist",
            });
          }
        }
        let globalTop = artistsFromTracks
          .filter((a) => !a.id || !existingArtistIds.has(a.id))
          .slice(0, 32);
        if (globalTop.length < 12) {
          const topData = await lastfmRequest("chart.getTopArtists", {
            limit: getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 60 : 100,
          });
          recordLastfmResult(lastfmHealth, topData);
          if (topData?.artists?.artist) {
            const topArtists = Array.isArray(topData.artists.artist)
              ? topData.artists.artist
              : [topData.artists.artist];
            const fromArtists = topArtists
              .map((a) => {
                let img = null;
                if (a.image && Array.isArray(a.image)) {
                  const i =
                    a.image.find((im) => im.size === "extralarge") ||
                    a.image.find((im) => im.size === "large");
                  if (
                    i &&
                    i["#text"] &&
                    !i["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
                  )
                    img = i["#text"];
                }
                return { id: a.mbid, name: a.name, image: img, type: "Artist" };
              })
              .filter((a) => a.id && !existingArtistIds.has(a.id));
            const fillMbids = new Set(
              globalTop.map((a) => a.id).filter(Boolean),
            );
            for (const a of fromArtists) {
              if (globalTop.length >= 32) break;
              if (a.id && !fillMbids.has(a.id)) {
                fillMbids.add(a.id);
                globalTop.push(a);
              }
            }
          }
        }

        const globalFailureRatio = getLastfmFailureRatio(lastfmHealth);
        const maxGlobalResolve =
          globalFailureRatio >= 0.5 ? 10 : globalFailureRatio >= 0.3 ? 18 : 30;
        for (
          let index = 0;
          index < globalTop.length && index < maxGlobalResolve;
          index++
        ) {
          const item = globalTop[index];
          if (!item?.name || item.id) continue;
          const resolvedMbid = musicbrainzGetCachedArtistMbidByName(item.name);
          if (resolvedMbid && resolvedMbid !== item.id) {
            item.navigateTo = resolvedMbid;
          }
        }

        discoveryCache.globalTop = globalTop;
        console.log(
          `Found ${discoveryCache.globalTop.length} trending artists (from top tracks).`,
        );
      } catch (e) {
        console.error(`Failed to fetch Global Top: ${e.message}`);
      }
    }

    const recFailureRatio = getLastfmFailureRatio(lastfmHealth);
    const recSampleBase = Math.min(25, uniqueArtists.length);
    const recSampleSize =
      recFailureRatio >= 0.5
        ? Math.min(8, recSampleBase)
        : recFailureRatio >= 0.3
          ? Math.min(14, recSampleBase)
          : recSampleBase;
    const recSample = [...uniqueArtists]
      .sort(() => 0.5 - Math.random())
      .slice(0, recSampleSize);
    const recommendations = new Map();

    console.log(
      `Generating recommendations based on ${recSample.length} artists (${libraryArtists.length} library, ${lastfmArtists.length} Last.fm)...`,
    );
    emitDiscoveryProgress(
      "generating_recommendations",
      "Generating personalized recommendations",
      65,
    );

    if (getLastfmApiKey()) {
      let successCount = 0;
      let errorCount = 0;
      await Promise.all(
        recSample.map(async (artist) => {
          try {
            let sourceTags = [];
            const tagData = await lastfmRequest("artist.getTopTags", {
              mbid: artist.mbid,
            });
            recordLastfmResult(lastfmHealth, tagData);
            if (tagData?.toptags?.tag) {
              const allTags = Array.isArray(tagData.toptags.tag)
                ? tagData.toptags.tag
                : [tagData.toptags.tag];
              sourceTags = allTags.slice(0, 15).map((t) => t.name);
            }

            const similar = await lastfmRequest("artist.getSimilar", {
              mbid: artist.mbid,
              limit: getLastfmFailureRatio(lastfmHealth) >= 0.3 ? 12 : 25,
            });
            recordLastfmResult(lastfmHealth, similar);
            if (similar?.similarartists?.artist) {
              const list = Array.isArray(similar.similarartists.artist)
                ? similar.similarartists.artist
                : [similar.similarartists.artist];
              for (const s of list) {
                if (
                  s.mbid &&
                  !existingArtistIds.has(s.mbid) &&
                  !recommendations.has(s.mbid)
                ) {
                  let img = null;
                  if (s.image && Array.isArray(s.image)) {
                    const i =
                      s.image.find((img) => img.size === "extralarge") ||
                      s.image.find((img) => img.size === "large");
                    if (
                      i &&
                      i["#text"] &&
                      !i["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
                    )
                      img = i["#text"];
                  }
                  recommendations.set(s.mbid, {
                    id: s.mbid,
                    name: s.name,
                    type: "Artist",
                    sourceArtist: artist.artistName,
                    sourceType: artist.source || "library",
                    tags: sourceTags,
                    score: Math.round((s.match || 0) * 100),
                    image: img,
                  });
                }
              }
              successCount++;
            } else {
              errorCount++;
            }
          } catch (e) {
            errorCount++;
            console.warn(
              `Error getting similar artists for ${artist.artistName}: ${e.message}`,
            );
          }
        }),
      );
      console.log(
        `Recommendation generation: ${successCount} succeeded, ${errorCount} failed`,
      );
    } else {
      console.warn("Last.fm API key required for similar artist discovery.");
    }

    const recommendationsPerRefresh = getDiscoveryRecommendationsPerRefresh();
    const recommendationsArray = Array.from(recommendations.values())
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, recommendationsPerRefresh);

    const recommendationFailureRatio = getLastfmFailureRatio(lastfmHealth);
    const maxResolve =
      recommendationFailureRatio >= 0.5
        ? 10
        : recommendationFailureRatio >= 0.3
          ? 18
          : 30;
    for (
      let index = 0;
      index < recommendationsArray.length && index < maxResolve;
      index++
    ) {
      const item = recommendationsArray[index];
      if (!item?.name || item.id) continue;
      const resolvedMbid = musicbrainzGetCachedArtistMbidByName(item.name);
      if (resolvedMbid && resolvedMbid !== item.id) {
        item.navigateTo = resolvedMbid;
      }
    }

    console.log(
      `Generated ${recommendationsArray.length} total recommendations.`,
    );

    const discoveryData = {
      recommendations: recommendationsArray,
      basedOn: recSample.map((a) => ({
        name: a.artistName,
        id: a.mbid,
        source: a.source || "library",
      })),
      topTags: discoveryCache.topTags || [],
      topGenres: discoveryCache.topGenres || [],
      globalTop: discoveryCache.globalTop || [],
      lastUpdated: new Date().toISOString(),
    };

    Object.assign(discoveryCache, discoveryData);
    dbOps.updateDiscoveryCache(discoveryData);
    emitDiscoveryProgress(
      "saving_results",
      "Saving refreshed discovery cache",
      82,
    );
    const { notifyDiscoveryUpdated } = await import("./notificationService.js");
    notifyDiscoveryUpdated().catch((err) =>
      console.warn("[Discovery] Notification failed:", err.message),
    );
    console.log(
      `Discovery data written to database: ${discoveryData.recommendations.length} recommendations, ${discoveryData.topGenres.length} genres, ${discoveryData.globalTop.length} trending`,
    );

    const allToHydrate = [
      ...(discoveryCache.globalTop || []),
      ...recommendationsArray,
    ].filter((a) => !a.image);
    console.log(`Hydrating images for ${allToHydrate.length} artists...`);
    emitDiscoveryProgress("hydrating_images", "Hydrating artist images", 90);

    const batchSize = 10;
    for (let i = 0; i < allToHydrate.length; i += batchSize) {
      const batch = allToHydrate.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (item) => {
          try {
            try {
              const artistName = item.name || item.artistName;

              if (artistName) {
                try {
                  const deezer = await deezerSearchArtist(artistName);
                  if (deezer?.imageUrl) {
                    item.image = deezer.imageUrl;
                  }
                } catch (e) {}
              }
            } catch (e) {}
          } catch (e) {}
        }),
      );

      if (i + batchSize < allToHydrate.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    console.log("Discovery cache updated successfully.");
    console.log(
      `Summary: ${recommendationsArray.length} recommendations, ${discoveryCache.topGenres.length} genres, ${discoveryCache.globalTop.length} trending artists`,
    );
    websocketService.emitDiscoveryUpdate({
      recommendations: discoveryData.recommendations,
      globalTop: discoveryData.globalTop,
      basedOn: discoveryData.basedOn,
      topTags: discoveryData.topTags,
      topGenres: discoveryData.topGenres,
      lastUpdated: discoveryData.lastUpdated,
      isUpdating: false,
      configured: true,
      phase: "completed",
      progress: 100,
      progressMessage: "Discovery refresh completed",
    });

    try {
      const cleaned = dbOps.cleanOldImageCache(30);
      if (cleaned?.changes > 0) {
        console.log(
          `[Discovery] Cleaned ${cleaned.changes} old image cache entries`,
        );
      }
      dbOps.cleanOldMusicbrainzArtistMbidCache(90);
    } catch (e) {
      console.warn("[Discovery] Failed to clean old image cache:", e.message);
    }
  } catch (error) {
    console.error("Failed to update discovery cache:", error.message);
    console.error("Stack trace:", error.stack);
    websocketService.emitDiscoveryUpdate({
      isUpdating: false,
      configured: true,
      phase: "error",
      progress: 100,
      progressMessage: "Discovery refresh failed",
      error: error.message,
    });
  } finally {
    discoveryCache.isUpdating = false;
  }
};
