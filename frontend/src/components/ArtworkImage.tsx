import { useState, type ComponentProps } from "react";
import { imageSizes, originalImage, type ImageSize } from "../../../lib/imageSizes.ts";

type ImageProps = ComponentProps<"img">;

type ArtworkImageProps = ImageProps & {
  src: string;
  thumbnail?: boolean;
  sizes?: string;
  loading?: ImageProps["loading"];
  decoding?: ImageProps["decoding"];
};

type ThumbnailImageProps = ImageProps & {
  src: string;
  variants: readonly ImageSize[];
  sizes: string;
  loading: ImageProps["loading"];
};

function ThumbnailImage({ src, variants, sizes, loading, onError, ...props }: ThumbnailImageProps) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const preview = variants[0]?.url ?? src;
  const original = originalImage(src);

  return (
    <img
      {...props}
      src={previewFailed ? original : preview}
      srcSet={
        previewFailed
          ? undefined
          : variants.map((variant) => `${variant.url} ${variant.width}w`).join(", ")
      }
      sizes={previewFailed ? undefined : loading === "lazy" ? `auto, ${sizes}` : sizes}
      loading={loading}
      onError={(event) => {
        if (!previewFailed && event.currentTarget.currentSrc !== original) {
          setPreviewFailed(true);
          return;
        }
        onError?.(event);
      }}
    />
  );
}

function DirectImage({ src, onError, ...props }: ImageProps & { src: string }) {
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const original = originalImage(src);
  const currentSrc = fallbackUsed ? original : src;

  return (
    <img
      {...props}
      src={currentSrc}
      onError={(event) => {
        if (!fallbackUsed && original !== src) {
          setFallbackUsed(true);
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
}: ArtworkImageProps) {
  const variants = thumbnail ? imageSizes(src) : [];
  if (variants.length) {
    return (
      <ThumbnailImage
        key={src}
        {...props}
        src={src}
        variants={variants}
        sizes={sizes}
        loading={loading}
        decoding={decoding}
      />
    );
  }

  return (
    <DirectImage
      key={src}
      {...props}
      src={src}
      sizes={props.srcSet ? sizes : undefined}
      loading={loading}
      decoding={decoding}
    />
  );
}
