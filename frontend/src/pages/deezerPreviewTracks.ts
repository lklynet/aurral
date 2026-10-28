type DeezerPreviewTrack = {
  artistName: string;
  trackName: string;
  albumName: string | null;
  durationMs: number | null;
  preview_url: string | null;
  artworkUrl: string | null;
  deezerAlbumId: string | null;
};

export const mapPreviewTracks = (tracks: DeezerPreviewTrack[] | undefined, sourceId: string) =>
  (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
    id: `deezer-${sourceId}-${index}`,
    artistName: track?.artistName || "Unknown Artist",
    trackName: track?.trackName || "Unknown Track",
    albumName: track?.albumName || null,
    durationMs: track?.durationMs || null,
    reason: "Deezer playlist",
    status: track?.preview_url ? ("done" as const) : ("pending" as const),
    streamUrl: track?.preview_url || null,
    artworkUrl: track?.artworkUrl || null,
    deezerAlbumId: track?.deezerAlbumId || null,
    resolvesLinks: true,
  }));

export type PreviewTrack = ReturnType<typeof mapPreviewTracks>[number];
