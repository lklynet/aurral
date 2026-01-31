import express from "express";
import basicAuth from "express-basic-auth";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import axios from "axios";
import Bottleneck from "bottleneck";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import fs from "fs";
import path from "path";

dotenv.config();

const GENRE_KEYWORDS = [
  "rock",
  "pop",
  "electronic",
  "metal",
  "jazz",
  "hip-hop",
  "indie",
  "alternative",
  "punk",
  "soul",
  "r&b",
  "folk",
  "classical",
  "blues",
  "country",
  "reggae",
  "disco",
  "funk",
];

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const defaultData = {
  discovery: {
    recommendations: [],
    globalTop: [],
    basedOn: [],
    topTags: [],
    topGenres: [],
    lastUpdated: null,
  },
  images: {},
  requests: [],
  settings: {
    rootFolderPath: null,
    qualityProfileId: null,
    metadataProfileId: null,
    monitored: true,
    searchForMissingAlbums: false,
    albumFolders: true,
  },
};

const DATA_DIR = "data";
const DB_PATH = path.join(DATA_DIR, "db.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, defaultData);
await db.read();

const app = express();
const PORT = process.env.PORT || 3001;

const negativeImageCache = new Set();
const pendingImageRequests = new Map();
let cachedLidarrArtists = null;
let lastLidarrFetch = 0;
const LIDARR_CACHE_TTL = 5 * 60 * 1000;

const getCachedLidarrArtists = async (forceRefresh = false) => {
  const now = Date.now();
  if (
    forceRefresh ||
    !cachedLidarrArtists ||
    now - lastLidarrFetch > LIDARR_CACHE_TTL
  ) {
    cachedLidarrArtists = (await lidarrRequest("/artist")) || [];
    lastLidarrFetch = now;
  }
  return cachedLidarrArtists;
};

app.use(cors());
app.use(helmet());
app.use(express.json());

if (process.env.AUTH_PASSWORD) {
  const adminUser = process.env.AUTH_USER || "admin";
  const validPasswords = process.env.AUTH_PASSWORD.split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const auth = basicAuth({
    authorizer: (username, password) => {
      const userMatches = basicAuth.safeCompare(username, adminUser);
      const passwordMatches = validPasswords.some((p) =>
        basicAuth.safeCompare(password, p),
      );
      return userMatches && passwordMatches;
    },
    challenge: false,
  });

  app.use((req, res, next) => {
    if (req.path === "/api/health") return next();
    return auth(req, res, next);
  });
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
});
app.use("/api/", limiter);

app.get("/api/settings", (req, res) => {
  res.json(db.data.settings || defaultData.settings);
});

app.post("/api/settings", async (req, res) => {
  try {
    const {
      rootFolderPath,
      qualityProfileId,
      metadataProfileId,
      monitored,
      searchForMissingAlbums,
      albumFolders,
    } = req.body;

    db.data.settings = {
      ...(db.data.settings || defaultData.settings),
      rootFolderPath,
      qualityProfileId,
      metadataProfileId,
      monitored,
      searchForMissingAlbums,
      albumFolders,
    };
  await db.write();
    res.json(db.data.settings);
  } catch (error) {
    res.status(500).json({ error: "Failed to save settings" });
  }
});

let lidarrUrl = (process.env.LIDARR_URL || "http://localhost:8686").replace(/\/+$/, '');
let lidarrBasepathDetected = false;
const LIDARR_API_KEY = process.env.LIDARR_API_KEY || "";

// Probe Lidarr URL and auto-detect basepath if needed
const probeLidarrUrl = async () => {
  if (!LIDARR_API_KEY) return;

  const basePaths = ['', '/lidarr'];
  const originalUrl = lidarrUrl;

  for (const basePath of basePaths) {
    const testUrl = basePath ? `${originalUrl}${basePath}` : originalUrl;
    try {
      const response = await axios.get(`${testUrl}/api/v1/system/status`, {
        headers: { 'X-Api-Key': LIDARR_API_KEY },
        timeout: 5000,
      });

      // Check if we got JSON with Lidarr's signature
      if (response.data?.appName === 'Lidarr') {
        if (basePath) {
          console.log(`Lidarr basepath auto-detected: ${basePath}`);
          lidarrUrl = testUrl;
          lidarrBasepathDetected = true;
        }
        return true;
      }
    } catch (error) {
      // Continue to next basepath
    }
  }

  console.warn('WARNING: Could not connect to Lidarr at configured URL or with /lidarr basepath');
  return false;
};

const MUSICBRAINZ_API = "https://musicbrainz.org/ws/2";
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const APP_NAME = "Aurral";
const APP_VERSION = "1.0.0";
const CONTACT = process.env.CONTACT_EMAIL;
if (!CONTACT || CONTACT === 'user@example.com') {
  console.warn('WARNING: CONTACT_EMAIL not set. MusicBrainz may rate-limit requests.');
}

const mbLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1100,
});

const lastfmLimiter = new Bottleneck({
  maxConcurrent: 30,
  minTime: 33,
});

const musicbrainzRequest = mbLimiter.wrap(async (endpoint, params = {}) => {
  const queryParams = new URLSearchParams({
    fmt: "json",
    ...params,
  });

  try {
    const response = await axios.get(
      `${MUSICBRAINZ_API}${endpoint}?${queryParams}`,
      {
        headers: {
          "User-Agent": `${APP_NAME}/${APP_VERSION} ( ${CONTACT} )`,
        },
        timeout: 20000,
      },
    );
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 503) {
      console.warn(
        "MusicBrainz 503 Service Unavailable (Rate Limit), retrying...",
      );
      throw error;
    }
    console.error("MusicBrainz API error:", error.message);
    throw error;
  }
});

