import { useState } from "react";
import ArtworkImage from "./ArtworkImage";
import { Check, ListMusic, RefreshCw } from "./icons";
import RouteLink from "./RouteLink";
import Tooltip from "./Tooltip";
import { artworkHoverTint } from "../utils/imageColors.ts";

function ClaimBadge({ claim }: { claim: "synced" | "saved" }) {
  const label = claim === "synced" ? "Synced to your playlists" : "In your playlists";
  const Icon = claim === "synced" ? RefreshCw : Check;
  return (
    <Tooltip content={label}>
      <span className="playlist-card__claim" role="img" aria-label={label} tabIndex={0}>
        <Icon strokeWidth={2.5} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

export default function PlaylistCard({
  to,
  state,
  name,
  artworkUrl,
  meta,
  claim,
}: {
  to: string;
  state?: unknown;
  name: string;
  artworkUrl: string | null;
  meta: string | null;
  claim?: "synced" | "saved";
}) {
  const [failedArtwork, setFailedArtwork] = useState(false);
  return (
    <div className="artist-discover-shelf-card">
      <div
        className="artist-discover-card artist-discover-card--playlist"
        data-artwork-scope
        {...artworkHoverTint}
      >
        <div className="artist-discover-card__cover" data-artwork>
          {artworkUrl && !failedArtwork ? (
            <ArtworkImage
              src={artworkUrl}
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
          {claim && <ClaimBadge claim={claim} />}
        </div>
        <div className="artist-discover-card__content">
          <RouteLink
            to={to}
            state={state}
            className="artist-discover-card__text card-link"
            aria-label={`Open ${name}`}
          >
            <div className="artist-card-title-row--discover">
              <Tooltip content={name}>
                <span className="artist-card-title--discover">{name}</span>
              </Tooltip>
            </div>
            {meta && <p className="artist-card-meta--discover">{meta}</p>}
          </RouteLink>
        </div>
      </div>
    </div>
  );
}
