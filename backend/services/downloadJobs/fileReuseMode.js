export const EXISTING_FILE_MODES = new Set(["download", "reuse"]);
const DEFAULT_EXISTING_FILE_MODE = "reuse";

export function normalizeExistingFileMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (EXISTING_FILE_MODES.has(normalized)) {
    return normalized;
  }
  return DEFAULT_EXISTING_FILE_MODE;
}
