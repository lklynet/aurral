export const DEFAULT_WORKER_SETTINGS = {
  concurrency: 2,
  preferredFormat: "flac",
  preferredFormatStrict: false,
  retryCycleMinutes: 15,
  existingFileMode: "hardlink",
};

export const FLOW_WORKER_RETRY_CYCLE_OPTIONS = [15, 30, 60, 360, 720, 1440];
export const FLOW_WORKER_EXISTING_FILE_MODES = ["download", "hardlink", "copy"];

export const normalizeRetryCycleMinutes = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_WORKER_SETTINGS.retryCycleMinutes;
  const normalized = Math.floor(parsed);
  if (FLOW_WORKER_RETRY_CYCLE_OPTIONS.includes(normalized)) {
    return normalized;
  }
  return DEFAULT_WORKER_SETTINGS.retryCycleMinutes;
};

export const normalizeExistingFileMode = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return FLOW_WORKER_EXISTING_FILE_MODES.includes(normalized)
    ? normalized
    : DEFAULT_WORKER_SETTINGS.existingFileMode;
};

export const getWorkerSettingsFromStatus = (status) => {
  const raw = status?.worker?.settings || {};
  const parsedConcurrency = Number(raw.concurrency);
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.min(3, Math.floor(parsedConcurrency))
      : DEFAULT_WORKER_SETTINGS.concurrency;
  const preferredFormat =
    String(raw.preferredFormat || "").toLowerCase() === "mp3" ? "mp3" : "flac";
  const preferredFormatStrict = raw.preferredFormatStrict === true;
  const retryCycleMinutes = normalizeRetryCycleMinutes(raw.retryCycleMinutes);
  const existingFileMode = normalizeExistingFileMode(raw.existingFileMode);
  return {
    concurrency,
    preferredFormat,
    preferredFormatStrict,
    retryCycleMinutes,
    existingFileMode,
  };
};
