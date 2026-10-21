import { getData, postData, deleteData } from "../core.ts";
import type { DiscoverResponse } from "../../../../../backend/routes/discovery/handlers/main.ts";
import type { DiscoveryRefreshResponse } from "../../../../../backend/routes/discovery/handlers/admin.ts";
import type { NearbyShowsResponse } from "../../../../../backend/routes/discovery/handlers/shows.ts";
import type { TagSuggestionsResponse } from "../../../../../backend/routes/discovery/handlers/tags.ts";
import type {
  DiscoveryFeedbackAddResponse,
  DiscoveryFeedbackListResponse,
  DiscoveryFeedbackResponse,
} from "../../../../../backend/routes/discovery/handlers/feedback.ts";
import type { getDiscoveryFeedback as getDiscoveryFeedbackRecord } from "../../../../../backend/services/discovery/index.ts";
import type { DiscoveryFeedbackInput } from "../../../../../backend/services/discovery/feedback.ts";
import type {
  EditorialLibraryAddResponse,
  getEditorialPlaylist as getEditorialPlaylistRecord,
  getEditorialShelf as getEditorialShelfRecord,
  resolveEditorialTrackLinks as resolveEditorialTrackLinksRecord,
} from "../../../../../backend/services/discovery/editorialPlaylists.ts";
import type { getDiscoveryStatus as getDiscoveryStatusRecord } from "../../../../../backend/services/discovery/userDiscovery.ts";

type DiscoveryFeedbackEntry = ReturnType<typeof getDiscoveryFeedbackRecord>[number];

export const getDiscovery = (
  options:
    | boolean
    | { offset?: number; limit?: number; cacheBust?: boolean; signal?: AbortSignal } = false,
): Promise<DiscoverResponse> => {
  const params: Record<string, number> = {};
  let signal: AbortSignal | undefined;
  if (typeof options === "boolean") {
    if (options) params._ = Date.now();
  } else if (options && typeof options === "object") {
    const { offset, limit, cacheBust } = options;
    signal = options.signal;
    if (cacheBust) params._ = Date.now();
    if (typeof offset === "number") params.offset = offset;
    if (typeof limit === "number") params.limit = limit;
  }
  return getData("/discover", { params, signal });
};

export const getDiscoveryStatus = ({ signal }: { signal?: AbortSignal } = {}): Promise<
  ReturnType<typeof getDiscoveryStatusRecord>
> => getData("/discover/status", { signal });

export const refreshDiscovery = (): Promise<DiscoveryRefreshResponse> =>
  postData("/discover/refresh");

export const getEditorialShelf = (
  options: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof getEditorialShelfRecord>>> =>
  getData("/discover/editorial", options);

export const getEditorialPlaylist = (
  playlistId: string,
  options: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof getEditorialPlaylistRecord>>> =>
  getData(`/discover/editorial/${encodeURIComponent(playlistId)}`, options);

export const addEditorialPlaylistToLibrary = (
  playlistId: string,
): Promise<EditorialLibraryAddResponse> =>
  postData(`/discover/editorial/${encodeURIComponent(playlistId)}/library`);

export const resolveEditorialTrackLinks = (
  {
    artistName,
    albumName,
    deezerAlbumId,
  }: { artistName?: string; albumName?: string; deezerAlbumId?: string },
  options: { signal?: AbortSignal } = {},
): Promise<Awaited<ReturnType<typeof resolveEditorialTrackLinksRecord>>> =>
  getData("/discover/editorial/links", {
    ...options,
    params: {
      artist: artistName,
      album: albumName || undefined,
      albumId: deezerAlbumId || undefined,
    },
  });

export const getNearbyShows = ({
  zip,
  country,
  signal,
}: { zip?: string; country?: string; signal?: AbortSignal } = {}): Promise<NearbyShowsResponse> =>
  getData("/discover/nearby-shows", {
    signal,
    params: {
      ...(zip ? { zip } : {}),
      ...(country ? { country } : {}),
    },
  });

export const getDiscoveryFeedback = (): Promise<DiscoveryFeedbackResponse> =>
  getData("/discover/feedback");

export const addDiscoveryFeedback = (
  payload: DiscoveryFeedbackInput,
): Promise<DiscoveryFeedbackAddResponse> => postData("/discover/feedback", payload);

export const removeDiscoveryFeedback = (id: string): Promise<DiscoveryFeedbackListResponse> =>
  deleteData(`/discover/feedback/${encodeURIComponent(id)}`);

export const restoreDiscoveryFeedback = ({
  removeIds = [],
  entries = [],
}: {
  removeIds?: string[];
  entries?: DiscoveryFeedbackEntry[];
}): Promise<DiscoveryFeedbackListResponse> =>
  postData("/discover/feedback/restore", { removeIds, entries });

export const resetDiscoveryFeedback = (): Promise<DiscoveryFeedbackListResponse> =>
  postData("/discover/feedback/reset");

export const getTagSuggestions = (q: string, limit = 10): Promise<TagSuggestionsResponse> =>
  getData("/discover/tags", {
    params: { q: q.trim(), limit },
  });
