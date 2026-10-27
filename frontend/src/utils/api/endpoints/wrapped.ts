import { getData, postData } from "../core.ts";
import type {
  WrappedResponse,
  WrappedPlaylistResponse,
  WrappedAnnouncementResponse,
} from "../../../../../backend/routes/wrapped.ts";

export const getWrapped = (year: number, timeZone: string, signal?: AbortSignal) =>
  getData<WrappedResponse>(`/wrapped/${year}`, { params: { timeZone }, signal });
export const buildWrapped = (year: number, timeZone: string, refresh = false) =>
  postData<WrappedResponse>(`/wrapped/${year}`, { timeZone, refresh });
export const saveWrappedPlaylist = (year: number, timeZone: string) =>
  postData<WrappedPlaylistResponse>(`/wrapped/${year}/playlist`, { timeZone });

export const getWrappedAnnouncement = (timeZone: string, signal?: AbortSignal) =>
  getData<WrappedAnnouncementResponse>("/wrapped/announcement", { params: { timeZone }, signal });

export const hideWrappedAnnouncement = (year: number, timeZone: string, hidden: boolean) =>
  postData<WrappedAnnouncementResponse>("/wrapped/announcement", { year, timeZone, hidden });

export const setLanternPreview = (timeZone: string, enabled: boolean) =>
  postData<WrappedResponse>("/wrapped/preview", { timeZone, enabled });
