const ARTIST_FEEDBACK_ACTIONS = new Set([
  "more_like_this",
  "less_like_this",
  "block_artist",
]);

export const DISCOVERY_FEEDBACK_LABELS = {
  more_like_this: "More like this",
  less_like_this: "Less like this",
  block_artist: "Block artist",
};

export const normalizeDiscoveryFeedbackList = (value) => {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.feedback)) return value.feedback;
  if (value && Array.isArray(value.feedbackList)) return value.feedbackList;
  return [];
};

const getArtistMatchKeys = (artist) => {
  const keys = [];
  for (const value of [artist?.id, artist?.mbid, artist?.foreignArtistId, artist?.artistMbid]) {
    const artistId = String(value || "").trim().toLowerCase();
    if (artistId) keys.push(`id:${artistId}`);
  }
  const aliases = Array.isArray(artist?.artistAliases) ? artist.artistAliases : [];
  for (const value of [artist?.name, artist?.artistName, ...aliases]) {
    const artistName = String(value || "").trim().toLowerCase();
    if (artistName) keys.push(`name:${artistName}`);
  }
  return [...new Set(keys)];
};

const entryMatchesArtist = (entry, artist) => {
  const artistKeys = new Set(getArtistMatchKeys(artist));
  const entryId = String(entry?.artistId || "")
    .trim()
    .toLowerCase();
  const entryName = String(entry?.artistName || "")
    .trim()
    .toLowerCase();
  if (entryId && artistKeys.has(`id:${entryId}`)) return true;
  if (entryName && artistKeys.has(`name:${entryName}`)) return true;
  return false;
};

export const artistsShareDiscoveryIdentity = (left, right) => {
  const leftKeys = new Set(getArtistMatchKeys(left));
  return getArtistMatchKeys(right).some((key) => leftKeys.has(key));
};

export const getOppositeRatingAction = (action) => {
  if (action === "more_like_this") return "less_like_this";
  if (action === "less_like_this") return "more_like_this";
  return null;
};

export const findArtistFeedbackEntryId = (feedbackList, artist, action) => {
  for (const entry of normalizeDiscoveryFeedbackList(feedbackList)) {
    if (entry.action !== action) continue;
    if (!entryMatchesArtist(entry, artist)) continue;
    const id = String(entry?.id || "").trim();
    if (id) return id;
  }
  return null;
};

export const buildArtistFeedbackLookup = (feedbackList) => {
  const lookup = new Map();
  for (const entry of normalizeDiscoveryFeedbackList(feedbackList)) {
    const action = String(entry?.action || "").trim();
    if (!ARTIST_FEEDBACK_ACTIONS.has(action)) continue;
    const artistId = String(entry?.artistId || "")
      .trim()
      .toLowerCase();
    const artistName = String(entry?.artistName || "")
      .trim()
      .toLowerCase();
    const keys = [];
    if (artistId) keys.push(`id:${artistId}`);
    if (artistName) keys.push(`name:${artistName}`);
    for (const key of keys) {
      const existing = lookup.get(key);
      if (existing) existing.add(action);
      else lookup.set(key, new Set([action]));
    }
  }
  return lookup;
};

export const getArtistFeedbackFlags = (lookup, artist) => {
  const actions = new Set();
  for (const key of getArtistMatchKeys(artist)) {
    const entry = lookup.get(key);
    if (entry) entry.forEach((action) => actions.add(action));
  }
  return {
    more_like_this: actions.has("more_like_this"),
    less_like_this: actions.has("less_like_this"),
    block_artist: actions.has("block_artist"),
  };
};

export const getDiscoveryFeedbackLabel = (action) => DISCOVERY_FEEDBACK_LABELS[action] || "";

export const applyArtistDiscoveryFeedback = async ({
  feedbackList,
  artist,
  action,
  isSelected,
  payload,
  addDiscoveryFeedback,
  removeDiscoveryFeedback,
}) => {
  let feedback = normalizeDiscoveryFeedbackList(feedbackList);

  const removeByAction = async (targetAction) => {
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

export const previewArtistDiscoveryFeedback = (feedbackList, { artist, action, isSelected, payload }) => {
  const opposite = isSelected ? null : getOppositeRatingAction(action);
  const kept = normalizeDiscoveryFeedbackList(feedbackList).filter(
    (entry) => !((entry.action === action || entry.action === opposite) && entryMatchesArtist(entry, artist)),
  );
  if (isSelected) return kept;
  return [{ ...payload, id: `pending:${action}`, createdAt: new Date().toISOString() }, ...kept];
};

export const diffDiscoveryFeedback = (previous, next) => {
  const previousIds = new Set(normalizeDiscoveryFeedbackList(previous).map((entry) => entry.id));
  const nextIds = new Set(normalizeDiscoveryFeedbackList(next).map((entry) => entry.id));
  return {
    added: normalizeDiscoveryFeedbackList(next).filter((entry) => !previousIds.has(entry.id)),
    removed: normalizeDiscoveryFeedbackList(previous).filter((entry) => !nextIds.has(entry.id)),
  };
};

const feedbackTime = (entry) => {
  const time = new Date(entry?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

export const revertDiscoveryFeedback = (feedbackList, { added, removed }) => {
  const addedIds = new Set(added.map((entry) => entry.id));
  const next = normalizeDiscoveryFeedbackList(feedbackList).filter((entry) => !addedIds.has(entry.id));
  for (const entry of removed) {
    if (next.some((existing) => existing.id === entry.id)) continue;
    const index = next.findIndex((existing) => feedbackTime(existing) <= feedbackTime(entry));
    next.splice(index < 0 ? next.length : index, 0, entry);
  }
  return next;
};
