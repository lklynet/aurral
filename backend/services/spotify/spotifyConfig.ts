export const SPOTIFY_OAUTH_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_API_BASE = "https://api.spotify.com/v1";
export const SPOTIFY_CLIENT_ID =
  process.env.SPOTIFY_CLIENT_ID || "848082790c32436d8a0405fddca0aa18";
export const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_OAUTH_REDIRECT_URI || "https://spotify.lidarr.audio/auth";
export const SPOTIFY_RENEW_URI =
  process.env.SPOTIFY_OAUTH_RENEW_URI || "https://spotify.lidarr.audio/renew";
export const SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative";

export function buildSpotifyOAuthUrl(callbackUrl) {
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    state: callbackUrl,
    show_dialog: "true",
  });
  return `${SPOTIFY_OAUTH_URL}?${params.toString()}`;
}
