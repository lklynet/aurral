import { getLastfmApiKey } from "../apiClients/index.js";

export function normalizeFlowMixForValidation(mix) {
  const source =
    mix && typeof mix === "object" && !Array.isArray(mix) ? mix : {};
  return {
    discover: Math.max(0, Number(source?.discover || 0) || 0),
    mix: Math.max(0, Number(source?.mix || 0) || 0),
    trending: Math.max(0, Number(source?.trending || 0) || 0),
    focus: Math.max(0, Number(source?.focus || 0) || 0),
  };
}

export function getUnavailableFlowSourceError(mix) {
  if (getLastfmApiKey()) return null;
  const normalizedMix = normalizeFlowMixForValidation(mix);
  if (normalizedMix.discover > 0) return "Discover flow source requires Last.fm";
  if (normalizedMix.trending > 0) return "Trending flow source requires Last.fm";
  if (normalizedMix.focus > 0) return "Focus flow source requires Last.fm";
  if (normalizedMix.mix > 0) {
    return "Library flow source requires Last.fm in this version";
  }
  return null;
}
