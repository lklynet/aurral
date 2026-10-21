import type Database from "better-sqlite3";
import { db, dbHelpers } from "../../config/db-sqlite.ts";
import type { DiscoveryCacheRow } from "../rows.ts";
import type { DiscoveryRecommendation } from "../../services/discovery/recommendationPipeline.ts";

export interface DiscoveryMetadata {
  recommendationQuality?: string | null;
  isEnriching?: boolean;
  discoveryRunId?: string | null;
  enrichmentStartedAt?: string | null;
  enrichmentCompletedAt?: string | null;
  enrichmentProgressMessage?: string | null;
  lastRunStartedAt?: number;
  refreshRequestedAt?: number;
  refreshStartedAt?: number;
  refreshFinishedAt?: number;
  refreshPhase?: string | null;
  refreshProgress?: number | null;
  refreshMessage?: string | null;
  refreshError?: string | null;
  [field: string]: unknown;
}

export interface DiscoveryBasedOn {
  id?: string | null;
  name?: string;
  artistName?: string;
  source?: string;
  profileBucket?: string | null;
}

export interface DiscoveryCache {
  recommendations: DiscoveryRecommendation[];
  globalTop: DiscoveryRecommendation[];
  basedOn: DiscoveryBasedOn[];
  topTags: unknown[];
  topGenres: unknown[];
  provider: string | null;
  lastUpdated: string | null;
  metadata: DiscoveryMetadata;
  recommendationQuality: string | null;
  isEnriching: boolean;
  discoveryRunId: string | null;
  enrichmentStartedAt: string | null;
  enrichmentCompletedAt: string | null;
  enrichmentProgressMessage: string | null;
}

export interface DiscoveryCacheUpdate extends DiscoveryMetadata {
  recommendations?: DiscoveryRecommendation[] | null;
  globalTop?: DiscoveryRecommendation[] | null;
  basedOn?: DiscoveryBasedOn[] | null;
  topTags?: unknown[] | null;
  topGenres?: unknown[] | null;
  provider?: string | null;
  lastUpdated?: string | null;
  metadata?: DiscoveryMetadata;
}

export interface DiscoveryRefreshSource {
  metadata: DiscoveryMetadata;
  lastUpdated: string | null;
}

export interface DiscoveryCacheOps {
  getDiscoveryRefreshSource: (cacheNamespace?: string | null) => DiscoveryRefreshSource;
  getDiscoveryCache: (cacheNamespace?: string | null) => DiscoveryCache;
  updateDiscoveryCache: (discovery: DiscoveryCacheUpdate, cacheNamespace?: string | null) => void;
  invalidateDiscoveryCache: (cacheNamespace: string) => void;
  deleteDiscoveryCacheByPrefix: (prefix: string) => Database.RunResult;
}

const getDiscoveryCacheStmt = db.prepare<
  [string],
  Pick<DiscoveryCacheRow, "value" | "last_updated">
>("SELECT value, last_updated FROM discovery_cache WHERE key = ?");
const upsertDiscoveryCacheStmt = db.prepare<[string, string | null, string]>(
  "INSERT OR REPLACE INTO discovery_cache (key, value, last_updated) VALUES (?, ?, ?)",
);
const getDiscoveryCacheUpdatedAtStmt = db.prepare<
  [string],
  Pick<DiscoveryCacheRow, "last_updated">
>("SELECT last_updated FROM discovery_cache WHERE key = ?");
const DISCOVERY_METADATA_FIELDS = [
  "recommendationQuality",
  "isEnriching",
  "discoveryRunId",
  "enrichmentStartedAt",
  "enrichmentCompletedAt",
  "enrichmentProgressMessage",
];

const discoveryUserCache = new Map<string, { at: number; value: DiscoveryCache }>();
const DISCOVERY_USER_CACHE_TTL_MS = 10_000;

function pruneDiscoveryUserCache() {
  const now = Date.now();
  for (const [key, entry] of discoveryUserCache) {
    if (now - entry.at >= DISCOVERY_USER_CACHE_TTL_MS) {
      discoveryUserCache.delete(key);
    }
  }
}

