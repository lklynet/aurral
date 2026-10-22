import { getData, patchData, postData } from "../core.ts";
import type {
  InboxItemResponse,
  InboxReadAllResponse,
  InboxResponse,
} from "../../../../../backend/routes/inbox.ts";

type InboxListItem = NonNullable<InboxResponse["items"][number]> & { id: string };

export type InboxListResponse = Omit<InboxResponse, "items"> & { items: InboxListItem[] };

export const getInbox = ({
  zip = "",
  limit = 50,
  signal,
}: { zip?: string; limit?: number; signal?: AbortSignal } = {}): Promise<InboxListResponse> =>
  getData("/inbox", { params: { zip, limit }, signal });

export const updateInboxItem = (id: string, action: string): Promise<InboxItemResponse> =>
  patchData(`/inbox/${encodeURIComponent(id)}`, { action });

export const markAllInboxItemsRead = (): Promise<InboxReadAllResponse> =>
  postData("/inbox/read-all");
