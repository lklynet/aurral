import { useState } from "react";
import { ListMusic } from "lucide-react";
import { DiscoverRail } from "../components/DiscoverRail";
import RouteLink from "../components/RouteLink";
import Tooltip from "../components/Tooltip";

export const editorialPlaylistPath = (playlistId) =>
  `/discover/playlists/deezer/${encodeURIComponent(playlistId)}`;

function EditorialPlaylistCard({ playlist }) {
  const [failedArtwork, setFailedArtwork] = useState(false);
  return (
    <div className="artist-discover-shelf-card">
      <div className="artist-discover-card artist-discover-card--playlist">
        <div className="artist-discover-card__cover">
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
        </div>
        <div className="artist-discover-card__content">
          <RouteLink
            to={editorialPlaylistPath(playlist.id)}
            className="artist-discover-card__text card-link"
            aria-label={`Open ${playlist.name}`}
          >
            <div className="artist-card-title-row--discover">
              <Tooltip content={playlist.name}>
                <span className="artist-card-title--discover">{playlist.name}</span>
              </Tooltip>
            </div>
            <p className="artist-card-meta--discover">{playlist.trackCount} tracks</p>
          </RouteLink>
        </div>
      </div>
    </div>
  );
}

export function DiscoverPlaylistSection({ title, playlists = [], showViewAll = false }) {
  if (playlists.length === 0) return null;
  return (
    <DiscoverRail title={title} viewAllTo={showViewAll ? "/discover/playlists" : undefined}>
      <div className="discover-playlist-cards">
        {playlists.map((playlist) => (
          <EditorialPlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </div>
    </DiscoverRail>
  );
}
