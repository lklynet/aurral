import { useState, type ComponentProps, type ReactNode } from "react";
import ArtworkImage from "../../../components/ArtworkImage";

type ReleaseCoverImageProps = Omit<ComponentProps<typeof ArtworkImage>, "src" | "onError"> & {
  src: string;
  fallback: string | null | undefined;
  placeholder: ReactNode;
};

export function ReleaseCoverImage({
  src,
  fallback,
  placeholder,
  ...props
}: ReleaseCoverImageProps) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const current = [src, fallback].find(
    (candidate): candidate is string => Boolean(candidate) && !failed.has(candidate ?? ""),
  );
  if (!current) return placeholder;
  return (
    <ArtworkImage
      key={current}
      {...props}
      src={current}
      onError={() => setFailed((previous) => new Set(previous).add(current))}
    />
  );
}
