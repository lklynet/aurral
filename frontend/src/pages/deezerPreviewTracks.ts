import { buildAuthenticatedApiUrl, resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";

type OwnedTrack = {
  streamPath: string;
  streamFormat: string | null;
  libraryTrackId: number;
  libraryAlbumId: number;
  artworkUrl: string | null;
  artistMbid: string | null;
  albumMbid: string | null;
  trackMbid: string | null;
};

type DeezerPreviewTrack = {
  artistName: string;
  trackName: string;
  albumName: string | null;
  durationMs: number | null;
  preview_url: string | null;
  artworkUrl: string | null;
  deezerAlbumId: string | null;
  owned?: OwnedTrack | null;
};

export const mapPreviewTracks = (tracks: DeezerPreviewTrack[] | undefined, sourceId: string) => {
  const ownedIds = new Set<number>();
  return (Array.isArray(tracks) ? tracks : []).map((track, index) => {
    const owned = track.owned ?? null;
    const libraryId = owned && !ownedIds.has(owned.libraryTrackId) ? owned.libraryTrackId : null;
    if (libraryId !== null) ownedIds.add(libraryId);
    return {
      id: libraryId === null ? `deezer-${sourceId}-${index}` : String(libraryId),
      artistName: track.artistName || "Unknown Artist",
      trackName: track.trackName || "Unknown Track",
      albumName: track.albumName || null,
      durationMs: track.durationMs || null,
      reason: owned ? "In your Library" : "Preview",
      status: "done" as const,
      isPreview: !owned,
      libraryOwned: Boolean(owned),
      streamUrl: owned ? buildAuthenticatedApiUrl(owned.streamPath) : track.preview_url || null,
      streamFormat: owned?.streamFormat ?? null,
      artworkUrl: resolveAuthenticatedApiAssetUrl(owned?.artworkUrl || track.artworkUrl) || null,
      deezerAlbumId: track.deezerAlbumId || null,
      libraryTrackId: owned?.libraryTrackId ?? null,
      libraryAlbumId: owned?.libraryAlbumId ?? null,
      artistMbid: owned?.artistMbid ?? null,
      albumMbid: owned?.albumMbid ?? null,
      trackMbid: owned?.trackMbid ?? null,
      resolvesLinks: true,
    };
  });
};

export type PreviewTrack = ReturnType<typeof mapPreviewTracks>[number];
