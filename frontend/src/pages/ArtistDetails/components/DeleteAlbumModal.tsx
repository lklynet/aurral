import { useId, useRef } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.ts";

interface DeleteAlbumModalProps {
  show: boolean;
  title?: string | null;
  deleteFiles: boolean;
  onDeleteFilesChange: (checked: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  removing?: boolean | null;
}

export function DeleteAlbumModal({
  show,
  title,
  deleteFiles,
  onDeleteFilesChange,
  onCancel,
  onConfirm,
  removing,
}: DeleteAlbumModalProps) {
  const titleId = useId();
  const cancelRef = useRef(null);
  const { dialogRef } = useModalDialog({
    open: show,
    onClose: onCancel,
    closeDisabled: Boolean(removing),
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
          Delete album
        </h3>
        <p className="artist-modal__copy">
          Delete <strong>{title}</strong> from your library? Artist monitoring skips it until you
          request it again.
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
                Permanently deletes the album files from disk.
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
                Deleting...
              </>
            ) : (
              "Delete album"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
