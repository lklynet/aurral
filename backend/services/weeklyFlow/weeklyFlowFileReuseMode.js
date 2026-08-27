export const EXISTING_FILE_MODES = new Set(["download", "reuse"]);
const LEGACY_REUSE_MODES = new Set(["hardlink", "copy"]);
const DEFAULT_EXISTING_FILE_MODE = "reuse";

export function normalizeExistingFileMode(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (EXISTING_FILE_MODES.has(normalized)) {
    return normalized;
  }
  if (LEGACY_REUSE_MODES.has(normalized)) {
    return "reuse";
  }
  return DEFAULT_EXISTING_FILE_MODE;
}
