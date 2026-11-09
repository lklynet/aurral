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
}

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
                seed: { name: playlist.name, artworkUrl, trackCount: playlist.trackCount },
              }}
              name={playlist.name}
              artworkUrl={artworkUrl}
              meta={formatTrackTotal(playlist.trackCount)}
              claim={claimOf(playlist)}
            />
          );
        })}
      </div>
    </DiscoverRail>
  );
}
