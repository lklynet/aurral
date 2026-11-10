import type { SyntheticEvent } from "react";
import { useLocation } from "react-router";
import RouteLink from "./RouteLink";
import { usePlaylistArtwork } from "../hooks/usePlaylistArtwork.ts";
import { flowPath, playlistPath } from "../navigation/playlistPaths.ts";
import { PlaylistArtworkThumb } from "./PlaylistArtworkThumb.tsx";
import type { PlaylistStatus } from "../utils/playlistStats.ts";

type SidebarPlaylistsProps = {
  status: PlaylistStatus;
  iconsOnly: boolean;
  onTooltip?: (event: SyntheticEvent<HTMLElement>) => void;
};

function SidebarPlaylists({ status, iconsOnly, onTooltip }: SidebarPlaylistsProps) {
  const { pathname } = useLocation();
  const { artworkUrlFor } = usePlaylistArtwork();
  const entries = [
    ...status.staticPlaylists.map(({ id, name }) => ({
      id,
      name,
      kind: "Playlist",
      path: playlistPath(id),
    })),
    ...status.flows.map(({ id, name }) => ({ id, name, kind: "Flow", path: flowPath(id) })),
  ];

  if (entries.length === 0) return null;

  return (
    <nav className="sidebar-playlists" aria-label="Your playlists">
      {iconsOnly ? null : (
        <RouteLink to="/library/playlists" className="sidebar-playlists__head">
          Playlists
        </RouteLink>
      )}
      <div className="sidebar-playlists__list">
        {entries.map((entry) => {
          const active = pathname === entry.path;
          return (
            <RouteLink
              key={entry.path}
              to={entry.path}
              className={`sidebar-link sidebar-link--${iconsOnly ? "icons" : "full"} sidebar-playlist${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={iconsOnly ? entry.name : undefined}
              onMouseEnter={onTooltip}
              onFocus={onTooltip}
            >
              <PlaylistArtworkThumb
                sizes="2rem"
                artworkUrl={artworkUrlFor(entry.id)}
                name={entry.name}
                className="sidebar-playlist__art"
              />
              {iconsOnly ? (
                <span className="sidebar-tooltip">{entry.name}</span>
              ) : (
                <span className="sidebar-player__copy">
                  <span className="sidebar-player__title">{entry.name}</span>
                  <span className="sidebar-player__subtitle">{entry.kind}</span>
                </span>
              )}
            </RouteLink>
          );
        })}
      </div>
    </nav>
  );
}

export default SidebarPlaylists;
