import { useId, useRef } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

export function DeleteArtistModal({
  show,
  artistName,
  libraryArtistName,
  deleteFiles,
  onDeleteFilesChange,
  onCancel,
  onConfirm,
  deleting,
}) {
  const titleId = useId();
  const cancelRef = useRef(null);
  const { dialogRef } = useModalDialog({
    open: show,
    onClose: onCancel,
    closeDisabled: deleting,
    initialFocusRef: cancelRef,
  });

  if (!show) return null;
  return (
    <div className="artist-modal-backdrop">
      <div
        ref={dialogRef}
        className="artist-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="artist-modal__title">
          Delete artist
        </h3>
        <p className="artist-modal__copy">
          Delete <strong>{artistName || libraryArtistName}</strong> and its albums from your library?
        </p>

        <div>
          <label className="artist-checkbox-label">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => onDeleteFilesChange(e.target.checked)}
              className="artist-checkbox"
            />
            <div>
              <span className="artist-card-title">Delete artist files</span>
              <p className="artist-modal__subcopy">
                Permanently deletes the artist&apos;s music files from disk. This cannot be undone.
              </p>
            </div>
          </label>
        </div>

        <div className="artist-modal__actions">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={deleting}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button onClick={onConfirm} disabled={deleting} className="btn btn-danger">
            {deleting ? (
              <>
                <DotLoader size="sm" label={null} />
                Deleting...
              </>
            ) : (
              "Delete artist"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