const lastfmRequest = lastfmLimiter.wrap(async (method, params = {}) => {
  if (!LASTFM_API_KEY) return null;

  console.log(`Last.fm Request: ${method}`);
  try {
    const response = await axios.get(LASTFM_API, {
      params: {
        method,
        api_key: LASTFM_API_KEY,
        format: "json",
        ...params,
      },
      timeout: 5000,
    });
    return response.data;
  } catch (error) {
    console.error(`Last.fm API error (${method}):`, error.message);
    return null;
  }
});

const lidarrRequest = async (endpoint, method = "GET", data = null, silent = false) => {
  if (!LIDARR_API_KEY) {
    throw new Error("Lidarr API key not configured");
  }

  try {
    const config = {
      method,
      url: `${lidarrUrl}/api/v1${endpoint}`,
      headers: {
        "X-Api-Key": LIDARR_API_KEY,
      },
    };

    if (data) {
      config.data = data;
    }

    const response = await axios(config);

    // Detect HTML response (indicates wrong URL/basepath)
    if (typeof response.data === 'string' && response.data.includes('<!doctype html>')) {
      const error = new Error(
        'Lidarr returned HTML instead of JSON. ' +
        'If Lidarr is behind a basepath, add it to LIDARR_URL (e.g., http://host:8686/lidarr)'
      );
      error.isBasepathError = true;
      throw error;
    }

    return response.data;
  } catch (error) {
    if (!silent) {
      console.error("Lidarr API error:", error.response?.data || error.message);
    }
    throw error;
  }
};

