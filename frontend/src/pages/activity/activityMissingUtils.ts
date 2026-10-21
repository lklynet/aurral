export type MissingJobQualityState = "below-floor" | "upgrade" | "preferred" | "external";

export interface MissingJob {
  id?: string | number;
  status?: string;
  upgradeForJobId?: string | number | null;
  monitored?: boolean;
  qualityOwned?: boolean;
  qualityState?: MissingJobQualityState | null;
  createdAt?: number;
  trackName?: string | null;
}

export const isMissingAurralJob = (job: MissingJob | null | undefined) =>
  job?.status === "failed" && !job?.upgradeForJobId && job?.monitored !== false;

export const isCutoffUnmetAurralJob = (job: MissingJob | null | undefined) =>
  job?.status === "done" &&
  job?.qualityOwned === true &&
  job?.qualityState !== "preferred" &&
  job?.monitored !== false;

export const getMissingJobKey = (job: MissingJob | null | undefined) => String(job?.id || "");

export const sortMissingJobs = (
  left: MissingJob | null | undefined,
  right: MissingJob | null | undefined,
) =>
  Number(right?.createdAt || 0) - Number(left?.createdAt || 0) ||
  String(left?.trackName || "").localeCompare(String(right?.trackName || ""));
