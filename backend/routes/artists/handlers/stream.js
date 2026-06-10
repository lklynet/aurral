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
        "release-groups": [],
        "release-group-count": 0,
        "release-count": 0,
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
          const releaseGroupsPromise = musicbrainzGetArtistReleaseGroups(
            resolvedMbid,
            selectedReleaseTypes,
          ).catch(() => []);
          const metadataCorePromise = Promise.all([
            metadataArtistPromise,
            namePromise,
            releaseGroupsPromise,
          ]).then(async ([metadataArtist, name, releaseGroups]) => {
            const appearsOnReleaseGroups =
              await musicbrainzGetArtistAppearsOnReleaseGroups(
                resolvedMbid,
                releaseGroups,
                { limit: appearsOnLimit },
              ).catch(() => []);
            const tagPayload = await getArtistTagPayload(
              resolvedMbid,
              name,
              metadataArtist,
            );
            return {
              ...buildArtistBase(name, metadataArtist),
              tags: tagPayload.tags,
              genres: tagPayload.genres,
              "release-groups": releaseGroups,
              "appears-on-release-groups": appearsOnReleaseGroups,
              "release-group-count": releaseGroups.length,
              "release-count": releaseGroups.length,
            };
          });

          tasks.push(
            metadataCorePromise.then((artistPayload) => {
              if (!isClientConnected()) return;
              sendArtist(artistPayload);
            }),
          );

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
            const cover = await getArtistImage(mbid, {
              artistName,
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