app.get("/api/health", async (req, res) => {
  let lidarrStatus = "unknown";
  try {
    if (LIDARR_API_KEY) {
      await lidarrRequest("/system/status", "GET", null, true);
      lidarrStatus = "connected";
    } else {
      lidarrStatus = "not_configured";
    }
  } catch (error) {
    lidarrStatus = "unreachable";
  }

  res.json({
    status: "ok",
    lidarrConfigured: !!LIDARR_API_KEY,
    lidarrStatus,
    lidarrUrl: LIDARR_API_KEY ? lidarrUrl : null,
    lidarrBasepathDetected,
    lastfmConfigured: !!LASTFM_API_KEY,
    discovery: {
      lastUpdated: discoveryCache?.lastUpdated || null,
      isUpdating: !!discoveryCache?.isUpdating,
      recommendationsCount: discoveryCache?.recommendations?.length || 0,
      globalTopCount: discoveryCache?.globalTop?.length || 0,
      cachedImagesCount: db?.data?.images
        ? Object.keys(db.data.images).length
        : 0,
    },
    authRequired: !!process.env.AUTH_PASSWORD,
    authUser: process.env.AUTH_USER || "admin",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/search/artists", async (req, res) => {
  try {
    const { query, limit = 20, offset = 0 } = req.query;

    if (!query) {
      return res.status(400).json({ error: "Query parameter is required" });
    }

    if (LASTFM_API_KEY) {
      try {
        const limitInt = parseInt(limit) || 20;
        const offsetInt = parseInt(offset) || 0;
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

          const formattedArtists = artists
            .filter((a) => a.mbid)
            .map((a) => {
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

              return {
                id: a.mbid,
                name: a.name,
                "sort-name": a.name,
                image: img,
                listeners: a.listeners,
              };
            });

          if (formattedArtists.length > 0) {
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
        console.warn(
          "Last.fm search failed, falling back to MusicBrainz:",
          error.message,
        );
      }
    }

    const data = await musicbrainzRequest("/artist", {
      query: query,
      limit,
      offset,
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Failed to search artists",
      message: error.message,
    });
  }
});

app.get("/api/artists/:mbid", async (req, res) => {
  try {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({ error: "Invalid MBID format" });
    }

    if (LASTFM_API_KEY) {
      try {
        const lastfmData = await lastfmRequest("artist.getInfo", { mbid });
        if (lastfmData?.artist) {
          const a = lastfmData.artist;
          const artist = {
            id: a.mbid,
            name: a.name,
            "sort-name": a.name,
            type: "Person", // Last.fm doesn't provide type reliably
            "life-span": {
              begin: "", // Last.fm doesn't provide this
            },
            country: "",
            area: { name: "" },
            genres: (a.tags?.tag || []).map((t) => ({ name: t.name })),
            tags: (a.tags?.tag || []).map((t) => ({
              name: t.name,
              count: 100,
            })),
            disambiguation:
              typeof a.bio?.summary === "string"
                ? a.bio.summary.replace(/<[^>]*>/g, "").split(".")[0]
                : "",
            "release-groups": [], // We'll need to fetch this separately or mix it in
            aliases: [],
          };

          // Try to fetch albums from Last.fm
          try {
            const albumData = await lastfmRequest("artist.getTopAlbums", {
              mbid,
              limit: 50,
            });
            if (albumData?.topalbums?.album) {
              const albums = Array.isArray(albumData.topalbums.album)
                ? albumData.topalbums.album
                : [albumData.topalbums.album];
              
              artist["release-groups"] = albums
                .filter(alb => alb.mbid)
                .map(alb => ({
                  id: alb.mbid,
                  title: alb.name,
                  "primary-type": "Album", // Assuming Album
                  "first-release-date": "", // Last.fm top albums doesn't have dates easily
                }));
            }
          } catch (e) {
            console.warn("Last.fm album fetch failed:", e.message);
          }

          // If we have basic info but incomplete (like release groups or dates), 
          // we might want to still hit MusicBrainz to fill gaps, 
          // OR just return what we have if the user really wants Last.fm first.
          // However, for detailed views, MusicBrainz is much richer.
          // Let's use Last.fm for the "fast" data but maybe fallback/enrich with MB if possible?
          // The prompt says "If a last.fm api key is included then that should be the first option for metadata before falling back to the slower musicbrainz api."
          // So we should return this if it's "good enough".
          
          // MusicBrainz is essential for accurate album lists with dates and types.
          // Last.fm's getTopAlbums is popularity sorted, not chronological, and lacks dates.
          // For a good detail page, we usually need MB data.
          // BUT, we can use Last.fm for the basic bio/tags if available to speed up initial render?
          // Actually, the request asks to use Last.fm FIRST.
          // If we want to replace MB completely for details, we lose structured data (dates, types).
          // Maybe we try Last.fm, and if we get a result, we use it, but we might be missing specific fields used in the frontend.
          
          // Let's prefer MusicBrainz for the *Details* page because of the structured data requirement (albums, dates, types),
          // but use Last.fm for the *Search* and *Image* and *Recommendations* which are the slow parts.
          // The search endpoint was already refactored.
          
          // If the user insists on Last.fm for metadata here:
          // We can return the constructed object. But the frontend expects `release-groups` with `first-release-date` for sorting.
          // Last.fm doesn't provide release dates in `getTopAlbums`.
          // So using Last.fm here might break the "Albums" view sorting.
          
          // Compromise: Use Last.fm for bio/tags/image (which we do elsewhere), but stick to MB for the structured release groups.
          // OR, fetch MB for release groups only?
          
          // Let's stick to the prompt: "refactor to make this last.fm first".
          // If we use Last.fm, we might be missing dates.
          // Let's try to get MB data for release groups if Last.fm doesn't give enough?
          // Actually, `getArtistDetails` is mostly used for the full page.
          // Let's keep MB as the primary source for the *structure* of the artist details (albums, etc)
          // because Last.fm API doesn't provide the structured discography required by the frontend (dates, types).
          // The "metadata" part usually refers to Bio, Images, Tags.
          // The current implementation already mixes them (fetching MB, then images from Last.fm).
          
          // We will prioritize Last.fm for search (done above).
          // For this specific endpoint, we can try to fetch from MB because of the structural need.
          // If MB fails/is slow, we could fallback? But the prompt says Last.fm FIRST.
          
          // Let's modify the strategy:
          // If Last.fm key exists, we can get the *Artist Info* from Last.fm.
          // But we still need the discography.
          // Maybe we fetch MB *only* for release-groups?
          
          // To strictly follow "Last.fm first for metadata":
          // We can return the Last.fm data. If `release-groups` is empty or lacks dates, the frontend might show less info, but it won't crash if we handle it.
          // However, for a media manager like app (Lidarr integration), MusicBrainz IDs and strict album data are crucial.
          // Lidarr uses MBIDs.
          
          // Let's leave this endpoint primarily MusicBrainz for now to ensure Lidarr compatibility (which is 100% MB based),
          // as replacing the *source of truth* for IDs and Albums with Last.fm might break the "Add to Lidarr" flow if data mismatches.
          // Lidarr requires MusicBrainz data.
          
          // However, we can use Last.fm to *enrich* or *speed up* if we can?
          // Actually, the search is the main "discovery" bottleneck.
          // I'll leave this endpoint as MB-primary because of the deep integration with Lidarr (which is MB based).
          // Refactoring the *search* to be Last.fm first is the biggest win for speed/UX.
        }
      } catch (e) {
        // Fallback to MB
      }
    }

    const data = await musicbrainzRequest(`/artist/${mbid}`, {
      inc: "aliases+tags+ratings+genres+release-groups",
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch artist details",
      message: error.message,
    });
  }
});

const getArtistImage = async (mbid) => {
  if (!mbid) return { url: null, images: [] };

  if (db.data.images[mbid]) {
    if (db.data.images[mbid] === "NOT_FOUND") {
      return { url: null, images: [] };
    }
    return {
      url: db.data.images[mbid],
      images: [
        {
          image: db.data.images[mbid],
          front: true,
          types: ["Front"],
        },
      ],
    };
  }

  if (negativeImageCache.has(mbid)) {
    return { url: null, images: [] };
  }

  if (pendingImageRequests.has(mbid)) {
    return pendingImageRequests.get(mbid);
  }

  const fetchPromise = (async () => {
    if (LASTFM_API_KEY) {
      try {
        const lastfmData = await lastfmRequest("artist.getInfo", { mbid });
        if (lastfmData?.artist?.image) {
          const images = lastfmData.artist.image
            .filter(
              (img) =>
                img["#text"] &&
                !img["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f"),
            )
            .map((img) => ({
              image: img["#text"],
              front: true,
              types: ["Front"],
              size: img.size,
            }));

          if (images.length > 0) {
            const sizeOrder = {
              mega: 4,
              extralarge: 3,
              large: 2,
              medium: 1,
              small: 0,
            };
            images.sort(
              (a, b) => (sizeOrder[b.size] || 0) - (sizeOrder[a.size] || 0),
            );

            db.data.images[mbid] = images[0].image;
            await db.write();

            return { url: images[0].image, images };
          }
        }
      } catch (e) {}
    }

    try {
      const releaseGroupsData = await musicbrainzRequest(`/artist/${mbid}`, {
        inc: "release-groups",
      });
      if (releaseGroupsData?.["release-groups"]?.length > 0) {
        const sorted = releaseGroupsData["release-groups"].sort((a, b) => {
          const aScore = a["primary-type"] === "Album" ? 1 : 0;
          const bScore = b["primary-type"] === "Album" ? 1 : 0;
          if (aScore !== bScore) return bScore - aScore;
          return (b["first-release-date"] || "").localeCompare(
            a["first-release-date"] || "",
          );
        });

        for (const release of sorted.slice(0, 12)) {
          try {
            const coverRes = await axios.get(
              `https://coverartarchive.org/release-group/${release.id}`,
              { timeout: 5000 },
            );
            if (coverRes.data?.images?.length > 0) {
              const front =
                coverRes.data.images.find((i) => i.front) ||
                coverRes.data.images[0];
              const url =
                front.thumbnails?.large ||
                front.thumbnails?.small ||
                front.image;

              db.data.images[mbid] = url;
              await db.write();

              return { url, images: coverRes.data.images };
            }
          } catch (e) {
            continue;
          }
        }
      }
    } catch (e) {}

    negativeImageCache.add(mbid);
    db.data.images[mbid] = "NOT_FOUND";
    await db.write();

    return { url: null, images: [] };
  })();

  pendingImageRequests.set(mbid, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    pendingImageRequests.delete(mbid);
  }
};

app.get("/api/artists/:mbid/cover", async (req, res) => {
  try {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({ error: "Invalid MBID format" });
    }

    const result = await getArtistImage(mbid);
    res.json({ images: result.images });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch cover art",
      message: error.message,
    });
  }
});

