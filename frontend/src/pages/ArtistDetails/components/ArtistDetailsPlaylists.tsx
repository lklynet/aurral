import { useCallback, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ListMusic } from "../../../components/icons";
import { ReleaseCoverImage } from "../../../components/ReleaseCoverImage";
import { ClaimBadge } from "../../../components/PlaylistCard";
import RouteLink from "../../../components/RouteLink";
import Tooltip from "../../../components/Tooltip";
import TooltipButton from "../../../components/TooltipButton";
import { browsePlaylistPath } from "../../../navigation/playlistPaths.ts";
import { artistPlaylistsQueryOptions } from "../../../utils/api/endpoints/artists.ts";
import { usePlaylistClaims } from "../../usePlaylistShelf";
import { useShelfScroll } from "../hooks/useShelfScroll.ts";
import { useArtistReleaseShelf } from "../hooks/useResponsiveReleaseLimit.ts";

export function ArtistDetailsPlaylists({ mbid, artistName }: { mbid: string; artistName: string }) {
  const headingId = useId();
  const { data } = useQuery(artistPlaylistsQueryOptions(mbid, artistName));
  const playlists = data?.playlists ?? [];
  const claimOf = usePlaylistClaims();
  const shelf = useShelfScroll(playlists.length);
  const [gridRef, columns] = useArtistReleaseShelf();
  const { ref: shelfRef } = shelf;
  const railRef = useCallback(
    (node: HTMLDivElement | null) => {
      gridRef(node);
      shelfRef(node);
    },
    [gridRef, shelfRef],
  );

  if (playlists.length === 0) return null;

  return (
    <section className="artist-section" aria-labelledby={headingId}>
      <div className="artist-section-head">
        <h2 className="artist-section-title" id={headingId}>
          Featuring {artistName}
        </h2>
        {shelf.canScrollLeft || shelf.canScrollRight ? (
          <div className="artist-shelf-nav">
            <TooltipButton
              type="button"
              onClick={() => shelf.scrollBy(-1)}
              className="btn btn-ghost btn-icon-square"
              label="Scroll playlists left"
              disabled={!shelf.canScrollLeft}
            >
              <ChevronLeft aria-hidden="true" />
            </TooltipButton>
            <TooltipButton
              type="button"
              onClick={() => shelf.scrollBy(1)}
              className="btn btn-ghost btn-icon-square"
              label="Scroll playlists right"
              disabled={!shelf.canScrollRight}
            >
              <ChevronRight aria-hidden="true" />
            </TooltipButton>
          </div>
        ) : null}
      </div>
      <div
        ref={railRef}
        className="artist-playlist-rail"
        style={{ "--artist-shelf-count": columns }}
      >
        {playlists.map((playlist) => {
          const claim = claimOf(playlist);
          return (
            <article key={playlist.id} className="artist-release-tile" data-artwork-scope>
              <div className="artist-release-tile__cover" data-artwork>
                <ReleaseCoverImage
                  src={playlist.artworkUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  placeholder={
                    <span className="artist-release-tile__placeholder" aria-hidden="true">
                      <ListMusic />
                    </span>
                  }
                />
                {claim ? <ClaimBadge claim={claim} /> : null}
              </div>
              <h3 className="artist-release-tile__title">
                <RouteLink
                  to={browsePlaylistPath(playlist.provider, playlist.id)}
                  state={{ seed: { name: playlist.name, artworkUrl: playlist.artworkUrl } }}
                  className="card-link"
                >
                  <Tooltip content={playlist.name}>
                    <span className="card-link__label">{playlist.name}</span>
                  </Tooltip>
                </RouteLink>
              </h3>
              {playlist.curator ? (
                <p className="artist-release-tile__meta">{curatorLabel(playlist.curator)}</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

const curatorLabel = (curator: string) => (/deezer/i.test(curator) ? "Deezer" : curator);
