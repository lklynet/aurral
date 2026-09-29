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
  const isAurral = managedBy === "aurral";
  const unmonitors = !isAurral && keepFilesAction === "unmonitor" && !deleteFiles;

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
          {isAurral ? "Remove album from library" : "Delete Album from Library"}
        </h3>
        <p className="artist-modal__copy">
          {unmonitors ? (
            <>
              <strong>{title}</strong> stays in Lidarr and stops being monitored. Delete its files
              to remove it.
            </>
          ) : isAurral ? (
            <>
              <strong>{title}</strong> will leave your Aurral library.
            </>
          ) : (
            <>
              Are you sure you want to delete <strong>{title}</strong> from library?
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
              {managedBy === "aurral" ? (
                <>
                  <span className="artist-card-title">Delete album files</span>
                  <p className="artist-modal__subcopy">
                    Permanently deletes the files Aurral downloaded for this album. Files managed
                    by Lidarr stay on disk. This cannot be undone.
                  </p>
                </>
              ) : (
                <>
                  <span className="artist-card-title">Delete album folder and files</span>
                  <p className="artist-modal__subcopy">
                    This will permanently delete the album&apos;s folder and all music files from
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
            disabled={!!removing}
            className="btn btn-secondary"
          >
            Cancel
          </button>
          <button onClick={onConfirm} disabled={!!removing} className="btn btn-danger">
            {removing ? (
              <>
                <DotLoader size="sm" label={null} />
                {unmonitors ? "Unmonitoring..." : isAurral ? "Removing..." : "Deleting..."}
              </>
            ) : unmonitors ? (
              "Unmonitor album"
            ) : isAurral ? (
              "Remove album"
            ) : (
              "Delete Album"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
