import {
  getLastfmApiKey,
  lastfmRequest,
  musicbrainzRequest,
} from "../../../services/apiClients.js";
import { libraryManager } from "../../../services/libraryManager.js";
import { imagePrefetchService } from "../../../services/imagePrefetchService.js";
import { dbOps } from "../../../config/db-helpers.js";
import { cacheMiddleware } from "../../../middleware/cache.js";

const handleSearch = async (req, res) => {
  try {
    const { query, limit = 24, offset = 0 } = req.query;

    if (!query) {
      return res.status(400).json({ error: "Query parameter is required" });
    }

    const limitInt = parseInt(limit) || 24;
    const offsetInt = parseInt(offset) || 0;

    // Get local library artists for "Already in Library" checks
    const localArtists = await libraryManager.getAllArtists();
    const localArtistMbids = new Set(
      localArtists.map((a) => a.mbid || a.foreignArtistId).filter((id) => id),
    );

    if (getLastfmApiKey()) {
      try {
        const page = Math.floor(offsetInt / limitInt) + 1;

        const lastfmData = await lastfmRequest("artist.search", {
          artist: query,
          limit: limitInt,
          page,
        });

        if (lastfmData?.results?.artistmatches?.artist) {
          const artists = Array.isArray(lastfmData.results.artistmatches.artist)
            ? lastfmData.results.artistmatches.artist
            : [lastfmData.results.artistmatches.artist];

          const filteredArtists = artists.filter((a) => a.mbid);
          const mbids = filteredArtists.map((a) => a.mbid);
          const cachedImages = dbOps.getImages(mbids);

          const formattedArtists = filteredArtists.map((a) => {
            let img = null;
            if (a.image && Array.isArray(a.image)) {
              const i =
                a.image.find((img) => img.size === "extralarge") ||
                a.image.find((img) => img.size === "large") ||
                a.image.find((img) => img.size === "medium");
              if (
                i &&
                i["#text"] &&
                !i["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
              ) {
                img = i["#text"];
              }
            }

            const result = {
              id: a.mbid,
              name: a.name,
              "sort-name": a.name,
              image: img,
              imageUrl: img,
              listeners: a.listeners,
              inLibrary: localArtistMbids.has(a.mbid),
            };

            const cachedImage = cachedImages[a.mbid];
            if (
              cachedImage &&
              cachedImage.imageUrl &&
              cachedImage.imageUrl !== "NOT_FOUND"
            ) {
              result.imageUrl = cachedImage.imageUrl;
              result.image = cachedImage.imageUrl;
            }

            return result;
          });

          if (formattedArtists.length > 0) {
            imagePrefetchService
              .prefetchSearchResults(formattedArtists)
              .catch(() => {});

            return res.json({
              artists: formattedArtists,
              count: parseInt(
                lastfmData.results["opensearch:totalResults"] || 0,
              ),
              offset: offsetInt,
            });
          }
        }
      } catch (error) {
        console.warn("Last.fm search failed", error.message);
      }
    }

    try {
      const mbData = await musicbrainzRequest("/artist", {
        query,
        limit: limitInt,
        offset: offsetInt,
      });

      const artists = Array.isArray(mbData?.artists) ? mbData.artists : [];
      const filteredArtists = artists.filter((a) => a.id);
      const mbids = filteredArtists.map((a) => a.id);
      const cachedImages = dbOps.getImages(mbids);

      const formattedArtists = filteredArtists.map((a) => {
        const cachedImage = cachedImages[a.id];
        const imageUrl =
          cachedImage &&
          cachedImage.imageUrl &&
          cachedImage.imageUrl !== "NOT_FOUND"
            ? cachedImage.imageUrl
            : null;

        return {
          id: a.id,
          name: a.name,
          "sort-name": a["sort-name"] || a.name,
          image: imageUrl,
          imageUrl,
          listeners: null,
          inLibrary: localArtistMbids.has(a.id),
        };
      });

      if (formattedArtists.length > 0) {
        imagePrefetchService
          .prefetchSearchResults(formattedArtists)
          .catch(() => {});
      }

      return res.json({
        artists: formattedArtists,
        count: parseInt(mbData?.count || formattedArtists.length),
        offset: offsetInt,
      });
    } catch (error) {
      console.warn("MusicBrainz search failed", error.message);
    }

    res.json({ artists: [], count: 0, offset: offsetInt });
  } catch (error) {
    res.status(500).json({
      error: "Failed to search artists",
      message: error.message,
    });
  }
};

export default function registerSearch(router) {
  router.get("/search", cacheMiddleware(300), handleSearch);
  router.get("/artists", cacheMiddleware(300), handleSearch);
}
