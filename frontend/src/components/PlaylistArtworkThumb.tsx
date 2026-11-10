import { useState, useEffect } from "react";
import ArtworkImage from "./ArtworkImage";

export function PlaylistArtworkThumb({
  artworkUrl,
  name,
  sizes,
  className = "",
  onClick,
}: {
  artworkUrl?: string | null;
  name?: string;
  sizes: string;
  className?: string;
  onClick?: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [artworkUrl]);

  const fallbackLabel =
    String(name || "?")
      .trim()
      .charAt(0)
      .toUpperCase() || "?";
  const classes = `flow-page__artwork${onClick ? " flow-page__artwork--interactive" : ""}${className ? ` ${className}` : ""}`;
  const content =
    !imageFailed && artworkUrl ? (
      <ArtworkImage
        src={artworkUrl}
        alt={`${name} cover`}
        sizes={sizes}
        onError={() => setImageFailed(true)}
      />
    ) : (
      <div className="flow-page__artwork-fallback">{fallbackLabel}</div>
    );

  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} aria-label={`Edit ${name} cover`}>
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}
