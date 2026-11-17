import { DiscoverRail } from "../components/DiscoverRail";
import PlaylistCard from "../components/PlaylistCard";
import { browsePlaylistPath } from "../navigation/playlistPaths.ts";
import { resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { formatTrackTotal } from "./playlists/playlistPageUtils";
import type { BrowseProvider } from "../../../lib/browsePlaylists.ts";
import { usePlaylistClaims } from "./usePlaylistShelf";

export interface BrowseShelfPlaylist {
  provider: BrowseProvider;
  id: string;
  name: string;
  artworkUrl: string | null;
  trackCount: number;
  curator: string | null;
}

export const browsePlaylistMeta = (playlist: BrowseShelfPlaylist) =>
  playlist.provider === "community" && playlist.curator
    ? `${playlist.curator} · ${formatTrackTotal(playlist.trackCount)}`
    : formatTrackTotal(playlist.trackCount);

export function DiscoverPlaylistSection({
  title,
  playlists = [],
  viewAllTo,
}: {
  title: string;
  playlists?: BrowseShelfPlaylist[];
  viewAllTo?: string;
}) {
  const claimOf = usePlaylistClaims();
  if (playlists.length === 0) return null;
  return (
    <DiscoverRail title={title} viewAllTo={viewAllTo}>
      <div className="discover-playlist-cards">
        {playlists.map((playlist) => {
          const artworkUrl = resolveAuthenticatedApiAssetUrl(playlist.artworkUrl) || null;
          return (
            <PlaylistCard
              key={`${playlist.provider}:${playlist.id}`}
              to={browsePlaylistPath(playlist.provider, playlist.id)}
              state={{
                seed: {
                  name: playlist.name,
                  artworkUrl: playlist.artworkUrl,
                  trackCount: playlist.trackCount,
                },
              }}
              name={playlist.name}
              artworkUrl={artworkUrl}
              meta={browsePlaylistMeta(playlist)}
              claim={claimOf(playlist)}
            />
          );
        })}
      </div>
    </DiscoverRail>
  );
}
