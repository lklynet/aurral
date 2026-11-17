import { Fragment, type ReactNode } from "react";
import { formatTrackTotal } from "../playlistPageUtils.ts";

export function PlaylistTrackCount({ available, total }: { available: number; total: number }) {
  if (available >= total) return formatTrackTotal(total);
  return (
    <span className="native-library-card__status" data-tone="warning">
      {available}/{formatTrackTotal(total)}
      <span className="sr-only"> available</span>
    </span>
  );
}

export function joinMeta(parts: ReactNode[]) {
  const present = parts.filter(Boolean);
  if (present.length === 0) return null;
  return present.map((part, index) => (
    <Fragment key={index}>
      {index ? " · " : null}
      {part}
    </Fragment>
  ));
}
