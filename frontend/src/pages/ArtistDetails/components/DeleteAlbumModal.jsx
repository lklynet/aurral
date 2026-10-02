import { useId, useRef } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

export function DeleteAlbumModal({
  show,
  title,
  managedBy,
  keepFilesAction = "remove",
  deleteFiles,
  onDeleteFilesChange,
  onCancel,
  onConfirm,
  removing,
}) {
  const titleId = useId();
  const cancelRef = useRef(null);
  const { dialogRef } = useModalDialog({
    open: show,
    onClose: onCancel,
    closeDisabled: Boolean(removing),
    initialFocusRef: cancelRef,
  });
  const unmonitors = managedBy !== "aurral" && keepFilesAction === "unmonitor" && !deleteFiles;

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
          Delete album
        </h3>
        <p className="artist-modal__copy">
          {unmonitors ? (
            <>
              <strong>{title}</strong> stays in your library and stops being monitored. Delete its
              files to remove it.
            </>
          ) : (
            <>
              Delete <strong>{title}</strong> from your library?
            </>
          )}
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
              <span className="artist-card-title">Delete album files</span>
              <p className="artist-modal__subcopy">
                Permanently deletes the album&apos;s music files from disk. This cannot be undone.
              </p>
            </div>
          </label>
        </div>

        <div className="artist-modal__actions">
          <button
            ref={cancelRef}
            onClick={onCancel}
            disabled={!!removing}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button onClick={onConfirm} disabled={!!removing} className="btn btn-danger">
            {removing ? (
              <>
                <DotLoader size="sm" label={null} />
                {unmonitors ? "Unmonitoring..." : "Deleting..."}
              </>
            ) : unmonitors ? (
              "Unmonitor album"
            ) : (
              "Delete album"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
