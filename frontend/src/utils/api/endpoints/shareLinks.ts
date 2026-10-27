import { deleteData, getData, postData } from "../core.ts";
import type {
  ShareAvailabilityResponse,
  ShareLinkCreatedResponse,
  ShareLinkRequest,
  ShareLinksResponse,
  ShareTargetInput,
  ShareImportPreviewResponse,
  ShareImportQueuedResponse,
  ShareImportRequest,
  PlainShareLinkCreatedResponse,
  ShareOpenResponse,
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

export const createPlainShareLink = (manifest: unknown): Promise<PlainShareLinkCreatedResponse> =>
  postData("/share-links/plain", { manifest });

export const deleteShareLink = (id: number): Promise<void> =>
  deleteData(`/share-links/${encodeURIComponent(id)}`);

export const previewShareImport = (url: string): Promise<ShareImportPreviewResponse> =>
  postData("/share-links/import/preview", { url });

export const openShareLink = (url: string): Promise<ShareOpenResponse> =>
  postData("/share-links/open", { url });

export const importShareLink = (request: ShareImportRequest): Promise<ShareImportQueuedResponse> =>
  postData("/share-links/import", request);