function readUpdatedAt(key: string) {
  return getDiscoveryCacheUpdatedAtStmt.get(key)?.last_updated || null;
}

function readLastUpdated(cacheNamespace: string | null | undefined, prefix: string) {
  return cacheNamespace
    ? getDiscoveryCacheStmt.get(`${prefix}lastUpdated`)?.value ||
        readUpdatedAt(`${prefix}recommendations`)
    : readUpdatedAt(`${prefix}recommendations`) || readUpdatedAt(`${prefix}globalTop`);
}

function readMetadata(prefix: string): DiscoveryMetadata {
  return dbHelpers.parseJSON(getDiscoveryCacheStmt.get(`${prefix}metadata`)?.value) || {};
}

export default function register(dbOps: DiscoveryCacheOps) {
  dbOps.getDiscoveryRefreshSource = function (cacheNamespace = null) {
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";
    return {
      metadata: readMetadata(prefix),
      lastUpdated: readLastUpdated(cacheNamespace, prefix),
    };
  };

  dbOps.getDiscoveryCache = function (cacheNamespace = null) {
    const prefix = cacheNamespace ? `${cacheNamespace}:` : "";

    if (cacheNamespace) {
      pruneDiscoveryUserCache();
      const cached = discoveryUserCache.get(cacheNamespace);
      if (cached) return cached.value;
    }

    const metadata = readMetadata(prefix);
    const recommendationsRow = getDiscoveryCacheStmt.get(`${prefix}recommendations`);
    const recommendations = dbHelpers.parseJSON(recommendationsRow?.value);
    const globalTopRow = getDiscoveryCacheStmt.get(`${prefix}globalTop`);
    const globalTop = dbHelpers.parseJSON(globalTopRow?.value);
    const basedOn = dbHelpers.parseJSON(getDiscoveryCacheStmt.get(`${prefix}basedOn`)?.value);
    const topTags = dbHelpers.parseJSON(getDiscoveryCacheStmt.get(`${prefix}topTags`)?.value);
    const topGenres = dbHelpers.parseJSON(getDiscoveryCacheStmt.get(`${prefix}topGenres`)?.value);
    const provider = getDiscoveryCacheStmt.get(`${prefix}provider`)?.value || null;
    const lastUpdated = readLastUpdated(cacheNamespace, prefix);

    const result = {
      recommendations: recommendations || [],
      globalTop: globalTop || [],
      basedOn: basedOn || [],
      topTags: topTags || [],
      topGenres: topGenres || [],
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
          now,
        );
      }
      if (discovery.globalTop) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}globalTop`,
          dbHelpers.stringifyJSON(discovery.globalTop),
          now,
        );
      }
      if (discovery.basedOn) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}basedOn`,
          dbHelpers.stringifyJSON(discovery.basedOn),
          now,
        );
      }
      if (discovery.topTags) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}topTags`,
          dbHelpers.stringifyJSON(discovery.topTags),
          now,
        );
      }
      if (discovery.topGenres) {
        upsertDiscoveryCacheStmt.run(
          `${prefix}topGenres`,
          dbHelpers.stringifyJSON(discovery.topGenres),
          now,
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
          dbHelpers.parseJSON(getDiscoveryCacheStmt.get(`${prefix}metadata`)?.value) || {};
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
      if (cacheNamespace && discovery.recommendations) {
        upsertDiscoveryCacheStmt.run(`${prefix}lastUpdated`, now, now);
      }
    });
    updateFn();
  };

  dbOps.invalidateDiscoveryCache = function (cacheNamespace) {
    discoveryUserCache.delete(cacheNamespace);
  };

  dbOps.deleteDiscoveryCacheByPrefix = function (prefix) {
    for (const namespace of discoveryUserCache.keys()) {
      if (`${namespace}:`.startsWith(prefix)) discoveryUserCache.delete(namespace);
    }
    return db.prepare<[string]>("DELETE FROM discovery_cache WHERE key LIKE ?").run(`${prefix}%`);
  };
}
