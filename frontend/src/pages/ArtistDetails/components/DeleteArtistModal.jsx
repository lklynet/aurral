import { useId, useRef } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

export function DeleteArtistModal({
  show,
  artistName,
  libraryArtistName,
  managedBy,
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
          Remove Artist from Library
        </h3>
        <p className="artist-modal__copy">
          Are you sure you want to remove <strong>{artistName || libraryArtistName}</strong> from
          library?
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
              {managedBy === "aurral" ? (
                <>
                  <span className="artist-card-title">Delete artist files</span>
                  <p className="artist-modal__subcopy">
                    Permanently deletes the files Aurral downloaded for this artist. Files managed
                    by Lidarr stay on disk. This cannot be undone.
                  </p>
                </>
              ) : (
                <>
                  <span className="artist-card-title">Delete artist folder and files</span>
                  <p className="artist-modal__subcopy">
                    This will permanently delete the artist&apos;s folder and all music files from
                    your disk. This action cannot be undone.
                  </p>
                </>
              )}
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
                Removing...
              </>
            ) : (
              "Remove Artist"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
