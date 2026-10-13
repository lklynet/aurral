import { useState } from "react";

function ThumbnailImage({ src, sizes, loading, onError, ...props }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const preview = src.replace(/\/fanart\//i, "/preview/");
  const bigPreview = src.replace(/\/fanart\//i, "/bigpreview/");
  const originalCandidate = /^https?:\/\/assets\.fanart\.tv\/fanart\/music\/[^/?#]+\/(?:albumcover|artistthumb)\//i.test(src)
    ? `, ${src} 1000w`
    : "";

  return (
    <img
      {...props}
      src={previewFailed ? src : preview}
      srcSet={previewFailed ? undefined : `${preview} 200w, ${bigPreview} 400w${originalCandidate}`}
      sizes={previewFailed ? undefined : loading === "lazy" ? `auto, ${sizes}` : sizes}
      loading={loading}
      onError={(event) => {
        if (!previewFailed && event.currentTarget.currentSrc !== src) {
          setPreviewFailed(true);
          return;
        }
        onError?.(event);
      }}
    />
  );
}

export default function ArtworkImage({
  src,
  thumbnail = true,
  sizes = "200px",
  loading = "lazy",
  decoding = "async",
  ...props
}) {
  if (thumbnail && /^https?:\/\/assets\.fanart\.tv\/fanart\//i.test(src)) {
    return (
      <ThumbnailImage
        key={src}
        {...props}
        src={src}
        sizes={sizes}
        loading={loading}
        decoding={decoding}
      />
    );
  }

  return <img {...props} src={src} loading={loading} decoding={decoding} />;
}
