import { deleteData, getData, postData } from "../core.ts";
import type {
  ShareAvailabilityResponse,
  ShareLinkCreatedResponse,
  ShareLinkRequest,
  ShareLinksResponse,
  ShareTargetInput,
} from "../../../../../backend/routes/shareLinks.ts";

export const getShareLinks = ({
  signal,
}: { signal?: AbortSignal } = {}): Promise<ShareLinksResponse> =>
  getData("/share-links", { signal });

export const getShareAvailability = (
  params: ShareTargetInput,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ShareAvailabilityResponse> => getData("/share-links/availability", { params, signal });

export const createShareLink = (data: ShareLinkRequest): Promise<ShareLinkCreatedResponse> =>
  postData("/share-links", data);

export const deleteShareLink = (id: number): Promise<void> =>
  deleteData(`/share-links/${encodeURIComponent(id)}`);
