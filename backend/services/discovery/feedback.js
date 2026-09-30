import { dbOps } from "../../db/helpers/index.js";
import { normalizeTextList } from "./helpers.js";

const getDiscoveryFeedbackKey = (userId = "global") =>
  `discoveryFeedback:${String(userId || "global").trim()}`;

const normalizeFeedbackAction = (value) => {
  const action = String(value || "").trim().toLowerCase();
  return ["more_like_this", "less_like_this", "block_artist"].includes(action)
    ? action
    : null;
};

const normalizeFeedbackList = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      id: String(entry.id || "").trim() || null,
      artistId: String(entry.artistId || "").trim() || null,
      artistName: String(entry.artistName || "").trim() || null,
      action: normalizeFeedbackAction(entry.action),
      sourceContext: String(entry.sourceContext || "").trim() || null,
      tagContext: normalizeTextList(entry.tagContext).slice(0, 8),
      seedContext: normalizeTextList(entry.seedContext).slice(0, 8),
      createdAt: entry.createdAt || null,
      expiresAt: entry.expiresAt || null,
    }))
    .filter((entry) => entry.action && (entry.artistId || entry.artistName))
    .filter((entry) => {
      if (!entry.expiresAt) return true;
      const time = new Date(entry.expiresAt).getTime();
      return Number.isFinite(time) ? time > Date.now() : true;
    });

export const getDiscoveryFeedback = (userId = "global") =>
  normalizeFeedbackList(dbOps.getJSONSetting(getDiscoveryFeedbackKey(userId)));

const normalizeArtistKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

export const getBlockedArtistKeys = (userId = "global", feedback = getDiscoveryFeedback(userId)) => {
  const keys = new Set();
  for (const entry of feedback) {
    if (entry.action !== "block_artist") continue;
    const artistId = normalizeArtistKey(entry.artistId);
    const artistName = normalizeArtistKey(entry.artistName);
    if (artistId) keys.add(artistId);
    if (artistName) keys.add(artistName);
  }
  return keys;
};

export const isArtistBlockedForUser = (userId = "global", artist = {}) => {
  const blockedKeys = getBlockedArtistKeys(userId);
  if (blockedKeys.size === 0) return false;
  return artistMatchesBlockedKeys(artist, blockedKeys);
};

const artistMatchesBlockedKeys = (artist, blockedKeys) => {
  const aliases = Array.isArray(artist?.artistAliases) ? artist.artistAliases : [];
  const artistKeys = [
    artist?.id,
    artist?.mbid,
    artist?.foreignArtistId,
    artist?.artistMbid,
    artist?.name,
    artist?.artistName,
    ...aliases,
  ]
    .map(normalizeArtistKey)
    .filter(Boolean);
  return artistKeys.some((key) => blockedKeys.has(key));
};

export const filterBlockedArtistsForUser = (userId = "global", artists = [], blockedKeys = getBlockedArtistKeys(userId)) => {
  if (blockedKeys.size === 0) return Array.isArray(artists) ? artists : [];
  return (Array.isArray(artists) ? artists : []).filter(
    (artist) => !artistMatchesBlockedKeys(artist, blockedKeys),
  );
};

export const addDiscoveryFeedback = (userId = "global", entry = {}) => {
  const action = normalizeFeedbackAction(entry.action);
  if (!action) throw new Error("Invalid discovery feedback action");
  const artistId = String(entry.artistId || "").trim() || null;
  const artistName = String(entry.artistName || "").trim() || null;
  if (!artistId && !artistName) {
    throw new Error("artistId or artistName is required");
  }

  const existing = getDiscoveryFeedback(userId);
  const now = new Date();
  const normalizedEntry = {
    id:
      String(entry.id || "").trim() ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    artistId,
    artistName,
    action,
    sourceContext: String(entry.sourceContext || "").trim() || null,
    tagContext: normalizeTextList(entry.tagContext).slice(0, 8),
    seedContext: normalizeTextList(entry.seedContext).slice(0, 8),
    createdAt: now.toISOString(),
    expiresAt: null,
  };
  const deduped = existing.filter((item) => {
    const sameArtist =
      (artistId && item.artistId && artistId === item.artistId) ||
      (artistName &&
        item.artistName &&
        artistName.toLowerCase() === item.artistName.toLowerCase());
    return !(sameArtist && item.action === action);
  });
  deduped.unshift(normalizedEntry);
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), deduped.slice(0, 200));
  return normalizedEntry;
};

export const removeDiscoveryFeedback = (userId = "global", feedbackId) => {
  const target = String(feedbackId || "").trim();
  const next = getDiscoveryFeedback(userId).filter(
    (entry) => entry.id !== target,
  );
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), next);
  return next;
};

export const resetDiscoveryFeedback = (userId = "global") => {
  const blockedArtists = getDiscoveryFeedback(userId).filter(
    (entry) => entry.action === "block_artist",
  );
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), blockedArtists);
  return blockedArtists;
};
