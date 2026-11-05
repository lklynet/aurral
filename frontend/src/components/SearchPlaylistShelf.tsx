import { DiscoverRail } from "./DiscoverRail";
import PlaylistCard from "./PlaylistCard";
import { usePlaylistArtwork } from "../hooks/usePlaylistArtwork.ts";
import { getPlaylistResultDetail, getSearchResultLink } from "../utils/searchNavigation";
import type { SearchItem } from "./SearchMixedResultList";

export default function SearchPlaylistShelf({
  playlists,
  showAllTo,
}: {
  playlists: SearchItem[];
  showAllTo: string;
}) {
  const { artworkUrlFor } = usePlaylistArtwork();
  if (!playlists.length) return null;
  return (
    <DiscoverRail title="Playlists" viewAllTo={showAllTo}>
      <div className="discover-playlist-cards">
        {playlists.map((playlist) => {
          const link = getSearchResultLink(playlist);
          if (!link) return null;
          return (
            <PlaylistCard
              key={playlist.key ?? playlist.id}
              to={link.to}
              state={link.state}
              name={playlist.name || ""}
              artworkUrl={playlist.coverUrl || artworkUrlFor(String(playlist.id))}
              meta={getPlaylistResultDetail(playlist) || (playlist.sourceFlowId ? "Flow" : null)}
            />
          );
        })}
      </div>
    </DiscoverRail>
  );
}
