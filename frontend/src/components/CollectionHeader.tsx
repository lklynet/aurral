import { Pause, Play, Shuffle } from "./icons";
import type { ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useArtworkWash } from "../utils/imageColors";
import TooltipButton from "./TooltipButton";
import { useSharedArtworkStyle } from "../navigation/viewTransitions.ts";
import { getArtistCover } from "../utils/api/endpoints/artists.ts";
import { queryKeys } from "../queryClient.ts";

export function useCollectionTint(src: string | null | undefined) {
  const wash = useArtworkWash(src || null);
  return wash ? `light-dark(${wash.light}, ${wash.dark})` : null;
}

export function useArtistTint(
  image: string | null | undefined,
  mbid: string | null | undefined,
  name: string | null | undefined,
) {
  const lookupMbid = image ? null : mbid;
  const { data } = useQuery({
    queryKey: queryKeys.artistCover(lookupMbid),
    queryFn: lookupMbid ? () => getArtistCover(lookupMbid, name) : skipToken,
    staleTime: Infinity,
  });
  const covers = data?.images ?? [];
  return useCollectionTint(image || (covers.find((cover) => cover.front) ?? covers[0])?.image);
}

export function CollectionPage({
  tintSrc,
  className = "",
  children,
}: {
  tintSrc?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const tint = useCollectionTint(tintSrc);
  return (
    <div
      className={`library-page native-library-page collection-page${className ? ` ${className}` : ""}`}
      style={tint ? { "--collection-tint": tint } : undefined}
    >
      <div className="native-library-content">
        <div className="native-library-detail">{children}</div>
      </div>
    </div>
  );
}

interface CollectionPlayButtonsProps {
  label: string;
  disabled?: boolean;
  isPlaying: boolean;
  isShuffleEnabled?: boolean;
  onPlay?: () => void;
  onShuffle?: () => void;
}

export function CollectionPlayButtons({
  label,
  disabled,
  isPlaying,
  isShuffleEnabled,
  onPlay,
  onShuffle,
}: CollectionPlayButtonsProps) {
  return (
    <>
      <button
        type="button"
        className="native-library-page-play"
        onClick={onPlay}
        disabled={disabled}
        aria-label={`${isPlaying ? "Pause" : "Play"} ${label}`}
      >
        {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        {isPlaying ? "Pause" : "Play"}
      </button>
      {onShuffle ? (
        <TooltipButton
          className={`native-library-favorite collection-header__shuffle${isShuffleEnabled ? " is-active" : ""}`}
          onClick={onShuffle}
          disabled={disabled}
          label={`Shuffle ${label}`}
          aria-label={`Shuffle ${label}`}
        >
          <Shuffle aria-hidden="true" />
        </TooltipButton>
      ) : null}
    </>
  );
}

interface CollectionHeaderProps {
  cover: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  corner?: ReactNode;
  embedded?: boolean;
}

export function CollectionHeader({
  cover,
  title,
  subtitle,
  meta,
  status,
  actions,
  corner,
  embedded = false,
}: CollectionHeaderProps) {
  const artworkStyle = useSharedArtworkStyle();
  const Title = embedded ? "h2" : "h1";
  const coverProps = embedded ? { "data-artwork": "" } : { style: artworkStyle };
  return (
    <header
      className={`native-library-detail__hero collection-header${embedded ? " collection-header--embedded" : ""}`}
      data-artwork-scope={embedded ? "" : undefined}
    >
      {corner ? <div className="collection-header__corner">{corner}</div> : null}
      <div className="native-library-detail__cover" {...coverProps}>
        {cover}
      </div>
      <div className="native-library-detail__body">
        <Title className="collection-header__title">{title}</Title>
        {typeof subtitle === "string" ? (
          <p className="collection-header__description">{subtitle}</p>
        ) : subtitle ? (
          <div className="collection-header__subtitle">{subtitle}</div>
        ) : null}
        {meta ? <p className="native-library-detail__meta">{meta}</p> : null}
        {status}
        {actions ? <div className="native-library-detail__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
