import ArtworkImage from "../components/ArtworkImage";
import { useState } from "react";
import { ListMusic } from "../components/icons";
import { DiscoverRail } from "../components/DiscoverRail";
import RouteLink from "../components/RouteLink";
import Tooltip from "../components/Tooltip";

export interface EditorialShelfPlaylist {
  id: string;
  name: string;
  artworkUrl: string | null;
  trackCount: number;
}

export const editorialPlaylistPath = (playlistId: string) =>
  `/discover/playlists/deezer/${encodeURIComponent(playlistId)}`;

function EditorialPlaylistCard({ playlist }: { playlist: EditorialShelfPlaylist }) {
  const [failedArtwork, setFailedArtwork] = useState(false);
  return (
    <div className="artist-discover-shelf-card">
      <div className="artist-discover-card artist-discover-card--playlist" data-artwork-scope>
        <div className="artist-discover-card__cover" data-artwork>
          {playlist.artworkUrl && !failedArtwork ? (
            <ArtworkImage
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
            state={{
              seed: {
                name: playlist.name,
                artworkUrl: playlist.artworkUrl || null,
                trackCount: playlist.trackCount,
              },
            }}
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
          <EditorialPlaylistCard key={playlist.id} playlist={playlist} />
        ))}
      </div>
    </DiscoverRail>
  );
}