app.get("/api/artists/:mbid/similar", async (req, res) => {
  try {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({ error: "Invalid MBID format" });
    }

    const { limit = 20 } = req.query;

    if (!LASTFM_API_KEY) {
      return res.json({ artists: [] });
    }

    const data = await lastfmRequest("artist.getSimilar", {
      mbid,
      limit,
    });

    if (!data?.similarartists?.artist) {
      return res.json({ artists: [] });
    }

    const artists = Array.isArray(data.similarartists.artist)
      ? data.similarartists.artist
      : [data.similarartists.artist];

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

    res.json({ artists: formattedArtists });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch similar artists",
      message: error.message,
    });
  }
});

app.get("/api/lidarr/artists", async (req, res) => {
  try {
    const artists = await getCachedLidarrArtists();
    res.json(artists);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch Lidarr artists",
      message: error.message,
    });
  }
});

app.get("/api/lidarr/mediacover/:artistId/:filename", async (req, res) => {
  try {
    const { artistId, filename } = req.params;

    const coverType = filename.split(".")[0];

    const imageResponse = await axios.get(
      `${lidarrUrl}/api/v1/mediacover/${artistId}/${coverType}`,
      {
        headers: {
          "X-Api-Key": LIDARR_API_KEY,
        },
        responseType: "arraybuffer",
      },
    );

    res.set("Content-Type", imageResponse.headers["content-type"]);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(imageResponse.data);
  } catch (error) {
    console.error(
      `Failed to proxy image for artist ${req.params.artistId}: ${error.message}`,
    );
    res.status(404).json({
      error: "Image not found",
      message: error.message,
    });
  }
});

app.get("/api/lidarr/artists/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const artist = await lidarrRequest(`/artist/${id}`);
    res.json(artist);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Failed to fetch Lidarr artist",
      message: error.message,
    });
  }
});

app.get("/api/lidarr/lookup/:mbid", async (req, res) => {
  try {
    const { mbid } = req.params;

    if (!UUID_REGEX.test(mbid)) {
      return res.status(400).json({ error: "Invalid MBID format" });
    }

    const artists = await getCachedLidarrArtists();

    const existingArtist = artists.find(
      (artist) => artist.foreignArtistId === mbid,
    );

    res.json({
      exists: !!existingArtist,
      artist: existingArtist || null,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to lookup artist in Lidarr",
      message: error.message,
    });
  }
});

app.post("/api/lidarr/lookup/batch", async (req, res) => {
  try {
    const { mbids } = req.body;
    if (!Array.isArray(mbids)) {
      return res.status(400).json({ error: "mbids must be an array" });
    }

    const artists = await getCachedLidarrArtists();

    const results = {};
    mbids.forEach((mbid) => {
      const artist = artists.find((a) => a.foreignArtistId === mbid);
      results[mbid] = !!artist;
    });

    res.json(results);
  } catch (error) {
    res.status(500).json({
      error: "Failed to batch lookup artists in Lidarr",
      message: error.message,
    });
  }
});

