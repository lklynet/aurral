import { useState, type MouseEvent } from "react";
import { UUID_REGEX } from "../../../lib/uuid.ts";
import { apiPathOf, buildAuthenticatedApiUrl } from "../utils/api/core.ts";
import { normalizeMediaUrl } from "../utils/normalizeMediaUrl";
import { useArtistPreviewPlayback } from "../hooks/useArtistPreviewPlayback";

import { Music, Play } from "./icons";
import { DotLoader } from "./DotLoader";
import Tooltip from "./Tooltip";
import ArtworkImage from "./ArtworkImage";

type ArtistImageProps = {
  mbid?: string | number | null;
  src?: string | null;
  alt?: string | null;
  artistName?: string | null;
  className?: string;
  enablePreviewPlayback?: boolean;
  isInLibrary?: boolean;
  loading?: "eager" | "lazy";
  thumbnail?: boolean;
  sizes?: string;
};

type Candidate = { src: string; srcSet?: string };

export function imageCandidates({
  mbid,
  src,
  isInLibrary,
  thumbnail,
}: Pick<ArtistImageProps, "mbid" | "src" | "isInLibrary" | "thumbnail">): Candidate[] {
  const given = normalizeMediaUrl(src);
  const fromSrc = given ? [{ src: given }] : [];
  const id = String(mbid ?? "");
  if (!UUID_REGEX.test(id)) return fromSrc;

  const artistUrl = (w?: number) => buildAuthenticatedApiUrl(`/artists/${id}/image`, { w });
  const fromArtist = [
    ...(thumbnail
      ? [{ src: artistUrl(400), srcSet: `${artistUrl(200)} 200w, ${artistUrl(400)} 400w` }]
      : []),
    { src: artistUrl() },
  ];
  const preferArtist = isInLibrary && !(given && apiPathOf(given) !== null);
  return preferArtist ? [...fromArtist, ...fromSrc] : [...fromSrc, ...fromArtist];
}

const ArtistImage = ({
  mbid,
  src,
  alt,
  artistName,
  className = "",
  enablePreviewPlayback = false,
  isInLibrary = false,
  loading = "lazy",
  thumbnail = true,
  sizes = "200px",
}: ArtistImageProps) => {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const { canPlayArtistPreview, isArtistPreviewActive, isLoadingPreview, playArtistPreview } =
    useArtistPreviewPlayback({
      mbid,
      artistName,
      enabled: enablePreviewPlayback,
      isInLibrary,
    });

  const current = imageCandidates({ mbid, src, isInLibrary, thumbnail }).find(
    (candidate) => !failed.has(candidate.src),
  );

  const handlePreviewClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    await playArtistPreview();
  };

  const playLabel = `Play ${artistName || "artist"}${isInLibrary ? "" : " top tracks"}`;
  const previewButton = canPlayArtistPreview ? (
    <Tooltip content={playLabel}>
      <button
        type="button"
        tabIndex={isLoadingPreview ? -1 : undefined}
        className={`artist-image-preview-button${isArtistPreviewActive ? " is-active" : ""}${isLoadingPreview ? " is-loading" : ""}`}
        onClick={handlePreviewClick}
        aria-disabled={isLoadingPreview}
        aria-label={playLabel}
      >
        {isLoadingPreview ? (
          <DotLoader size="md" label={null} className="artist-image-preview-button__icon" />
        ) : (
          <Play className="artist-image-preview-button__icon" />
        )}
      </button>
    </Tooltip>
  ) : null;

  if (!current) {
    return (
      <div className={`artist-image-placeholder ${className}`}>
        <Music className="artist-image-icon" />
        {previewButton}
      </div>
    );
  }

  return (
    <div className={`artist-image-root ${className}`}>
      <ArtworkImage
        key={current.src}
        src={current.src}
        srcSet={current.srcSet}
        thumbnail={thumbnail}
        sizes={sizes}
        alt={alt || "Artist cover"}
        className="artist-image-media"
        onError={() => setFailed((previous) => new Set(previous).add(current.src))}
        loading={loading}
        decoding="async"
      />
      {previewButton}
    </div>
  );
};

export default ArtistImage;
