import { useEffect, useState } from "react";
import { X } from "./icons";
import TooltipButton from "./TooltipButton";
import { ModalBackdrop } from "./ModalBackdrop";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { originalImage } from "../../../lib/imageSizes.ts";

function LightboxImage({ src, alt }: { src: string; alt: string }) {
  const original = originalImage(src);
  const [current, setCurrent] = useState(src);

  useEffect(() => {
    if (original === src) return;
    let cancelled = false;
    const preload = new Image();
    preload.onload = () => {
      if (!cancelled) setCurrent(original);
    };
    preload.src = original;
    return () => {
      cancelled = true;
      preload.onload = null;
    };
  }, [src, original]);

  return <img className="artwork-lightbox__image" src={current} alt={alt} />;
}

export default function ArtworkLightbox({
  open,
  src,
  alt,
  onClose,
}: {
  open: boolean;
  src: string | null | undefined;
  alt: string;
  onClose: () => void;
}) {
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: open && Boolean(src),
    onClose,
  });

  if (!open || !src) return null;

  return (
    <ModalBackdrop className="artist-modal-backdrop artwork-lightbox" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artwork-lightbox__panel"
        role="dialog"
        aria-modal="true"
        aria-label={alt || "Artwork"}
        tabIndex={-1}
      >
        <LightboxImage key={src} src={src} alt={alt} />
        <TooltipButton
          className="btn btn-ghost btn-icon-square artwork-lightbox__close"
          label="Close artwork"
          onClick={onClose}
        >
          <X className="artist-icon-md" aria-hidden="true" />
        </TooltipButton>
      </div>
    </ModalBackdrop>
  );
}
