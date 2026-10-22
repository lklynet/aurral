import { getData, patchData, postData } from "../core.ts";

export const getInbox = ({ zip = "", limit = 50, signal } = {}) =>
  getData("/inbox", { params: { zip, limit }, signal });

export const updateInboxItem = (id, action) =>
  patchData(`/inbox/${encodeURIComponent(id)}`, { action });

export const markAllInboxItemsRead = () => postData("/inbox/read-all");
