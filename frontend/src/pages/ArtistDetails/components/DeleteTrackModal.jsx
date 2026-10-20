import { useId } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

export function DeleteTrackModal({ show, title, hasFile = true, onCancel, onConfirm, deleting }) {
  const titleId = useId();
  const { dialogRef } = useModalDialog({
    open: show,
    onClose: onCancel,
    closeDisabled: Boolean(deleting),
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
          {hasFile ? "Delete track file" : "Remove track from library"}
        </h3>
        <p className="artist-modal__copy">
          {hasFile
            ? <>Permanently delete <strong>{title || "this track"}</strong> from disk?</>
            : <>Remove <strong>{title || "this track"}</strong> from the Library and stop future downloads?</>}
        </p>
        <div className="artist-modal__actions">
          <button onClick={onCancel} disabled={deleting} className="btn btn-secondary">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={deleting} className="btn btn-danger">
            {deleting ? (
              <>
                <DotLoader size="sm" label={null} />
                {hasFile ? "Deleting..." : "Removing..."}
              </>
            ) : (
              hasFile ? "Delete track" : "Remove track"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
