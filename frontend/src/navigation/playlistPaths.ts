export const playlistPath = (id: string | number) => `/library/playlists/${encodeURIComponent(id)}`;
export const flowPath = (id: string | number) => `/flows/${encodeURIComponent(id)}`;
export const editorialPlaylistPath = (playlistId: string) =>
  `/discover/playlists/deezer/${encodeURIComponent(playlistId)}`;
