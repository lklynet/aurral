import { useRef, useState } from "react";
import { albumCoverSources } from "../../../../lib/imageSizes.ts";
import ArtworkImage from "../../components/ArtworkImage.tsx";
import { ModalBackdrop } from "../../components/ModalBackdrop.tsx";
import { X } from "../../components/icons";
import { useModalDialog } from "../../hooks/useModalDialog.ts";
import { Cover } from "../library/libraryShared.tsx";

function CoverLightbox({
  preview,
  original,
  label,
  onClose,
}: {
  preview: string;
  original: string;
  label: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const hasOriginal = original !== preview;
  const panelRef = useRef<HTMLDivElement>(null);
  const { dialogRef } = useModalDialog({ open: true, onClose, initialFocusRef: panelRef });
  return (
    <ModalBackdrop className="artist-modal-backdrop artwork-lightbox" onClick={onClose}>
      <div
        ref={(element) => {
          panelRef.current = element;
          dialogRef.current = element;
        }}
        className="artwork-lightbox__panel"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {(!hasOriginal || !loaded) && (
          <img className="artwork-lightbox__image" src={preview} alt={label} />
        )}
        {hasOriginal && (
          <img
            className="artwork-lightbox__image"
            src={original}
            alt={label}
            hidden={!loaded}
            onLoad={() => setLoaded(true)}
          />
        )}
        <button type="button" className="btn artwork-lightbox__close" aria-label="Close artwork">
          <X strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </ModalBackdrop>
  );
}

export default function AlbumCover({
  src,
  preview,
  label,
  onLoad,
  onError,
}: {
  src: string;
  preview: string;
  label: string;
  onLoad: (preview: string) => void;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <Cover label={label} />;
  const { fullSize, thumbnails } = albumCoverSources(src);

  return (
    <>
      <button
        type="button"
        className="native-library-cover-button"
        aria-label={`View ${label || "album"} artwork larger`}
        aria-haspopup="dialog"
        disabled={!preview}
        onClick={() => setOpen(true)}
      >
        <ArtworkImage
          src={src}
          alt=""
          sizes="18rem"
          variants={thumbnails}
          onLoad={(event) => onLoad(event.currentTarget.currentSrc)}
          onError={() => {
            setFailed(true);
            onError?.();
          }}
        />
      </button>
      {open && (
        <CoverLightbox
          preview={preview}
          original={new URL(fullSize, document.baseURI).href}
          label={label ? `${label} album cover` : "Album cover"}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
