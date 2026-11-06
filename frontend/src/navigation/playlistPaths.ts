import type { BrowseProvider } from "../../../lib/browsePlaylists.ts";

export const playlistPath = (id: string | number) => `/library/playlists/${encodeURIComponent(id)}`;
export const flowPath = (id: string | number) => `/flows/${encodeURIComponent(id)}`;
export const browsePlaylistPath = (provider: BrowseProvider, playlistId: string) =>
  `/discover/playlists/${provider}/${encodeURIComponent(playlistId)}`;
