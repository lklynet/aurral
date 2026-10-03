import { useState, useEffect } from "react";

export function PlaylistArtworkThumb({
  artworkUrl,
  name,
  className = "",
  onClick,
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [artworkUrl]);

  const fallbackLabel = String(name || "?").trim().charAt(0).toUpperCase() || "?";
  const classes = `flow-page__artwork${onClick ? " flow-page__artwork--interactive" : ""}${className ? ` ${className}` : ""}`;
  const content =
    !imageFailed && artworkUrl ? (
      <img
        src={artworkUrl}
        alt={`${name} cover`}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    ) : (
      <div className="flow-page__artwork-fallback">{fallbackLabel}</div>
    );

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onClick}
        aria-label={`Edit ${name} cover`}
      >
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}
