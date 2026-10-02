import { useState } from "react";
import { ListMusic } from "lucide-react";
import { DiscoverRail } from "../components/DiscoverRail";
import Tooltip from "../components/Tooltip";
import { useDiscoverNavigation } from "../hooks/useDiscoverNavigation";

export const editorialPlaylistPath = (playlistId) =>
  `/discover/playlists/deezer/${encodeURIComponent(playlistId)}`;

function EditorialPlaylistCard({ playlist, onOpen }) {
  const [failedArtwork, setFailedArtwork] = useState(false);
  return (
    <div className="artist-discover-shelf-card">
      <div className="artist-discover-card artist-discover-card--playlist">
        <button
          type="button"
          className="artist-discover-card__cover"
          aria-label={`Open ${playlist.name}`}
          onClick={onOpen}
        >
          {playlist.artworkUrl && !failedArtwork ? (
            <img
              src={playlist.artworkUrl}
              alt=""
              className="artist-discover-card__image"
              loading="lazy"
              onError={() => setFailedArtwork(true)}
            />
          ) : (
            <div className="artist-media-placeholder--discover">
              <ListMusic className="artist-icon-lg" aria-hidden="true" />
            </div>
          )}
        </button>
        <div className="artist-discover-card__content">
          <div className="artist-discover-card__text">
            <div className="artist-card-title-row--discover">
              <Tooltip content={playlist.name}>
                <button type="button" className="artist-card-title--discover" onClick={onOpen}>
                  {playlist.name}
                </button>
              </Tooltip>
            </div>
            <p className="artist-card-meta--discover">{playlist.trackCount} tracks</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DiscoverPlaylistSection({ title, playlists = [], showViewAll = false }) {
  const navigate = useDiscoverNavigation();
  if (playlists.length === 0) return null;
  return (
    <DiscoverRail
      title={title}
      onViewAll={showViewAll ? () => navigate("/discover/playlists") : undefined}
    >
      <div className="discover-playlist-cards">
        {playlists.map((playlist) => (
          <EditorialPlaylistCard
            key={playlist.id}
            playlist={playlist}
            onOpen={() => navigate(editorialPlaylistPath(playlist.id))}
          />
        ))}
      </div>
    </DiscoverRail>
  );
}
