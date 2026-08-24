import { UUID_REGEX } from "../../../../lib/uuid.js";
import {
  getLastfmApiKey,
  lastfmRequest,
  musicbrainzGetArtistAppearsOnReleaseGroups,
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients/index.js";
import { dbOps } from "../../../db/helpers/index.js";
import { noCache } from "../../../middleware/cache.js";
import { verifyTokenAuth } from "../../../middleware/auth.js";
import { sendSSE } from "../utils.js";
import { logger } from "../../../services/logger.js";
import { getArtistImage } from "../../../services/imageService.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import {
  attachCachedCoverUrls,
} from "../../../services/releaseGroupCoverService.js";
import { getArtistLibraryLookup } from "../../library/handlers/misc.js";
import { getArtistByMbid } from "../../../services/providers/brainzmashProvider.js";
import {
  getArtistTagPayload,
  buildArtistBase,
  extractLastfmImageUrl,
} from "../shared/transform.js";

export function registerStream(router) {
  router.get("/:mbid/stream", noCache, async (req, res) => {
    try {
      const { mbid } = req.params;
      const streamArtistName = (req.query.artistName || "").trim();
      const selectedReleaseTypes =
        typeof req.query.releaseTypes === "string" && req.query.releaseTypes.trim()
          ? req.query.releaseTypes
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : null;
      const parsedAppearsOnLimit = Number.parseInt(req.query.appearsOnLimit, 10);
      const appearsOnLimit =
        Number.isFinite(parsedAppearsOnLimit) && parsedAppearsOnLimit > 0
          ? parsedAppearsOnLimit
          : null;

      if (!UUID_REGEX.test(mbid)) {
        return res.status(400).json({
          error: "Invalid MBID format",
          message: `"${mbid}" is not a valid MusicBrainz ID. MBIDs must be UUIDs.`,
        });
      }

      if (!verifyTokenAuth(req)) {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required",
        });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      let clientDisconnected = false;
      const requestController = new AbortController();
      req.on("close", () => {
        clientDisconnected = true;
        requestController.abort();
      });

      const isClientConnected = () => !clientDisconnected && !req.socket.destroyed;

      sendSSE(res, "connected", { mbid });

      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;
      const initialName = streamArtistName || "Unknown Artist";
      const sendArtist = (payload) => {
        if (!isClientConnected()) return;
        sendSSE(res, "artist", payload);
      };

      sendArtist({
        ...buildArtistBase(initialName, resolvedMbid),
        tags: [],
        genres: [],
      });

      try {
        const tasks = [];
        const metadataArtistPromise = getArtistByMbid(resolvedMbid, {
          signal: requestController.signal,
        }).catch(() => null);
        const namePromise = (async () => {
          const metadataArtist = await metadataArtistPromise;
          if (metadataArtist?.name) return metadataArtist.name;
          if (streamArtistName) return streamArtistName;
          const name =
            (await musicbrainzGetArtistNameByMbid(resolvedMbid, {
              signal: requestController.signal,
            })) || "Unknown Artist";
          return name;
        })();
        tasks.push(
          Promise.all([metadataArtistPromise, namePromise]).then(async ([metadataArtist, name]) => {
            if (!metadataArtist || !isClientConnected()) return;
            const tagPayload = await getArtistTagPayload(resolvedMbid, name, metadataArtist);
            sendArtist({
              ...buildArtistBase(name, resolvedMbid, metadataArtist),
              tags: tagPayload.tags,
              genres: tagPayload.genres,
            });
          }),
        );

        const libraryTask = (async () => {
          const lookup = await getArtistLibraryLookup(mbid);
          if (isClientConnected()) sendSSE(res, "library", lookup);
        })();
        tasks.push(libraryTask);

        {
          const includeTrackCounts = false;
          const releaseGroupsPromise = musicbrainzGetArtistReleaseGroups(
            resolvedMbid,
            selectedReleaseTypes,
            {
              includeTrackCounts,
              hydrateLimit: appearsOnLimit ? 6 : 0,
              signal: requestController.signal,
            },
          ).catch(() => []);
          const discographyTask = Promise.all([
            metadataArtistPromise,
            namePromise,
            releaseGroupsPromise,
          ]).then(async ([metadataArtist, name, releaseGroups]) => {
            if (!isClientConnected()) return null;
            const releaseGroupsWithCovers = attachCachedCoverUrls(releaseGroups, 12);
            sendArtist({
              ...buildArtistBase(name, resolvedMbid, metadataArtist),
              "release-groups": releaseGroupsWithCovers,
              "release-group-count": releaseGroupsWithCovers.length,
              "release-count": releaseGroupsWithCovers.length,
            });
            return { metadataArtist, name, releaseGroups: releaseGroupsWithCovers };
          });
          tasks.push(discographyTask);

          const appearsOnTask = discographyTask.then(async (ctx) => {
            if (!ctx || !isClientConnected()) return [];
            const appearsOnReleaseGroups = await musicbrainzGetArtistAppearsOnReleaseGroups(
              resolvedMbid,
              ctx.releaseGroups,
              { limit: appearsOnLimit, signal: requestController.signal },
            ).catch(() => []);
            if (!isClientConnected()) return appearsOnReleaseGroups;
            const appearsOnWithCovers = attachCachedCoverUrls(
              appearsOnReleaseGroups,
              appearsOnLimit || 6,
            );
            sendArtist({
              id: resolvedMbid,
              "appears-on-release-groups": appearsOnWithCovers,
            });
            return appearsOnWithCovers;
          });
          tasks.push(appearsOnTask);

        }
        const coverTask = (async () => {
          if (!isClientConnected()) return;
          try {
            const cachedImage = dbOps.getImage(mbid);
            if (cachedImage && cachedImage.imageUrl && cachedImage.imageUrl !== "NOT_FOUND") {
              const artistName = (await namePromise.catch(() => null)) || streamArtistName || null;
              if (!isClientConnected()) return;
              const cachedCover = await getArtistImage(mbid, {
                artistName,
              }).catch(() => null);
              sendSSE(res, "cover", {
                images: cachedCover?.images?.length
                  ? cachedCover.images
                  : [
                      {
                        image: cachedImage.imageUrl,
                        front: true,
                        types: ["Front"],
                      },
                    ],
              });
              return;
            }

            const artistName = (await namePromise.catch(() => null)) || streamArtistName || null;
            if (!isClientConnected()) return;
            const negativeCacheIsFresh =
              cachedImage?.imageUrl === "NOT_FOUND" &&
              cachedImage.cacheAge &&
              Date.now() - cachedImage.cacheAge < 7 * 24 * 60 * 60 * 1000;
            if (negativeCacheIsFresh) {
              sendSSE(res, "cover", { images: [] });
              return;
            }
            const shouldForceRefresh = cachedImage?.imageUrl === "NOT_FOUND";
            const cover = await getArtistImage(mbid, {
              artistName,
              forceRefresh: shouldForceRefresh,
            });
            if (cover?.images?.length) {
              sendSSE(res, "cover", {
                images: cover.images,
              });
              return;
            }

            if (cover?.notFound) {
              dbOps.setImage(mbid, "NOT_FOUND");
            }
            sendSSE(res, "cover", { images: [] });
          } catch (e) {
            sendSSE(res, "cover", { images: [] });
          }
        })();
        tasks.push(coverTask);

        const similarTask = (async () => {
          if (!isClientConnected()) return;
          if (getLastfmApiKey()) {
            try {
              let similarData = await lastfmRequest("artist.getSimilar", {
                mbid: resolvedMbid,
                limit: 10,
              }, { signal: requestController.signal });

              if (!isClientConnected()) return;

              if (!similarData?.similarartists?.artist) {
                const fallbackArtistName =
                  streamArtistName ||
                  (await metadataArtistPromise.catch(() => null))?.name ||
                  (await namePromise.catch(() => null)) ||
                  (await musicbrainzGetArtistNameByMbid(resolvedMbid, {
                    signal: requestController.signal,
                  }).catch(() => null)) ||
                  "";

                if (fallbackArtistName) {
                  similarData = await lastfmRequest("artist.getSimilar", {
                    artist: fallbackArtistName,
                    limit: 10,
                  }, { signal: requestController.signal });
                }
              }

              if (similarData?.similarartists?.artist) {
                const artists = Array.isArray(similarData.similarartists.artist)
                  ? similarData.similarartists.artist
                  : [similarData.similarartists.artist];

                const formattedArtists = artists
                  .map((a) => {
                    const img = extractLastfmImageUrl(a.image);
                    return {
                      id: a.mbid,
                      name: a.name,
                      image: buildImageProxyUrl(img) || img,
                      match: Math.round((a.match || 0) * 100),
                    };
                  })
                  .filter((a) => a.id);

                sendSSE(res, "similar", { artists: formattedArtists });
              } else {
                sendSSE(res, "similar", { artists: [] });
              }
            } catch (e) {
              sendSSE(res, "similar", { artists: [] });
            }
          } else {
            sendSSE(res, "similar", { artists: [] });
          }
        })();
        tasks.push(similarTask);

        Promise.allSettled(tasks)
          .then(() => {
            sendSSE(res, "complete", {});
          })
          .catch(() => {
            sendSSE(res, "complete", {});
          })
          .finally(() => {
            setTimeout(() => {
              res.end();
            }, 100);
          });
      } catch (error) {
        logger.error("stream", `Error for artist ${mbid}:`, { message: error.message });
        sendSSE(res, "error", {
          error: "Failed to fetch artist details",
          message: error.response?.data?.error || error.message,
        });
        res.end();
      }
    } catch (error) {
      logger.error("stream", `Unexpected error:`, { message: error.message });
      res.status(500).json({
        error: "Failed to stream artist details",
        message: error.message,
      });
    }
  });
}
