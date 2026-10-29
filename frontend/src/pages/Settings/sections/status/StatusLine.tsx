import type { ReactNode } from "react";

export function StatusLine({
  name,
  sub,
  meta,
  metaSub,
}: {
  name: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  metaSub?: ReactNode;
}) {
  return (
    <div className="status-line">
      <span className="status-line__name">{name}</span>
      <div className="status-line__sub">{sub}</div>
      <span className="status-line__meta">{meta}</span>
      <span className="status-line__meta-sub">{metaSub}</span>
    </div>
  );
}
