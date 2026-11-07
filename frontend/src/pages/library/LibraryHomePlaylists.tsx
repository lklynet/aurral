import { useQuery } from "@tanstack/react-query";
import { DiscoverRail } from "../../components/DiscoverRail";
import PlaylistCard from "../../components/PlaylistCard";
import { useAuth } from "../../contexts/AuthContext";
import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { playlistPath } from "../../navigation/playlistPaths";
import { playlistStatusQueryOptions } from "../../queryOptions.ts";
import { formatTrackTotal } from "../playlists/playlistPageUtils";
import { getStaticPlaylistTrackCount } from "../playlists/playlistStats";

export function LibraryHomePlaylists() {
  const { hasPermission } = useAuth();
  const canSeePlaylists = hasPermission("accessPlaylists");
  const { data: status } = useQuery({ ...playlistStatusQueryOptions(), enabled: canSeePlaylists });
  const { artworkUrlFor } = usePlaylistArtwork();
  const playlists = canSeePlaylists ? (status?.staticPlaylists ?? []) : [];
  if (!playlists.length) return null;
  return (
    <DiscoverRail title="Playlists" viewAllTo="/library/playlists">
      <div className="discover-playlist-cards">
        {playlists.map((playlist) => (
          <PlaylistCard
            key={playlist.id}
            to={playlistPath(playlist.id)}
            name={playlist.name}
            artworkUrl={artworkUrlFor(playlist.id)}
            meta={formatTrackTotal(
              getStaticPlaylistTrackCount(playlist, status?.staticPlaylistStats?.[playlist.id]),
            )}
          />
        ))}
      </div>
    </DiscoverRail>
  );
}
