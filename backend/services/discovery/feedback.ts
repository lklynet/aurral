import * as v from "valibot";
import { dbOps } from "../../db/helpers/index.ts";
import { normalizeTextList } from "./helpers.ts";
import { buildArtistMatchKeySet, matchesArtistKeys, type ArtistMatchFields } from "./artistKeys.ts";

const feedbackEntrySchema = v.looseObject({
  createdAt: v.nullish(v.union([v.string(), v.number()])),
  expiresAt: v.nullish(v.union([v.string(), v.number()])),
});

type DiscoveryFeedbackUserId = string | number | null;

const getDiscoveryFeedbackKey = (userId: DiscoveryFeedbackUserId = "global") =>
  `discoveryFeedback:${String(userId || "global").trim()}`;

const normalizeFeedbackAction = (value: unknown) => {
  const action = String(value || "")
    .trim()
    .toLowerCase();
  return ["more_like_this", "less_like_this", "block_artist"].includes(action) ? action : null;
};

export interface DiscoveryFeedbackEntry {
  id: string | null;
  artistId: string | null;
  artistName: string | null;
  action: string | null;
  sourceContext: string | null;
  tagContext: string[];
  seedContext: string[];
  createdAt: string | number | null;
  expiresAt: string | number | null;
}

const normalizeFeedbackList = (value: unknown[]): DiscoveryFeedbackEntry[] =>
  value
    .filter((entry) => v.is(feedbackEntrySchema, entry))
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

export const getDiscoveryFeedback = (userId: DiscoveryFeedbackUserId = "global") =>
  normalizeFeedbackList(
    dbOps.getJSONSetting(getDiscoveryFeedbackKey(userId), v.array(v.unknown())) ?? [],
  );

export const getBlockedArtistKeys = (
  userId: DiscoveryFeedbackUserId = "global",
  feedback = getDiscoveryFeedback(userId),
) =>
  buildArtistMatchKeySet(
    feedback
      .filter((entry) => entry.action === "block_artist")
      .map((entry) => ({ id: entry.artistId, name: entry.artistName })),
  );

export const isArtistBlockedForUser = (
  userId: DiscoveryFeedbackUserId = "global",
  artist: ArtistMatchFields = {},
) => matchesArtistKeys(artist, getBlockedArtistKeys(userId));

export const filterBlockedArtistsForUser = <T extends ArtistMatchFields>(
  userId: DiscoveryFeedbackUserId = "global",
  artists: T[] = [],
  blockedKeys = getBlockedArtistKeys(userId),
) => {
  const list = Array.isArray(artists) ? artists : [];
  if (blockedKeys.size === 0) return list;
  return list.filter((artist) => !matchesArtistKeys(artist, blockedKeys));
};

export type DiscoveryFeedbackInput = {
  id?: string | null;
  action: string | null;
  artistId?: string | number | null;
  artistName?: string | null;
  sourceContext?: string | null;
  tagContext?: string[] | null;
  seedContext?: string[] | null;
};

export const addDiscoveryFeedback = (
  userId: DiscoveryFeedbackUserId = "global",
  entry: Partial<DiscoveryFeedbackInput> = {},
) => {
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
    id: String(entry.id || "").trim() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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
      (artistName && item.artistName && artistName.toLowerCase() === item.artistName.toLowerCase());
    return !(sameArtist && item.action === action);
  });
  deduped.unshift(normalizedEntry);
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), deduped.slice(0, 200));
  return normalizedEntry;
};

export const removeDiscoveryFeedback = (
  userId: DiscoveryFeedbackUserId = "global",
  feedbackId: string,
) => {
  const target = String(feedbackId || "").trim();
  const next = getDiscoveryFeedback(userId).filter((entry) => entry.id !== target);
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), next);
  return next;
};

const feedbackTime = (entry: DiscoveryFeedbackEntry | undefined) => {
  const time = new Date(entry?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

export const restoreDiscoveryFeedback = (
  userId: DiscoveryFeedbackUserId = "global",
  { removeIds = [], entries = [] }: { removeIds?: unknown[]; entries?: unknown[] } = {},
) => {
  const removing = new Set<string | null>(
    (Array.isArray(removeIds) ? removeIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const next = getDiscoveryFeedback(userId).filter((entry) => !removing.has(entry.id));
  for (const entry of normalizeFeedbackList(entries)) {
    if (!entry.id || !entry.createdAt || next.some((existing) => existing.id === entry.id))
      continue;
    const index = next.findIndex((existing) => feedbackTime(existing) <= feedbackTime(entry));
    next.splice(index < 0 ? next.length : index, 0, entry);
  }
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), next.slice(0, 200));
  return getDiscoveryFeedback(userId);
};

export const resetDiscoveryFeedback = (userId: DiscoveryFeedbackUserId = "global") => {
  const blockedArtists = getDiscoveryFeedback(userId).filter(
    (entry) => entry.action === "block_artist",
  );
  dbOps.setJSONSetting(getDiscoveryFeedbackKey(userId), blockedArtists);
  return blockedArtists;
};