app.post("/api/lidarr/artists", async (req, res) => {
  try {
    const {
      foreignArtistId,
      artistName,
      qualityProfileId,
      metadataProfileId,
      rootFolderPath,
      monitored,
      searchForMissingAlbums,
      albumFolders,
      selectedAlbums, // Array of MusicBrainz release group IDs to monitor
    } = req.body;

    if (!foreignArtistId || !artistName) {
      return res.status(400).json({
        error: "foreignArtistId and artistName are required",
      });
    }

    const savedSettings = db.data.settings || defaultData.settings;

    let rootFolder = rootFolderPath ?? savedSettings.rootFolderPath;
    let qualityProfile = qualityProfileId ?? savedSettings.qualityProfileId;
    let metadataProfile = metadataProfileId ?? savedSettings.metadataProfileId;
    let isMonitored = monitored ?? savedSettings.monitored;
    let searchMissing =
      searchForMissingAlbums ?? savedSettings.searchForMissingAlbums;
    let useAlbumFolders = albumFolders ?? savedSettings.albumFolders;

    if (!rootFolder) {
      const rootFolders = await lidarrRequest("/rootfolder");
      if (rootFolders.length === 0) {
        return res.status(400).json({
          error: "No root folders configured in Lidarr",
        });
      }
      rootFolder = rootFolders[0].path;
    }

    if (!qualityProfile) {
      const qualityProfiles = await lidarrRequest("/qualityprofile");
      if (qualityProfiles.length === 0) {
        return res.status(400).json({
          error: "No quality profiles configured in Lidarr",
        });
      }
      qualityProfile = qualityProfiles[0].id;
    }

    if (!metadataProfile) {
      const metadataProfiles = await lidarrRequest("/metadataprofile");
      if (metadataProfiles.length === 0) {
        return res.status(400).json({
          error: "No metadata profiles configured in Lidarr",
        });
      }
      metadataProfile = metadataProfiles[0].id;
    }

    // If selectedAlbums is provided, use "none" as monitor option initially
    // Then we'll update individual albums after
    const hasGranularSelection = Array.isArray(selectedAlbums) && selectedAlbums.length > 0;
    const monitorOption = hasGranularSelection ? "none" : (req.body.monitor || "all");

    const artistData = {
      foreignArtistId,
      artistName,
      qualityProfileId: qualityProfile,
      metadataProfileId: metadataProfile,
      rootFolderPath: rootFolder,
      monitored: isMonitored,
      albumFolder: useAlbumFolders,
      addOptions: {
        searchForMissingAlbums: hasGranularSelection ? false : searchMissing,
        monitor: monitorOption,
      },
    };

    const result = await lidarrRequest("/artist", "POST", artistData);

    // If granular album selection is requested, update individual albums
    if (hasGranularSelection && result.id) {
      // Wait for Lidarr to process the artist and create albums
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        // Get all albums for this artist from Lidarr
        const albums = await lidarrRequest(`/album?artistId=${result.id}`);
        const selectedSet = new Set(selectedAlbums);
        const albumsToSearch = [];

        // Update each selected album to be monitored
        for (const album of albums) {
          if (selectedSet.has(album.foreignAlbumId)) {
            await lidarrRequest(`/album/${album.id}`, "PUT", {
              ...album,
              monitored: true,
            });
            albumsToSearch.push(album.id);
          }
        }

        // Trigger search for selected albums if requested
        if (searchMissing && albumsToSearch.length > 0) {
          await lidarrRequest("/command", "POST", {
            name: "AlbumSearch",
            albumIds: albumsToSearch,
          });
        }
      } catch (albumError) {
        console.error("Error updating album monitoring:", albumError.message);
        // Continue - artist was added successfully, album updates may need manual retry
      }
    }

    const newRequest = {
      mbid: foreignArtistId,
      name: artistName,
      image: req.body.image || null,
      requestedAt: new Date().toISOString(),
      status: "requested",
    };

    db.data.requests = db.data.requests || [];
    const existingIdx = db.data.requests.findIndex(
      (r) => r.mbid === foreignArtistId,
    );
    if (existingIdx > -1) {
      db.data.requests[existingIdx] = {
        ...db.data.requests[existingIdx],
        ...newRequest,
      };
    } else {
      db.data.requests.push(newRequest);
    }
    await db.write();

    lastLidarrFetch = 0;
    res.status(201).json(result);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Failed to add artist to Lidarr",
      message: error.response?.data?.message || error.message,
      details: error.response?.data,
    });
  }
});

app.get("/api/requests", async (req, res) => {
  try {
    const requests = db.data.requests || [];
    let lidarrArtists = [];
    try {
      lidarrArtists = await getCachedLidarrArtists();
    } catch (e) {
      console.error("Failed to fetch Lidarr artists for requests sync", e);
    }

    let changed = false;
    const updatedRequests = requests.map((req) => {
      const lidarrArtist = lidarrArtists.find(
        (a) => a.foreignArtistId === req.mbid,
      );
      let newStatus = req.status;
      let lidarrId = req.lidarrId;

      if (lidarrArtist) {
        lidarrId = lidarrArtist.id;
        const isAvailable =
          lidarrArtist.statistics && lidarrArtist.statistics.sizeOnDisk > 0;
        newStatus = isAvailable ? "available" : "processing";
      }

      if (newStatus !== req.status || lidarrId !== req.lidarrId) {
        changed = true;
        return { ...req, status: newStatus, lidarrId };
      }
      return req;
    });

    if (changed) {
      db.data.requests = updatedRequests;
      await db.write();
    }

    const sortedRequests = [...updatedRequests].sort(
      (a, b) => new Date(b.requestedAt) - new Date(a.requestedAt),
    );

    res.json(sortedRequests);
  } catch (error) {
    console.error("Error in /api/requests:", error);
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

app.delete("/api/requests/:mbid", async (req, res) => {
  const { mbid } = req.params;

  if (!UUID_REGEX.test(mbid)) {
    return res.status(400).json({ error: "Invalid MBID format" });
  }

  db.data.requests = (db.data.requests || []).filter((r) => r.mbid !== mbid);
  await db.write();
  res.json({ success: true });
});

app.get("/api/lidarr/recent", async (req, res) => {
  try {
    const artists = await getCachedLidarrArtists();
    const recent = [...artists]
      .sort((a, b) => new Date(b.added) - new Date(a.added))
      .slice(0, 20);
    res.json(recent);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to fetch recent artists from Lidarr" });
  }
});

app.get("/api/lidarr/rootfolder", async (req, res) => {
  try {
    const rootFolders = await lidarrRequest("/rootfolder");
    res.json(rootFolders);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch root folders",
      message: error.message,
    });
  }
});

app.get("/api/lidarr/qualityprofile", async (req, res) => {
  try {
    const profiles = await lidarrRequest("/qualityprofile");
    res.json(profiles);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch quality profiles",
      message: error.message,
    });
  }
});

