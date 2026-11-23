import type { DiscoveryFeedbackEntry as BackendDiscoveryFeedbackEntry } from "../../../backend/services/discovery/feedback.ts";
import {
  artistMatchKeys,
  isSameArtist,
  matchesArtistKeys,
  type ArtistMatchFields,
} from "../../../lib/artistMatch.ts";

export type DiscoveryFeedbackEntry = Partial<Omit<BackendDiscoveryFeedbackEntry, "artistId">> & {
  artistId?: string | number | null;
};

interface DiscoveryFeedbackGetResponse {
  feedback: DiscoveryFeedbackEntry[];
  feedbackList?: undefined;
}

interface DiscoveryFeedbackPostResponse {
  success: boolean;
  feedback: DiscoveryFeedbackEntry;
  feedbackList: DiscoveryFeedbackEntry[];
}

interface DiscoveryFeedbackListResponse {
  success: boolean;
  feedback?: undefined;
  feedbackList: DiscoveryFeedbackEntry[];
}

type DiscoveryFeedbackResponse =
  | DiscoveryFeedbackGetResponse
  | DiscoveryFeedbackPostResponse
  | DiscoveryFeedbackListResponse;

type DiscoveryFeedbackInput =
  | DiscoveryFeedbackEntry[]
  | DiscoveryFeedbackResponse
  | null
  | undefined;

const ARTIST_FEEDBACK_ACTIONS = new Set(["more_like_this", "less_like_this", "block_artist"]);

export const DISCOVERY_FEEDBACK_LABELS: Partial<Record<string, string>> = {
  more_like_this: "More like this",
  less_like_this: "Less like this",
  block_artist: "Block artist",
};

export const normalizeDiscoveryFeedbackList = (
  value: DiscoveryFeedbackInput,
): DiscoveryFeedbackEntry[] => {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.feedback)) return value.feedback;
  if (value && Array.isArray(value.feedbackList)) return value.feedbackList;
  return [];
};

const entryArtist = (entry: DiscoveryFeedbackEntry | null | undefined) => ({
  id: entry?.artistId,
  name: entry?.artistName,
});

const entryMatchesArtist = (
  entry: DiscoveryFeedbackEntry | null | undefined,
  artist: ArtistMatchFields | null | undefined,
) => isSameArtist(entryArtist(entry), artist);

export const getOppositeRatingAction = (action: string | null | undefined) => {
  if (action === "more_like_this") return "less_like_this";
  if (action === "less_like_this") return "more_like_this";
  return null;
};

export const findArtistFeedbackEntryId = (
  feedbackList: DiscoveryFeedbackInput,
  artist: ArtistMatchFields | null | undefined,
  action: string,
) => {
  for (const entry of normalizeDiscoveryFeedbackList(feedbackList)) {
    if (entry.action !== action) continue;
    if (!entryMatchesArtist(entry, artist)) continue;
    const id = String(entry?.id || "").trim();
    if (id) return id;
  }
  return null;
};

export const buildArtistFeedbackLookup = (feedbackList: DiscoveryFeedbackInput) => {
  const lookup = new Map<string, Set<string>>();
  for (const entry of normalizeDiscoveryFeedbackList(feedbackList)) {
    const action = String(entry?.action || "").trim();
    if (!ARTIST_FEEDBACK_ACTIONS.has(action)) continue;
    const keys = lookup.get(action) ?? new Set<string>();
    for (const key of artistMatchKeys(entryArtist(entry))) keys.add(key);
    lookup.set(action, keys);
  }
  return lookup;
};

export const getArtistFeedbackFlags = (
  lookup: Map<string, Set<string>>,
  artist: ArtistMatchFields | null | undefined,
) => ({
  more_like_this: matchesArtistKeys(artist, lookup.get("more_like_this") ?? new Set()),
  less_like_this: matchesArtistKeys(artist, lookup.get("less_like_this") ?? new Set()),
  block_artist: matchesArtistKeys(artist, lookup.get("block_artist") ?? new Set()),
});

