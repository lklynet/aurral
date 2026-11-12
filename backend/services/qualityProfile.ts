import * as v from "valibot";
import { dbHelpers } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import { lenient } from "../db/helpers/storedSchemas.ts";
import type { LibraryMediaFilesRow } from "../db/rows.ts";
import { libraryFolderOwner, readOnlyFolderPaths } from "./libraryFolders.ts";
import {
  downloadTracker,
  type DownloadJob,
  type DownloadJobState,
} from "./downloadJobs/downloadTracker.ts";
import {
  classifyAudioQuality,
  getQualityState,
  type QualityState,
  getQualityTier,
  isQualityUpgrade,
  normalizeQualityProfile,
} from "./qualityProfileModel.ts";

export type QualityJob = DownloadJobState &
  Pick<
    DownloadJob,
    | "id"
    | "upgradeForJobId"
    | "albumMbid"
    | "artistName"
    | "trackName"
    | "albumName"
    | "playlistId"
    | "playlistType"
    | "playlistGeneration"
    | "downloadSource"
    | "downloadClient"
    | "manualReplacementSearch"
    | "qualityTier"
    | "qualityFormat"
    | "qualityBitrateKbps"
    | "qualitySampleRate"
    | "qualityBitDepth"
    | "qualityCheckedAt"
    | "qualityUpgradeCheckedAt"
  >;

export type QualityProfile = ReturnType<typeof getQualityProfile>;

export function getQualityProfile() {
  const settings = dbOps.getSettings();
  return normalizeQualityProfile(settings.qualityProfile, settings.integrations?.slskd);
}

export function isAurralOwnedPath(
  filePath: string | null | undefined,
  readOnlyRoots = readOnlyFolderPaths(),
) {
  if (!filePath) return false;
  return libraryFolderOwner(filePath, { readOnlyRoots }) === "aurral";
}

function getJobQuality(job: QualityJob, profile: QualityProfile, readOnlyRoots: string[]) {
  const quality = {
    tier: job.qualityTier || null,
    format: job.qualityFormat || null,
    bitrateKbps: job.qualityBitrateKbps ?? null,
    sampleRate: job.qualitySampleRate ?? null,
    bitDepth: job.qualityBitDepth ?? null,
  };
  const owned = isAurralOwnedPath(job.finalPath, readOnlyRoots);
  const qualityState: QualityState | null =
    job.status === "done" ? (owned ? getQualityState(quality, profile) : "external") : null;
  return {
    qualityOwned: owned,
    qualityState,
    qualityLabel: getQualityTier(quality.tier)?.label || "Unknown",
  };
}

export function decorateJobQuality<T extends QualityJob>(
  job: T,
  profile = getQualityProfile(),
  readOnlyRoots = readOnlyFolderPaths(),
) {
  return { ...job, ...(!job.upgradeForJobId && getJobQuality(job, profile, readOnlyRoots)) };
}

const storedQualitySchema = v.looseObject({
  format: lenient(v.nullable(v.string())),
  bitrate: lenient(v.nullable(v.number())),
  sampleRate: lenient(v.nullable(v.number())),
  bitsPerSample: lenient(v.nullable(v.number())),
});

export function classifyLibraryFileQuality(
  file: Pick<LibraryMediaFilesRow, "path" | "quality_json">,
) {
  const stored = dbHelpers.readJSON(storedQualitySchema, file.quality_json, file.path) ?? {};
  return classifyAudioQuality(
    {
      format: {
        codec: stored.format,
        bitrate: stored.bitrate,
        sampleRate: stored.sampleRate,
        bitsPerSample: stored.bitsPerSample,
      },
    },
    file.path,
  );
}

export function validateParsedQuality(
  parsed: Parameters<typeof classifyAudioQuality>[0],
  filePath: string,
  {
    upgradeForJobId = null,
    manualReplacementSearch = false,
    manualSelection = false,
  }: {
    upgradeForJobId?: string | null;
    manualReplacementSearch?: boolean;
    manualSelection?: boolean;
  } = {},
) {
  const profile = getQualityProfile();
  const quality = classifyAudioQuality(parsed, filePath);
  const enabled = quality.tier !== null && profile.enabled.includes(quality.tier);
  if (!quality.tier || (!enabled && !manualSelection)) {
    return {
      valid: false,
      quality,
      reason: quality.tier
        ? `quality-below-floor: ${quality.tier}`
        : "quality-unknown: could not classify final file",
    };
  }
  if (upgradeForJobId && !manualReplacementSearch) {
    const current = downloadTracker.getJob(upgradeForJobId);
    if (!current || !isQualityUpgrade(quality, current.qualityTier, profile)) {
      return {
        valid: false,
        quality,
        reason: `quality-not-an-upgrade: current=${current?.qualityTier || "unknown"}, candidate=${quality.tier}`,
      };
    }
  }
  return { valid: true, quality, reason: null };
}