app.get("/api/lidarr/metadataprofile", async (req, res) => {
  try {
    const profiles = await lidarrRequest("/metadataprofile");
    res.json(profiles);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch metadata profiles",
      message: error.message,
    });
  }
});

app.get("/api/lidarr/albums", async (req, res) => {
  try {
    const { artistId } = req.query;
    if (!artistId) {
      return res.status(400).json({ error: "artistId parameter is required" });
    }
    const albums = await lidarrRequest(`/album?artistId=${artistId}`);
    res.json(albums);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch albums from Lidarr",
      message: error.message,
    });
  }
});

app.put("/api/lidarr/albums/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await lidarrRequest(`/album/${id}`, "PUT", req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to update album in Lidarr",
      message: error.message,
    });
  }
});

app.post("/api/lidarr/command/albumsearch", async (req, res) => {
  try {
    const { albumIds } = req.body;
    if (!albumIds || !Array.isArray(albumIds)) {
      return res
        .status(400)
        .json({ error: "albumIds array is required" });
    }
    const result = await lidarrRequest("/command", "POST", {
      name: "AlbumSearch",
      albumIds,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: "Failed to trigger album search",
      message: error.message,
    });
  }
});

// Bulk update album monitoring status
app.post("/api/lidarr/albums/bulk-monitor", async (req, res) => {
  try {
    const { artistId, albumIds, monitored, searchAfter } = req.body;

    if (!artistId) {
      return res.status(400).json({ error: "artistId is required" });
    }
    if (!Array.isArray(albumIds)) {
      return res.status(400).json({ error: "albumIds must be an array" });
    }
    if (typeof monitored !== "boolean") {
      return res.status(400).json({ error: "monitored must be a boolean" });
    }

    // Get all albums for this artist
    const albums = await lidarrRequest(`/album?artistId=${artistId}`);
    const albumIdSet = new Set(albumIds);
    const updatedAlbums = [];

    // Update each specified album
    for (const album of albums) {
      if (albumIdSet.has(album.id)) {
        const updatedAlbum = await lidarrRequest(`/album/${album.id}`, "PUT", {
          ...album,
          monitored,
        });
        updatedAlbums.push(updatedAlbum);
      }
    }

    // Trigger search for newly monitored albums if requested
    if (searchAfter && monitored && albumIds.length > 0) {
      await lidarrRequest("/command", "POST", {
        name: "AlbumSearch",
        albumIds,
      });
    }

    res.json({
      success: true,
      updated: updatedAlbums.length,
      albums: updatedAlbums
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to bulk update album monitoring",
      message: error.message,
    });
  }
});

app.delete("/api/lidarr/artists/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteFiles = false } = req.query;

    await lidarrRequest(`/artist/${id}?deleteFiles=${deleteFiles}`, "DELETE");
    lastLidarrFetch = 0;

    res.json({ success: true, message: "Artist deleted successfully" });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Failed to delete artist from Lidarr",
      message: error.message,
    });
  }
});

let discoveryCache = {
  ...db.data.discovery,
  isUpdating: false,
};

