import { UUID_REGEX } from "../../../config/constants.js";
import {
  getLastfmApiKey,
  lastfmRequest,
  musicbrainzGetArtistAppearsOnReleaseGroups,
  musicbrainzGetArtistReleaseGroups,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients.js";
import { dbOps } from "../../../config/db-helpers.js";
import { noCache } from "../../../middleware/cache.js";
import { verifyTokenAuth } from "../../../middleware/auth.js";
import {
  buildArtistRequestKey,
  sendSSE,
  pendingArtistRequests,
} from "../utils.js";
import { getArtistImage } from "../../../services/imageService.js";
import { buildImageProxyUrl } from "../../../services/imageProxyService.js";
import {
  attachCachedCoverUrls,
  resolveReleaseGroupCoversBatch,
} from "../../../services/releaseGroupCoverService.js";
import { getArtistByMbid } from "../../../services/metadataProvider.js";

export default function registerStream(router) {
  router.get("/:mbid/stream", noCache, async (req, res) => {
    try {
      const { mbid } = req.params;
      const streamArtistName = (req.query.artistName || "").trim();
      const selectedReleaseTypes =
        typeof req.query.releaseTypes === "string" &&
        req.query.releaseTypes.trim()
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
      req.on("close", () => {
        clientDisconnected = true;
      });

      const isClientConnected = () =>
        !clientDisconnected && !req.socket.destroyed;

      sendSSE(res, "connected", { mbid });

      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;
      const requestKey = buildArtistRequestKey({
        mbid,
        mode: "full",
        selectedReleaseTypes,
        appearsOnLimit,
      });
      const toLegacyRelations = (metadataArtist) =>
        Array.isArray(metadataArtist?.links)
          ? metadataArtist.links
              .filter((link) => link?.target)
              .map((link) => ({
                type: link.type || "external",
                url: { resource: link.target },
              }))
          : [];
      const getLastfmTags = async (artistMbid, artistName = "") => {
        if (!getLastfmApiKey()) return [];
        let data = await lastfmRequest("artist.getTopTags", { mbid: artistMbid }).catch(
          () => null,
        );
        if (!data?.toptags?.tag && artistName) {
          data = await lastfmRequest("artist.getTopTags", {
            artist: artistName,
          }).catch(() => null);
        }
        const tags = data?.toptags?.tag
          ? Array.isArray(data.toptags.tag)
            ? data.toptags.tag
            : [data.toptags.tag]
          : [];
        return tags
          .map((tag) => ({
            name: String(tag?.name || "").trim(),
            count: Number(tag?.count || 0),
          }))
          .filter((tag) => tag.name);
      };
      const getArtistTagPayload = async (
        artistMbid,
        artistName = "",
        metadataArtist = null,
      ) => {
        const lastfmTags = await getLastfmTags(artistMbid, artistName);
        if (lastfmTags.length > 0) {
          return {
            tags: lastfmTags,
            genres: lastfmTags.map((tag) => tag.name),
          };
        }
        const fallbackGenres = Array.isArray(metadataArtist?.genres)
          ? metadataArtist.genres.filter(Boolean)
          : [];
        return {
          tags: fallbackGenres.map((genre) => ({ name: genre, count: 0 })),
          genres: fallbackGenres,
        };
      };
      const initialName = streamArtistName || "Unknown Artist";
      const buildArtistBase = (name, metadataArtist = null) => ({
        id: resolvedMbid,
        name: metadataArtist?.name || name,
        "sort-name": metadataArtist?.sortName || metadataArtist?.name || name,
        disambiguation: metadataArtist?.disambiguation || "",
        "type-id": null,
        type: metadataArtist?.type || null,
        country: null,
        "life-span": { begin: null, end: null, ended: false },
        genres: Array.isArray(metadataArtist?.genres) ? metadataArtist.genres : [],
        links: Array.isArray(metadataArtist?.links) ? metadataArtist.links : [],
        relations: toLegacyRelations(metadataArtist),
        rating: metadataArtist?.rating || null,
        ...(metadataArtist?.overview ? { bio: metadataArtist.overview } : {}),
      });
      const sendArtist = (payload) => {
        if (!isClientConnected()) return;
        sendSSE(res, "artist", payload);
      };

      sendArtist({
        ...buildArtistBase(initialName),
        tags: [],
        genres: [],
      });

      try {
        const tasks = [];
        let fullArtistPromise = null;
        const pendingPromise = pendingArtistRequests.has(requestKey)
          ? pendingArtistRequests.get(requestKey)
          : null;
        const metadataArtistPromise = getArtistByMbid(resolvedMbid).catch(() => null);
        const namePromise = pendingPromise
          ? streamArtistName
            ? Promise.resolve(streamArtistName)
            : pendingPromise
                .then(
                  (data) => data?.name || streamArtistName || "Unknown Artist",
                )
                .catch(() => streamArtistName || "Unknown Artist")
          : (async () => {
              const metadataArtist = await metadataArtistPromise;
              if (metadataArtist?.name) return metadataArtist.name;
              if (streamArtistName) return streamArtistName;
              const name =
                (await musicbrainzGetArtistNameByMbid(resolvedMbid)) ||
                "Unknown Artist";
              return name;
            })();
        tasks.push(
          Promise.all([metadataArtistPromise, namePromise]).then(
            async ([metadataArtist, name]) => {
              if (!metadataArtist || !isClientConnected()) return;
              const tagPayload = await getArtistTagPayload(
                resolvedMbid,
                name,
                metadataArtist,
              );
              sendArtist({
                ...buildArtistBase(name, metadataArtist),
                tags: tagPayload.tags,
                genres: tagPayload.genres,
              });
            },
          ),
        );

        const libraryTask = (async () => {
          const { lidarrClient } =
            await import("../../../services/lidarrClient.js");
          const { libraryManager } =
            await import("../../../services/libraryManager.js");

          if (!lidarrClient.isConfigured()) return;

          try {
            const lidarrArtist = await lidarrClient.getArtistByMbid(mbid);
            if (!lidarrArtist) {
              if (isClientConnected()) {
                sendSSE(res, "library", {
                  exists: false,
                  artist: null,
                  albums: [],
                });
              }
              return;
            }
            if (!isClientConnected()) return;

            console.log(
              `[Artists Stream] Found artist in Lidarr: ${lidarrArtist.artistName}`,
            );
            const metadataArtist = await metadataArtistPromise;

            sendArtist({
              ...buildArtistBase(lidarrArtist.artistName, metadataArtist),
              _lidarrData: {
                id: lidarrArtist.id,
                monitored: lidarrArtist.monitored,
                statistics: lidarrArtist.statistics,
              },
            });

            const libArtist = libraryManager.mapLidarrArtist(lidarrArtist);
            sendSSE(res, "library", {
              exists: true,
              artist: {
                ...libArtist,
                foreignArtistId: libArtist.foreignArtistId || libArtist.mbid,
                added: libArtist.addedAt,
              },
              albums: [],
            });

            const lidarrAlbums = await libraryManager.getAlbums(
              libArtist.id,
              lidarrArtist,
            );

            if (!isClientConnected()) return;

            sendSSE(res, "library", {
              exists: true,
              artist: {
                ...libArtist,
                foreignArtistId: libArtist.foreignArtistId || libArtist.mbid,
                added: libArtist.addedAt,
              },
              albums: lidarrAlbums.map((a) => ({
                ...a,
                foreignAlbumId: a.foreignAlbumId || a.mbid,
                title: a.albumName,
                albumType: "Album",
                statistics: a.statistics || {
                  trackCount: 0,
                  sizeOnDisk: 0,
                  percentOfTracks: 0,
                },
              })),
            });
          } catch (error) {
            console.warn(
              `[Artists Stream] Failed to fetch from Lidarr: ${error.message}`,
            );
          }
        })();
        tasks.push(libraryTask);

        if (pendingPromise) {
          console.log(
            `[Artists Stream] Request for ${requestKey} already in progress, waiting...`,
          );
          pendingPromise
            .then((data) => {
              if (data) sendArtist(data);
            })
            .catch((error) => {
              sendSSE(res, "error", {
                error: "Failed to fetch artist details",
                message: error.response?.data?.error || error.message,
              });
            });
          tasks.push(pendingPromise.catch(() => null));
        }

        if (!pendingPromise) {
          const includeTrackCounts = !appearsOnLimit;
          const releaseGroupsPromise = musicbrainzGetArtistReleaseGroups(
            resolvedMbid,
            selectedReleaseTypes,
            { includeTrackCounts },
          ).catch(() => []);
          const discographyTask = Promise.all([
            metadataArtistPromise,
            namePromise,
            releaseGroupsPromise,
          ]).then(async ([metadataArtist, name, releaseGroups]) => {
            if (!isClientConnected()) return null;
            const releaseGroupsWithCovers = attachCachedCoverUrls(
              releaseGroups,
              12,
            );
            sendArtist({
              ...buildArtistBase(name, metadataArtist),
              "release-groups": releaseGroupsWithCovers,
              "release-group-count": releaseGroupsWithCovers.length,
              "release-count": releaseGroupsWithCovers.length,
            });
            const prefetchItems = releaseGroupsWithCovers
              .filter((releaseGroup) => releaseGroup?.id && !releaseGroup.coverUrl)
              .slice(0, 6)
              .map((releaseGroup) => ({
                mbid: releaseGroup.id,
                artistName: name || "",
                albumTitle: releaseGroup.title || "",
              }));
            if (prefetchItems.length) {
              resolveReleaseGroupCoversBatch(prefetchItems, {
                concurrency: 6,
              }).catch(() => {});
            }
            return { metadataArtist, name, releaseGroups: releaseGroupsWithCovers };
          });
          tasks.push(discographyTask);

          const appearsOnTask = discographyTask.then(async (ctx) => {
            if (!ctx) return [];
            const appearsOnReleaseGroups =
              await musicbrainzGetArtistAppearsOnReleaseGroups(
                resolvedMbid,
                ctx.releaseGroups,
                { limit: appearsOnLimit },
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
            const prefetchAppearsOnItems = [...appearsOnWithCovers]
              .sort((a, b) =>
                String(b["first-release-date"] || "").localeCompare(
                  String(a["first-release-date"] || ""),
                ),
              )
              .filter(
                (releaseGroup) => releaseGroup?.id && !releaseGroup.coverUrl,
              )
              .slice(0, appearsOnLimit || 6)
              .map((releaseGroup) => ({
                mbid: releaseGroup.id,
                artistName:
                  releaseGroup["artist-credit"]?.[0]?.name ||
                  releaseGroup["artist-credit"]?.[0]?.artist?.name ||
                  "",
                albumTitle: releaseGroup.title || "",
              }));
            if (prefetchAppearsOnItems.length) {
              resolveReleaseGroupCoversBatch(prefetchAppearsOnItems, {
                concurrency: 6,
              }).catch(() => {});
            }
            return appearsOnWithCovers;
          });
          tasks.push(appearsOnTask);

          const metadataCorePromise = Promise.all([
            discographyTask,
            appearsOnTask,
          ]).then(async ([ctx, appearsOnReleaseGroups]) => {
            if (!ctx) return null;
            const tagPayload = await getArtistTagPayload(
              resolvedMbid,
              ctx.name,
              ctx.metadataArtist,
            );
            return {
              ...buildArtistBase(ctx.name, ctx.metadataArtist),
              tags: tagPayload.tags,
              genres: tagPayload.genres,
              "release-groups": ctx.releaseGroups,
              "appears-on-release-groups": appearsOnReleaseGroups,
              "release-group-count": ctx.releaseGroups.length,
              "release-count": ctx.releaseGroups.length,
            };
          });

          fullArtistPromise = metadataCorePromise
            .then((artistPayload) => artistPayload)
            .catch(() => null);

          pendingArtistRequests.set(requestKey, fullArtistPromise);
          fullArtistPromise.finally(() => {
            pendingArtistRequests.delete(requestKey);
          });

        }
        const coverTask = (async () => {
          if (!isClientConnected()) return;
          try {
            const cachedImage = dbOps.getImage(mbid);
            if (
              cachedImage &&
              cachedImage.imageUrl &&
              cachedImage.imageUrl !== "NOT_FOUND"
            ) {
              const artistName =
                (await namePromise.catch(() => null)) || streamArtistName || null;
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

            const artistName =
              (await namePromise.catch(() => null)) || streamArtistName || null;
            const shouldForceRefresh =
              cachedImage?.imageUrl === "NOT_FOUND" && !!artistName;
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
              });

              if (!similarData?.similarartists?.artist) {
                const fallbackArtistName =
                  streamArtistName ||
                  (await metadataArtistPromise.catch(() => null))?.name ||
                  (await namePromise.catch(() => null)) ||
                  (await musicbrainzGetArtistNameByMbid(resolvedMbid).catch(
                    () => null,
                  )) ||
                  "";

                if (fallbackArtistName) {
                  similarData = await lastfmRequest("artist.getSimilar", {
                    artist: fallbackArtistName,
                    limit: 10,
                  });
                }
              }

              if (similarData?.similarartists?.artist) {
                const artists = Array.isArray(similarData.similarartists.artist)
                  ? similarData.similarartists.artist
                  : [similarData.similarartists.artist];

                const formattedArtists = artists
                  .map((a) => {
                    let img = null;
                    if (a.image && Array.isArray(a.image)) {
                      const i =
                        a.image.find((img) => img.size === "extralarge") ||
                        a.image.find((img) => img.size === "large");
                      if (
                        i &&
                        i["#text"] &&
                        !i["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
                      )
                        img = i["#text"];
                    }
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
        console.error(
          `[Artists Stream] Error for artist ${mbid}:`,
          error.message,
        );
        sendSSE(res, "error", {
          error: "Failed to fetch artist details",
          message: error.response?.data?.error || error.message,
        });
        res.end();
      }
    } catch (error) {
      console.error(`[Artists Stream] Unexpected error:`, error.message);
      res.status(500).json({
        error: "Failed to stream artist details",
        message: error.message,
      });
    }
  });
}
