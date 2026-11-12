import type { MouseEventHandler, ReactNode } from "react";
import { createPortal } from "react-dom";

export function ModalBackdrop({
  className = "artist-modal-backdrop",
  onClick,
  children,
}: {
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return createPortal(
    <div className={className} onClick={onClick}>
      {children}
    </div>,
    document.body,
  );
}
