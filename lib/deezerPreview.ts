export const deezerPreviewSearchPath = (artist: string, track: string) =>
  `/api/deezer/preview?${new URLSearchParams({ artist, track })}`;