export const getDiscoveryFeedbackLabel = (action: string) =>
  DISCOVERY_FEEDBACK_LABELS[action] || "";

export const applyArtistDiscoveryFeedback = async ({
  feedbackList,
  artist,
  action,
  isSelected,
  payload,
  addDiscoveryFeedback,
  removeDiscoveryFeedback,
}: {
  feedbackList: DiscoveryFeedbackInput;
  artist: ArtistMatchFields | null | undefined;
  action: string;
  isSelected: boolean;
  payload: DiscoveryFeedbackEntry;
  addDiscoveryFeedback: (
    payload: DiscoveryFeedbackEntry,
  ) => Promise<DiscoveryFeedbackPostResponse | undefined>;
  removeDiscoveryFeedback: (id: string) => Promise<DiscoveryFeedbackListResponse | undefined>;
}) => {
  let feedback = normalizeDiscoveryFeedbackList(feedbackList);

  const removeByAction = async (targetAction: string) => {
    const id = findArtistFeedbackEntryId(feedback, artist, targetAction);
    if (!id) return;
    const response = await removeDiscoveryFeedback(id);
    feedback = normalizeDiscoveryFeedbackList(response?.feedbackList || response);
  };

  if (isSelected) {
    await removeByAction(action);
    return { feedbackList: feedback };
  }

  const opposite = getOppositeRatingAction(action);
  if (opposite) await removeByAction(opposite);

  const response = await addDiscoveryFeedback(payload);
  return {
    feedbackList: normalizeDiscoveryFeedbackList(response?.feedbackList || response),
  };
};

export const previewArtistDiscoveryFeedback = (
  feedbackList: DiscoveryFeedbackInput,
  {
    artist,
    action,
    isSelected,
    payload,
  }: {
    artist: ArtistMatchFields | null | undefined;
    action: string;
    isSelected: boolean;
    payload: DiscoveryFeedbackEntry;
  },
) => {
  const opposite = isSelected ? null : getOppositeRatingAction(action);
  const kept = normalizeDiscoveryFeedbackList(feedbackList).filter(
    (entry) =>
      !(
        (entry.action === action || entry.action === opposite) &&
        entryMatchesArtist(entry, artist)
      ),
  );
  if (isSelected) return kept;
  return [{ ...payload, id: `pending:${action}`, createdAt: new Date().toISOString() }, ...kept];
};

export const diffDiscoveryFeedback = (
  previous: DiscoveryFeedbackInput,
  next: DiscoveryFeedbackInput,
) => {
  const previousIds = new Set(normalizeDiscoveryFeedbackList(previous).map((entry) => entry.id));
  const nextIds = new Set(normalizeDiscoveryFeedbackList(next).map((entry) => entry.id));
  return {
    added: normalizeDiscoveryFeedbackList(next).filter((entry) => !previousIds.has(entry.id)),
    removed: normalizeDiscoveryFeedbackList(previous).filter((entry) => !nextIds.has(entry.id)),
  };
};

const feedbackTime = (entry: DiscoveryFeedbackEntry | null | undefined) => {
  const time = new Date(entry?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

export const revertDiscoveryFeedback = (
  feedbackList: DiscoveryFeedbackInput,
  { added, removed }: { added: DiscoveryFeedbackEntry[]; removed: DiscoveryFeedbackEntry[] },
) => {
  const addedIds = new Set(added.map((entry) => entry.id));
  const next = normalizeDiscoveryFeedbackList(feedbackList).filter(
    (entry) => !addedIds.has(entry.id),
  );
  for (const entry of removed) {
    if (next.some((existing) => existing.id === entry.id)) continue;
    const index = next.findIndex((existing) => feedbackTime(existing) <= feedbackTime(entry));
    next.splice(index < 0 ? next.length : index, 0, entry);
  }
  return next;
};
