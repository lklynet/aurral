import { buildAuthenticatedApiUrl, resolveAuthenticatedApiAssetUrl } from "./core.ts";

type PlaylistArtworkField = { artworkUrl?: string | null; customArtworkUrl?: string | null };

export const getPlaylistTrackStreamUrl = (jobId: string | number) =>
  buildAuthenticatedApiUrl(`/playlists/stream/${encodeURIComponent(jobId)}`);

export const getStagingStreamUrl = (jobId: string) =>
  buildAuthenticatedApiUrl(`/playlists/staging-stream/${encodeURIComponent(jobId)}`);

export const getPlaylistArtworkUrl = (playlistId: string, version: string | number = "current") =>
  buildAuthenticatedApiUrl(`/playlists/artwork/${encodeURIComponent(playlistId)}`, { v: version });

export const getPlaylistTrackArtworkUrl = (
  playlistId: string,
  jobId: string,
  version: string | number = "current",
) =>
  buildAuthenticatedApiUrl(`/playlists/track-artwork/${encodeURIComponent(jobId)}`, {
    playlistId,
    v: version,
  });

export const withAuthenticatedTrackArtwork = <T extends PlaylistArtworkField>({
  artworkUrl,
  customArtworkUrl,
  ...job
}: T) => ({
  ...job,
  artworkUrl: artworkUrl ? resolveAuthenticatedApiAssetUrl(artworkUrl) : null,
  customArtworkUrl: customArtworkUrl ? resolveAuthenticatedApiAssetUrl(customArtworkUrl) : null,
});
