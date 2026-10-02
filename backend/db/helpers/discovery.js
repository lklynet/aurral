import { db, dbHelpers } from "../../config/db-sqlite.js";

const getDiscoveryCacheStmt = db.prepare(
  "SELECT value, last_updated FROM discovery_cache WHERE key = ?"
);
const upsertDiscoveryCacheStmt = db.prepare(
  "INSERT OR REPLACE INTO discovery_cache (key, value, last_updated) VALUES (?, ?, ?)"
);
const DISCOVERY_METADATA_FIELDS = [
  "recommendationQuality",
  "isEnriching",
  "discoveryRunId",
  "enrichmentStartedAt",
  "enrichmentCompletedAt",
  "enrichmentProgressMessage",
];

const discoveryUserCache = new Map();
const DISCOVERY_USER_CACHE_TTL_MS = 10_000;

function pruneDiscoveryUserCache() {
  const now = Date.now();
  for (const [key, entry] of discoveryUserCache) {
    if (now - entry.at >= DISCOVERY_USER_CACHE_TTL_MS) {
      discoveryUserCache.delete(key);
    }
  }
}

export default function register(dbOps) {
  dbOps.getDiscoveryCache = function (cacheNamespace = null) {
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";

    if (cacheNamespace) {
      pruneDiscoveryUserCache();
      const cached = discoveryUserCache.get(cacheNamespace);
      if (cached) return cached.value;
    }

    const metadata =
      dbHelpers.parseJSON(getDiscoveryCacheStmt.get(`${prefix}metadata`)?.value) ||
      {};
    const recommendationsRow = getDiscoveryCacheStmt.get(`${prefix}recommendations`);
    const recommendations = dbHelpers.parseJSON(recommendationsRow?.value);
    const globalTopRow = getDiscoveryCacheStmt.get(`${prefix}globalTop`);
    const globalTop = dbHelpers.parseJSON(globalTopRow?.value);
    const basedOn = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}basedOn`)?.value
    );
    const topTags = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}topTags`)?.value
    );
    const topGenres = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}topGenres`)?.value
    );
    const fallbackGenres = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}fallbackGenres`)?.value
    );
    const fallbackGenrePools = dbHelpers.parseJSON(
      getDiscoveryCacheStmt.get(`${prefix}fallbackGenrePools`)?.value
    );
    const provider =
      getDiscoveryCacheStmt.get(`${prefix}provider`)?.value || null;
    const lastUpdated = cacheNamespace
      ? getDiscoveryCacheStmt.get(`${prefix}lastUpdated`)?.value ||
        recommendationsRow?.last_updated ||
        null
      : recommendationsRow?.last_updated ||
        globalTopRow?.last_updated ||
        null;

    const result = {
      recommendations: recommendations || [],
      globalTop: globalTop || [],
      basedOn: basedOn || [],
      topTags: topTags || [],
      topGenres: topGenres || [],
      fallbackGenres: fallbackGenres || [],
      fallbackGenrePools:
        fallbackGenrePools && typeof fallbackGenrePools === "object"
          ? fallbackGenrePools
          : {},
      provider,
      lastUpdated,
      metadata,
      recommendationQuality: metadata.recommendationQuality || null,
      isEnriching: metadata.isEnriching === true,
      discoveryRunId: metadata.discoveryRunId || null,
      enrichmentStartedAt: metadata.enrichmentStartedAt || null,
      enrichmentCompletedAt: metadata.enrichmentCompletedAt || null,
      enrichmentProgressMessage: metadata.enrichmentProgressMessage || null,
    };

    if (cacheNamespace) {
      discoveryUserCache.set(cacheNamespace, { at: Date.now(), value: result });
    }

    return result;
  };

  dbOps.updateDiscoveryCache = function (discovery, cacheNamespace = null) {
    const now = new Date().toISOString();
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";
    if (cacheNamespace) discoveryUserCache.delete(cacheNamespace);
    const updateFn = db.transaction(() => {
      if (discovery.recommendations) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}recommendations`,
          dbHelpers.stringifyJSON(discovery.recommendations),
          now
        );
      }
      if (discovery.globalTop) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}globalTop`,
          dbHelpers.stringifyJSON(discovery.globalTop),
          now
        );
      }
      if (discovery.basedOn) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}basedOn`,
          dbHelpers.stringifyJSON(discovery.basedOn),
          now
        );
      }
      if (discovery.topTags) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}topTags`,
          dbHelpers.stringifyJSON(discovery.topTags),
          now
        );
      }
      if (discovery.topGenres) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}topGenres`,
          dbHelpers.stringifyJSON(discovery.topGenres),
          now
        );
      }
      if (discovery.fallbackGenres) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}fallbackGenres`,
          dbHelpers.stringifyJSON(discovery.fallbackGenres),
          now
        );
      }
      if (discovery.fallbackGenrePools) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}fallbackGenrePools`,
          dbHelpers.stringifyJSON(discovery.fallbackGenrePools),
          now
        );
      }
      if (discovery.provider) {
        upsertDiscoveryCacheStmt.run(`${prefix}provider`, discovery.provider, now);
      }
      const hasMetadataUpdate =
        (discovery.metadata && typeof discovery.metadata === "object") ||
        DISCOVERY_METADATA_FIELDS.some((field) =>
          Object.prototype.hasOwnProperty.call(discovery, field),
        );
      if (hasMetadataUpdate) {
        const existingMetadata =
          dbHelpers.parseJSON(
            getDiscoveryCacheStmt.get(`${prefix}metadata`)?.value,
          ) || {};
        const nextMetadata = {
          ...existingMetadata,
          ...(discovery.metadata && typeof discovery.metadata === "object"
            ? discovery.metadata
            : {}),
        };
        for (const field of DISCOVERY_METADATA_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(discovery, field)) {
            nextMetadata[field] = discovery[field];
          }
        }
        upsertDiscoveryCacheStmt.run(
          `${prefix}metadata`,
          dbHelpers.stringifyJSON(nextMetadata),
          now,
        );
      }
      if (cacheNamespace) {
        upsertDiscoveryCacheStmt.run(`${prefix}lastUpdated`, now, now);
      }
    });
    updateFn();
  };

  dbOps.deleteDiscoveryCacheByPrefix = function (prefix) {
    const namespace = String(prefix || "").replace(/%$/, "").replace(/:$/, "");
    discoveryUserCache.delete(namespace);
    return db.prepare("DELETE FROM discovery_cache WHERE key LIKE ?").run(
      `${prefix}%`
    );
  };
}
