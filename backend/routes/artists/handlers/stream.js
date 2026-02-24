import axios from "axios";
import { UUID_REGEX } from "../../../config/constants.js";
import {
  getLastfmApiKey,
  lastfmRequest,
  lastfmGetArtistNameByMbid,
  getArtistBio,
  musicbrainzGetArtistReleaseGroups,
  enrichReleaseGroupsWithDeezer,
  enrichReleaseGroupsWithLastfm,
  deezerSearchArtist,
  getDeezerArtistById,
  musicbrainzGetArtistNameByMbid,
} from "../../../services/apiClients.js";
import { dbOps } from "../../../config/db-helpers.js";
import { noCache } from "../../../middleware/cache.js";
import { verifyTokenAuth } from "../../../middleware/auth.js";
import { sendSSE, pendingArtistRequests } from "../utils.js";

export default function registerStream(router) {
  router.get("/:mbid/stream", noCache, async (req, res) => {
    try {
      const { mbid } = req.params;
      const streamArtistName = (req.query.artistName || "").trim();

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

      let artistData = null;
      const override = dbOps.getArtistOverride(mbid);
      const resolvedMbid = override?.musicbrainzId || mbid;
      const deezerArtistId = override?.deezerArtistId || null;

      try {
        const { libraryManager } =
          await import("../../../services/libraryManager.js");

        let lidarrArtist = null;
        let lidarrAlbums = [];

        try {
          lidarrArtist = await libraryManager.getArtist(mbid);
          if (lidarrArtist) {
            console.log(
              `[Artists Stream] Found artist in Lidarr: ${lidarrArtist.artistName}`,
            );
            lidarrAlbums = await libraryManager.getAlbums(lidarrArtist.id);

            const artistMbid =
              override?.musicbrainzId || lidarrArtist.foreignArtistId || mbid;
            let releaseGroups = [];
            try {
              releaseGroups = await musicbrainzGetArtistReleaseGroups(artistMbid);
              await enrichReleaseGroupsWithDeezer(
                releaseGroups,
                lidarrArtist.artistName,
                deezerArtistId,
              );
              if (getLastfmApiKey()) {
                await enrichReleaseGroupsWithLastfm(
                  releaseGroups,
                  lidarrArtist.artistName,
                  artistMbid,
                );
              }
            } catch (e) {
              releaseGroups = lidarrAlbums.map((album) => ({
                id: album.mbid,
                title: album.albumName,
                "first-release-date": album.releaseDate || null,
                "primary-type": "Album",
                "secondary-types": [],
              }));
            }
            const mbidToType = new Map(
              releaseGroups.map((rg) => [rg.id, rg["primary-type"]]),
            );

            const [bio, tagsData] = await Promise.all([
              getArtistBio(
                lidarrArtist.artistName,
                artistMbid,
                deezerArtistId,
              ),
              getLastfmApiKey()
                ? lastfmRequest("artist.getTopTags", { mbid: artistMbid })
                : null,
            ]);
            const tags = tagsData?.toptags?.tag
              ? (Array.isArray(tagsData.toptags.tag)
                  ? tagsData.toptags.tag
                  : [tagsData.toptags.tag]
                ).map((t) => ({ name: t.name, count: t.count || 0 }))
              : [];
            artistData = {
              id: artistMbid,
              name: lidarrArtist.artistName,
              "sort-name": lidarrArtist.artistName,
              disambiguation: "",
              "type-id": null,
              type: null,
              country: null,
              "life-span": {
                begin: null,
                end: null,
                ended: false,
              },
              tags,
              genres: [],
              "release-groups": releaseGroups,
              relations: [],
              "release-group-count": releaseGroups.length,
              "release-count": releaseGroups.length,
              _lidarrData: {
                id: lidarrArtist.id,
                monitored: lidarrArtist.monitored,
                statistics: lidarrArtist.statistics,
              },
              ...(bio ? { bio } : {}),
            };

            sendSSE(res, "artist", artistData);

            const libArtist = lidarrArtist;
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
                albumType:
                  mbidToType.get(a.mbid || a.foreignAlbumId) || "Album",
                statistics: a.statistics || {
                  trackCount: 0,
                  sizeOnDisk: 0,
                  percentOfTracks: 0,
                },
              })),
            });
          }
        } catch (error) {
          console.warn(
            `[Artists Stream] Failed to fetch from Lidarr: ${error.message}`,
          );
        }

        if (!artistData) {
          if (pendingArtistRequests.has(mbid)) {
            if (streamArtistName) {
              sendSSE(res, "artist", {
                id: resolvedMbid,
                name: streamArtistName,
                "sort-name": streamArtistName,
                disambiguation: "",
                "type-id": null,
                type: null,
                country: null,
                "life-span": { begin: null, end: null, ended: false },
                tags: [],
                genres: [],
                "release-groups": [],
                relations: [],
                "release-group-count": 0,
                "release-count": 0,
              });
            }
            console.log(
              `[Artists Stream] Request for ${mbid} already in progress, waiting...`,
            );
            try {
              artistData = await pendingArtistRequests.get(mbid);
              sendSSE(res, "artist", artistData);
            } catch (error) {
              sendSSE(res, "error", {
                error: "Failed to fetch artist details",
                message: error.response?.data?.error || error.message,
              });
              return;
            }
          } else {
            const fetchPromise = (async () => {
              const name =
                streamArtistName ||
                (getLastfmApiKey()
                  ? await lastfmGetArtistNameByMbid(resolvedMbid)
                  : null) ||
                (await musicbrainzGetArtistNameByMbid(resolvedMbid)) ||
                "Unknown Artist";
              const tagsData = getLastfmApiKey()
                ? await lastfmRequest("artist.getTopTags", {
                    mbid: resolvedMbid,
                  })
                : null;
              const tags = tagsData?.toptags?.tag
                ? (Array.isArray(tagsData.toptags.tag)
                    ? tagsData.toptags.tag
                    : [tagsData.toptags.tag]
                  ).map((t) => ({ name: t.name, count: t.count || 0 }))
                : [];
              const releaseGroups =
                await musicbrainzGetArtistReleaseGroups(resolvedMbid);
              await enrichReleaseGroupsWithDeezer(
                releaseGroups,
                name,
                deezerArtistId,
              );
              if (getLastfmApiKey()) {
                await enrichReleaseGroupsWithLastfm(
                  releaseGroups,
                  name,
                  resolvedMbid,
                );
              }
              const bio = await getArtistBio(
                name,
                resolvedMbid,
                deezerArtistId,
              );
              return {
                id: resolvedMbid,
                name,
                "sort-name": name,
                disambiguation: "",
                "type-id": null,
                type: null,
                country: null,
                "life-span": { begin: null, end: null, ended: false },
                tags,
                genres: [],
                "release-groups": releaseGroups,
                relations: [],
                "release-group-count": releaseGroups.length,
                "release-count": releaseGroups.length,
                bio: bio || undefined,
              };
            })();
            pendingArtistRequests.set(mbid, fetchPromise);
            if (streamArtistName) {
              sendSSE(res, "artist", {
                id: resolvedMbid,
                name: streamArtistName,
                "sort-name": streamArtistName,
                disambiguation: "",
                "type-id": null,
                type: null,
                country: null,
                "life-span": { begin: null, end: null, ended: false },
                tags: [],
                genres: [],
                "release-groups": [],
                relations: [],
                "release-group-count": 0,
                "release-count": 0,
              });
            }
            try {
              artistData = await fetchPromise;
              sendSSE(res, "artist", artistData);
            } catch (err) {
              const fallback = {
                id: resolvedMbid,
                name: streamArtistName || "Unknown Artist",
                "sort-name": streamArtistName || "Unknown Artist",
                disambiguation: "",
                "type-id": null,
                type: null,
                country: null,
                "life-span": { begin: null, end: null, ended: false },
                tags: [],
                genres: [],
                "release-groups": [],
                relations: [],
                "release-group-count": 0,
                "release-count": 0,
              };
              artistData = fallback;
              sendSSE(res, "artist", fallback);
            } finally {
              pendingArtistRequests.delete(mbid);
            }
          }
        }

        const criticalTasks = [];
        const nonCriticalTasks = [];

        const coverTask = (async () => {
          if (!isClientConnected()) return;
          try {
            const artistName = artistData?.name || streamArtistName || null;

            const cachedImage = dbOps.getImage(mbid);
            if (
              cachedImage &&
              cachedImage.imageUrl &&
              cachedImage.imageUrl !== "NOT_FOUND"
            ) {
              sendSSE(res, "cover", {
                images: [
                  {
                    image: cachedImage.imageUrl,
                    front: true,
                    types: ["Front"],
                  },
                ],
              });
              return;
            }

            if (artistName) {
              try {
                const deezer = deezerArtistId
                  ? await getDeezerArtistById(deezerArtistId)
                  : await deezerSearchArtist(artistName);
                if (deezer?.imageUrl) {
                  dbOps.setImage(mbid, deezer.imageUrl);
                  sendSSE(res, "cover", {
                    images: [
                      { image: deezer.imageUrl, front: true, types: ["Front"] },
                    ],
                  });
                  return;
                }
              } catch (e) {}
            }

            dbOps.setImage(mbid, "NOT_FOUND");
            sendSSE(res, "cover", { images: [] });
          } catch (e) {
            sendSSE(res, "cover", { images: [] });
          }
        })();
        criticalTasks.push(coverTask);

        const similarTask = (async () => {
          if (!isClientConnected()) return;
          if (getLastfmApiKey()) {
            try {
              const similarData = await lastfmRequest("artist.getSimilar", {
                mbid: resolvedMbid,
                limit: 10,
              });

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
                      image: img,
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
        criticalTasks.push(similarTask);

        const releaseGroupCoversTask = (async () => {
          if (!isClientConnected()) return;
          if (artistData?.["release-groups"]?.length === 0) return;
          const releaseGroups = (artistData["release-groups"] || [])
            .filter(
              (rg) =>
                rg["primary-type"] === "Album" ||
                rg["primary-type"] === "EP" ||
                rg["primary-type"] === "Single",
            )
            .slice(0, 20);

          const cacheKeys = releaseGroups.map((rg) => `rg:${rg.id}`);
          const cachedCovers = dbOps.getImages(cacheKeys);

          for (const rg of releaseGroups) {
            if (!isClientConnected()) return;
            const cacheKey = `rg:${rg.id}`;
            const cachedCover = cachedCovers[cacheKey];
            if (rg._coverUrl) {
              dbOps.setImage(cacheKey, rg._coverUrl);
              sendSSE(res, "releaseGroupCover", {
                mbid: rg.id,
                images: [
                  { image: rg._coverUrl, front: true, types: ["Front"] },
                ],
              });
              continue;
            }
            if (
              cachedCover &&
              cachedCover.imageUrl &&
              cachedCover.imageUrl !== "NOT_FOUND"
            ) {
              sendSSE(res, "releaseGroupCover", {
                mbid: rg.id,
                images: [
                  {
                    image: cachedCover.imageUrl,
                    front: true,
                    types: ["Front"],
                  },
                ],
              });
              continue;
            }
            if (cachedCover && cachedCover.imageUrl === "NOT_FOUND") {
              sendSSE(res, "releaseGroupCover", { mbid: rg.id, images: [] });
              continue;
            }
            if (String(rg.id).startsWith("dz-")) continue;
          }

          const uncachedGroups = releaseGroups.filter((rg) => {
            if (rg._coverUrl || String(rg.id).startsWith("dz-")) return false;
            const cachedCover = cachedCovers[`rg:${rg.id}`];
            return !cachedCover;
          });

          const BATCH_SIZE = 4;
          for (let i = 0; i < uncachedGroups.length; i += BATCH_SIZE) {
            if (!isClientConnected()) return;
            const batch = uncachedGroups.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(
              batch.map(async (rg) => {
                if (!isClientConnected()) return;
                const cacheKey = `rg:${rg.id}`;
                try {
                  const coverArtResponse = await axios
                    .get(`https://coverartarchive.org/release-group/${rg.id}`, {
                      headers: { Accept: "application/json" },
                      timeout: 3000,
                    })
                    .catch(() => null);

                  if (coverArtResponse?.data?.images?.length > 0) {
                    const frontImage =
                      coverArtResponse.data.images.find((img) => img.front) ||
                      coverArtResponse.data.images[0];
                    if (frontImage) {
                      const imageUrl =
                        frontImage.thumbnails?.["500"] ||
                        frontImage.thumbnails?.["large"] ||
                        frontImage.image;
                      if (imageUrl) {
                        dbOps.setImage(cacheKey, imageUrl);
                        sendSSE(res, "releaseGroupCover", {
                          mbid: rg.id,
                          images: [
                            {
                              image: imageUrl,
                              front: true,
                              types: frontImage.types || ["Front"],
                            },
                          ],
                        });
                        return;
                      }
                    }
                  }
                  dbOps.setImage(cacheKey, "NOT_FOUND");
                  sendSSE(res, "releaseGroupCover", {
                    mbid: rg.id,
                    images: [],
                  });
                } catch (e) {
                  sendSSE(res, "releaseGroupCover", {
                    mbid: rg.id,
                    images: [],
                  });
                }
              }),
            );
          }
        })();
        nonCriticalTasks.push(releaseGroupCoversTask);

        Promise.allSettled(criticalTasks)
          .then(() => {
            sendSSE(res, "complete", {});
          })
          .catch(() => {
            sendSSE(res, "complete", {});
          });

        Promise.allSettled([...criticalTasks, ...nonCriticalTasks])
          .then(() => {
            setTimeout(() => {
              res.end();
            }, 100);
          })
          .catch(() => {
            setTimeout(() => {
              res.end();
            }, 100);
          });
      } catch (error) {
        console.error(
          `[Artists Stream] Error for artist ${mbid}:`,
          error.message,
        );
        if (!artistData) {
          sendSSE(res, "error", {
            error: "Failed to fetch artist details",
            message: error.response?.data?.error || error.message,
          });
        } else {
          sendSSE(res, "complete", {});
        }
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
