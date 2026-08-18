export const isMissingAurralJob = (job) =>
  job?.status === "failed" && !job?.upgradeForJobId;

export const isCutoffUnmetAurralJob = (job) =>
  job?.status === "done" &&
  job?.qualityOwned === true &&
  job?.qualityState !== "preferred";

export const getMissingJobKey = (job) => String(job?.id || "");

export const sortMissingJobs = (left, right) =>
  Number(right?.createdAt || 0) - Number(left?.createdAt || 0) ||
  String(left?.trackName || "").localeCompare(String(right?.trackName || ""));
