import { dbOps } from "../config/db-helpers.js";
import { enqueueImagePrefetchJob } from "./honkerDb.js";

const BATCH_SIZE = 10;

function enqueueUncachedMbids(mbids) {
  const unique = [
    ...new Set(
      (Array.isArray(mbids) ? mbids : [])
        .map((mbid) => String(mbid || "").trim())
        .filter(Boolean),
    ),
  ];
  if (unique.length === 0) return;

  const cachedImages = dbOps.getImages(unique);
  const uncached = unique.filter((mbid) => {
    const cached = cachedImages[mbid];
    return !cached || cached.imageUrl === "NOT_FOUND";
  });
  for (let index = 0; index < uncached.length; index += BATCH_SIZE) {
    enqueueImagePrefetchJob({
      mbids: uncached.slice(index, index + BATCH_SIZE),
      requestedAt: Date.now(),
    });
  }
}

class ImagePrefetchService {
  enqueue(mbids) {
    enqueueUncachedMbids(mbids);
  }

  async prefetchDiscoveryImages(discoveryData) {
    const mbids = [];
    if (discoveryData?.recommendations) {
      mbids.push(
        ...discoveryData.recommendations.map((artist) => artist.id).filter(Boolean),
      );
    }
    if (discoveryData?.globalTop) {
      mbids.push(
        ...discoveryData.globalTop.map((artist) => artist.id).filter(Boolean),
      );
    }
    this.enqueue(mbids);
  }

  async prefetchSearchResults(artists) {
    const mbids = artists.map((artist) => artist.id || artist.mbid).filter(Boolean);
    this.enqueue(mbids);
  }
}

export const imagePrefetchService = new ImagePrefetchService();
