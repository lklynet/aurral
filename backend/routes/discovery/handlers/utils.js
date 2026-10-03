import { lastfmRequest } from "../../../services/apiClients/index.js";

export const SLSKD_NOT_CONFIGURED_MESSAGE =
  "slskd is not configured. Enable slskd and add its Server URL in Settings > Download clients to enable Soulseek downloads for flows and playlists.";

const pendingTagRequests = new Map();
const pendingTagSuggestRequest = { promise: null, expiry: 0 };

export { pendingTagRequests, pendingTagSuggestRequest };

export const fetchLastfmTopTagNames = async () => {
  const now = Date.now();
  let data;
  if (
    pendingTagSuggestRequest.promise &&
    pendingTagSuggestRequest.expiry > now
  ) {
    data = await pendingTagSuggestRequest.promise;
  } else {
    const fetchPromise = lastfmRequest("chart.getTopTags", { limit: 100 });
    pendingTagSuggestRequest.promise = fetchPromise;
    pendingTagSuggestRequest.expiry = now + 60000;
    data = await fetchPromise;
  }
  if (!data?.tags?.tag) return [];
  const tags = Array.isArray(data.tags.tag) ? data.tags.tag : [data.tags.tag];
  return tags
    .map((tag) => (tag.name != null ? String(tag.name).trim() : ""))
    .filter(Boolean);
};
