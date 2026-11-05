import { DiscoverRail } from "../components/DiscoverRail";
import PlaylistCard from "../components/PlaylistCard";
import { editorialPlaylistPath } from "../navigation/playlistPaths.ts";

export interface EditorialShelfPlaylist {
  id: string;
  name: string;
  artworkUrl: string | null;
  trackCount: number;
}

export function DiscoverPlaylistSection({
  title,
  playlists = [],
  showViewAll = false,
}: {
  title: string;
  playlists?: EditorialShelfPlaylist[];
  showViewAll?: boolean;
}) {
  if (playlists.length === 0) return null;
  return (
    <DiscoverRail title={title} viewAllTo={showViewAll ? "/discover/playlists" : undefined}>
      <div className="discover-playlist-cards">
        {playlists.map((playlist) => (
          <PlaylistCard
            key={playlist.id}
            to={editorialPlaylistPath(playlist.id)}
            state={{
              seed: {
                name: playlist.name,
                artworkUrl: playlist.artworkUrl || null,
                trackCount: playlist.trackCount,
              },
            }}
            name={playlist.name}
            artworkUrl={playlist.artworkUrl}
            meta={`${playlist.trackCount} tracks`}
          />
        ))}
      </div>
    </DiscoverRail>
  );
}
