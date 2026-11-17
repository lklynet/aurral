import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { withTrackParam } from "../utils/audioQueue";

type PlayerOriginLinkProps = {
  className?: string;
  cover?: boolean;
  onClick?: () => void;
  children: ReactNode;
};

export default function PlayerOriginLink({
  className,
  cover = false,
  onClick,
  children,
}: PlayerOriginLinkProps) {
  const { activeSource, currentTrack } = useAudioQueue();
  const origin = activeSource?.href;
  if (origin) {
    return (
      <Link
        to={currentTrack?.id != null ? withTrackParam(origin, currentTrack.id) : origin}
        className={className}
        onClick={onClick}
        {...(cover && { tabIndex: -1, "aria-hidden": true })}
      >
        {children}
      </Link>
    );
  }
  return cover ? (
    <span className={className} aria-hidden="true">
      {children}
    </span>
  ) : (
    children
  );
}
