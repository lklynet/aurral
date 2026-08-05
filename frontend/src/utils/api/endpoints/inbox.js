import { getData, patchData, postData } from "../core.js";

export const getInbox = ({ zip = "", limit = 50 } = {}) =>
  getData("/inbox", { params: { zip, limit } });

export const updateInboxItem = (id, action) =>
  patchData(`/inbox/${encodeURIComponent(id)}`, { action });

export const markAllInboxItemsRead = () => postData("/inbox/read-all");