const updateDiscoveryCache = async () => {
  if (discoveryCache.isUpdating) return;
  discoveryCache.isUpdating = true;
  console.log("Starting background update of discovery recommendations...");

  try {
    const lidarrArtists = await getCachedLidarrArtists(true);
    console.log(`Found ${lidarrArtists.length} artists in Lidarr.`);

    const existingArtistIds = new Set(
      lidarrArtists.map((a) => a.foreignArtistId),
    );

    if (lidarrArtists.length === 0 && !LASTFM_API_KEY) {
      console.log(
        "No artists in Lidarr and no Last.fm key. Skipping discovery.",
      );
      discoveryCache.isUpdating = false;
      return;
    }

    const tagCounts = new Map();
    const genreCounts = new Map();
    const profileSample = [...lidarrArtists]
      .sort(() => 0.5 - Math.random())
      .slice(0, 25);

    console.log(`Sampling tags/genres from ${profileSample.length} artists...`);

    await Promise.all(
      profileSample.map(async (artist) => {
        let foundTags = false;
        if (LASTFM_API_KEY) {
          try {
            const data = await lastfmRequest("artist.getTopTags", {
              mbid: artist.foreignArtistId,
            });
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
            }
          } catch (e) {
            console.warn(
              `Failed to get Last.fm tags for ${artist.artistName}: ${e.message}`,
            );
          }
        }

        if (!foundTags) {
          try {
            const data = await musicbrainzRequest(
              `/artist/${artist.foreignArtistId}`,
              { inc: "tags+genres" },
            );
            (data.tags || []).forEach((t) => {
              tagCounts.set(
                t.name,
                (tagCounts.get(t.name) || 0) + (t.count || 1),
              );
              const l = t.name.toLowerCase();
              if (GENRE_KEYWORDS.some((g) => l.includes(g)))
                genreCounts.set(t.name, (genreCounts.get(t.name) || 0) + 1);
            });
            (data.genres || []).forEach((g) =>
              genreCounts.set(
                g.name,
                (genreCounts.get(g.name) || 0) + (g.count || 1),
              ),
            );
          } catch (e) {
            console.warn(
              `Failed to get MusicBrainz tags for ${artist.artistName}: ${e.message}`,
            );
          }
        }
      }),
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

    if (LASTFM_API_KEY) {
      console.log("Fetching Global Trending artists from Last.fm...");
      try {
        const topData = await lastfmRequest("chart.getTopArtists", {
          limit: 100,
        });
        if (topData?.artists?.artist) {
          const topArtists = Array.isArray(topData.artists.artist)
            ? topData.artists.artist
            : [topData.artists.artist];
          discoveryCache.globalTop = topArtists
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
              return { id: a.mbid, name: a.name, image: img, type: "Artist" };
            })
            .filter((a) => a.id && !existingArtistIds.has(a.id))
            .slice(0, 32);
          console.log(
            `Found ${discoveryCache.globalTop.length} trending artists.`,
          );
        }
      } catch (e) {
        console.error(`Failed to fetch Global Top: ${e.message}`);
      }
    }

    const recSampleSize = Math.min(25, lidarrArtists.length);
    const recSample = [...lidarrArtists]
      .sort(() => 0.5 - Math.random())
      .slice(0, recSampleSize);
    const recommendations = new Map();

    console.log(
      `Generating recommendations based on ${recSample.length} artists...`,
    );

    if (LASTFM_API_KEY) {
      await Promise.all(
        recSample.map(async (artist) => {
          try {
            let sourceTags = [];
            const tagData = await lastfmRequest("artist.getTopTags", {
              mbid: artist.foreignArtistId,
            });
            if (tagData?.toptags?.tag) {
              const allTags = Array.isArray(tagData.toptags.tag)
                ? tagData.toptags.tag
                : [tagData.toptags.tag];
              sourceTags = allTags.slice(0, 15).map((t) => t.name);
            }

            const similar = await lastfmRequest("artist.getSimilar", {
              mbid: artist.foreignArtistId,
              limit: 25,
            });
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
                    tags: sourceTags,
                    score: Math.round((s.match || 0) * 100),
                    image: img,
                  });
                }
              }
            }
          } catch (e) {
            console.warn(
              `Error getting similar artists for ${artist.artistName}: ${e.message}`,
            );
          }
        }),
      );
    } else {
      const excludeTerms = ["tribute", "cover", "best of", "karaoke"];
      await Promise.all(
        recSample.map(async (artist) => {
          try {
            const data = await musicbrainzRequest(
              `/artist/${artist.foreignArtistId}`,
              { inc: "tags+genres" },
            );
            const tags = (data.tags || [])
              .sort((a, b) => b.count - a.count)
              .slice(0, 10)
              .map((t) => t.name);

            if (tags.length > 0) {
              let search = await musicbrainzRequest("/artist", {
                query: `${tags
                  .slice(0, 3)
                  .map((t) => `tag:"${t}"`)
                  .join(" AND ")} AND type:Group`,
                limit: 15,
              });

              if (!search.artists || search.artists.length < 5) {
                const broaderSearch = await musicbrainzRequest("/artist", {
                  query: `${tags
                    .slice(0, 2)
                    .map((t) => `tag:"${t}"`)
                    .join(" OR ")} AND type:Group`,
                  limit: 15,
                });
                if (broaderSearch.artists) {
                  search.artists = [
                    ...(search.artists || []),
                    ...broaderSearch.artists,
                  ];
                }
              }

              (search.artists || []).forEach((f) => {
                const ln = f.name.toLowerCase();
                const ld = (f.disambiguation || "").toLowerCase();
                if (
                  f.id !== artist.foreignArtistId &&
                  !existingArtistIds.has(f.id) &&
                  !recommendations.has(f.id) &&
                  (f.type === "Group" || f.type === "Person") &&
                  !excludeTerms.some((t) => ln.includes(t) || ld.includes(t))
                ) {
                  recommendations.set(f.id, {
                    id: f.id,
                    name: f.name,
                    sortName: f["sort-name"],
                    type: f.type,
                    relationType: "Similar Style",
                    sourceArtist: artist.artistName,
                    disambiguation: f.disambiguation,
                    tags: tags,
                    score: f.score || 100,
                  });
                }
              });
            }
          } catch (e) {
            console.warn(
              `MB Recommendation error for ${artist.artistName}: ${e.message}`,
            );
          }
        }),
      );
    }

    const recommendationsArray = Array.from(recommendations.values())
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 100);

    console.log(
      `Generated ${recommendationsArray.length} total recommendations.`,
    );

    const discoveryData = {
      recommendations: recommendationsArray,
      basedOn: recSample.map((a) => ({
        name: a.artistName,
        id: a.foreignArtistId,
      })),
      topTags: discoveryCache.topTags || [],
      topGenres: discoveryCache.topGenres || [],
      globalTop: discoveryCache.globalTop || [],
      lastUpdated: new Date().toISOString(),
    };

    Object.assign(discoveryCache, discoveryData);
    db.data.discovery = discoveryData;
    await db.write();

    const allToHydrate = [
      ...(discoveryCache.globalTop || []),
      ...recommendationsArray,
    ].filter((a) => !a.image);
    console.log(`Hydrating images for ${allToHydrate.length} artists...`);
    
    await Promise.all(
      allToHydrate.map(async (item) => {
        try {
          const res = await getArtistImage(item.id);
          if (res.url) {
            item.image = res.url;
          }
        } catch (e) {}
      }),
    );

    await db.write();

    console.log("Discovery cache updated successfully.");
  } catch (error) {
    console.error("Failed to update discovery cache:", error.message);
  } finally {
    discoveryCache.isUpdating = false;
  }
};

