import type { ReactNode } from "react";
import { Link } from "react-router";
import { useAudioQueue } from "../contexts/audioQueueContext";

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
  const origin = useAudioQueue().activeSource?.href;
  if (origin) {
    return (
      <Link
        to={origin}
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
