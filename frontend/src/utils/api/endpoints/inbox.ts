import { getData, patchData, postData } from "../core.ts";
import type {
  InboxItemResponse,
  InboxReadAllResponse,
  InboxResponse,
} from "../../../../../backend/routes/inbox.ts";

export const getInbox = ({
  zip = "",
  limit = 50,
  signal,
}: { zip?: string; limit?: number; signal?: AbortSignal } = {}): Promise<InboxResponse> =>
  getData("/inbox", { params: { zip, limit }, signal });

export const updateInboxItem = (id: string, action: string): Promise<InboxItemResponse> =>
  patchData(`/inbox/${encodeURIComponent(id)}`, { action });

export const markAllInboxItemsRead = (): Promise<InboxReadAllResponse> =>
  postData("/inbox/read-all");
