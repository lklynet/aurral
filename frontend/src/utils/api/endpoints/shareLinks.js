import { deleteData, getData, postData } from "../core.js";

export const getShareLinks = ({ signal } = {}) => getData("/share-links", { signal });

export const getShareAvailability = (params, { signal } = {}) =>
  getData("/share-links/availability", { params, signal });

export const createShareLink = (data) => postData("/share-links", data);

export const deleteShareLink = (id) => deleteData(`/share-links/${encodeURIComponent(id)}`);