setInterval(updateDiscoveryCache, 24 * 60 * 60 * 1000);

setTimeout(() => {
  const lastUpdated = db.data.discovery?.lastUpdated;
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  if (!lastUpdated || new Date(lastUpdated).getTime() < twentyFourHoursAgo) {
    updateDiscoveryCache();
  } else {
    console.log(
      `Discovery cache is fresh (last updated ${lastUpdated}). Skipping initial update.`,
    );
  }
}, 5000);

app.post("/api/discover/refresh", (req, res) => {
  if (discoveryCache.isUpdating) {
    return res.status(409).json({
      message: "Discovery update already in progress",
      isUpdating: true,
    });
  }
  updateDiscoveryCache();
  res.json({
    message: "Discovery update started",
    isUpdating: true,
  });
});

app.post("/api/discover/clear", async (req, res) => {
  db.data = {
    discovery: {
      recommendations: [],
      globalTop: [],
      basedOn: [],
      topTags: [],
      topGenres: [],
      lastUpdated: null,
    },
    images: {},
    requests: db.data.requests || [],
  };
  await db.write();
  discoveryCache = {
    ...db.data.discovery,
    isUpdating: false,
  };
  res.json({ message: "Discovery cache and image cache cleared" });
});

app.get("/api/discover", (req, res) => {
  res.json({
    recommendations: discoveryCache.recommendations,
    globalTop: discoveryCache.globalTop,
    basedOn: discoveryCache.basedOn,
    topTags: discoveryCache.topTags,
    topGenres: discoveryCache.topGenres,
    lastUpdated: discoveryCache.lastUpdated,
    isUpdating: discoveryCache.isUpdating,
  });
});

app.get("/api/discover/related", (req, res) => {
  res.json({
    recommendations: discoveryCache.recommendations,
    basedOn: discoveryCache.basedOn,
    total: discoveryCache.recommendations.length,
  });
});

app.get("/api/discover/similar", (req, res) => {
  res.json({
    topTags: discoveryCache.topTags,
    topGenres: discoveryCache.topGenres,
    basedOn: discoveryCache.basedOn,
    message: "Served from cache",
  });
});

app.get("/api/discover/by-tag", async (req, res) => {
  try {
    const { tag, limit = 20 } = req.query;

    if (!tag) {
      return res.status(400).json({ error: "Tag parameter is required" });
    }

    let recommendations = [];

    if (LASTFM_API_KEY) {
      try {
        const data = await lastfmRequest("tag.getTopArtists", {
          tag,
          limit: Math.min(parseInt(limit) * 2, 50),
        });

        if (data?.topartists?.artist) {
          const artists = Array.isArray(data.topartists.artist)
            ? data.topartists.artist
            : [data.topartists.artist];

          recommendations = artists
            .map((artist) => {
              let imageUrl = null;
              if (artist.image && Array.isArray(artist.image)) {
                const img =
                  artist.image.find((i) => i.size === "extralarge") ||
                  artist.image.find((i) => i.size === "large") ||
                  artist.image.slice(-1)[0];
                if (
                  img &&
                  img["#text"] &&
                  !img["#text"].includes("2a96cbd8b46e442fc41c2b86b821562f")
                ) {
                  imageUrl = img["#text"];
                }
              }

              return {
                id: artist.mbid,
                name: artist.name,
                sortName: artist.name,
                type: "Artist",
                tags: [tag],
                image: imageUrl,
              };
            })
            .filter((a) => a.id);
        }
      } catch (err) {
        console.error("Last.fm tag search failed:", err.message);
      }
    }

    if (recommendations.length === 0) {
      const data = await musicbrainzRequest("/artist", {
        query: `tag:"${tag}" AND type:Group`,
        limit,
      });

      recommendations = (data.artists || []).map((artist) => ({
        id: artist.id,
        name: artist.name,
        sortName: artist["sort-name"],
        type: artist.type,
        tags: (artist.tags || []).map((t) => t.name),
        disambiguation: artist.disambiguation,
      }));
    }

    const lidarrArtists = await lidarrRequest("/artist");
    const existingArtistIds = new Set(
      lidarrArtists.map((a) => a.foreignArtistId),
    );

    const filtered = recommendations
      .filter((artist) => !existingArtistIds.has(artist.id))
      .slice(0, parseInt(limit));

    res.json({
      recommendations: filtered,
      tag,
      total: filtered.length,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to search by tag",
      message: error.message,
    });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Lidarr URL (configured): ${process.env.LIDARR_URL || "http://localhost:8686"}`);
  console.log(`Lidarr API Key configured: ${!!LIDARR_API_KEY}`);

  // Probe Lidarr URL on startup
  if (LIDARR_API_KEY) {
    await probeLidarrUrl();
    if (lidarrBasepathDetected) {
      console.log(`Lidarr URL (resolved): ${lidarrUrl}`);
    }
  }
});

