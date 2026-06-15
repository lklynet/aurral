import { resolveRemotePath, looksLikeExternalOnlyPath } from "./pathMappings.js";

let storedM3uPathMode = "local";

export function normalizeM3uPathMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "remote" ? "remote" : "local";
}

export function syncM3uPathMode(value) {
  storedM3uPathMode = normalizeM3uPathMode(value);
}

export function parseM3uPathModeEnv() {
  const raw = String(process.env.M3U_PATH_MODE || "").trim();
  if (!raw) return null;
  return normalizeM3uPathMode(raw);
}

export function getM3uPathMode() {
  const fromEnv = parseM3uPathModeEnv();
  if (fromEnv) return fromEnv;
  return storedM3uPathMode;
}

export function resolveM3uTrackPath(job, localPath, mode = getM3uPathMode()) {
  const resolvedLocal = String(localPath || "").trim();
  if (!resolvedLocal || mode !== "remote") {
    return resolvedLocal;
  }
  const externalPath = String(job?.externalPath || "").trim();
  if (externalPath && looksLikeExternalOnlyPath(externalPath)) {
    return externalPath.replace(/\\/g, "/");
  }
  return resolveRemotePath(resolvedLocal);
}
