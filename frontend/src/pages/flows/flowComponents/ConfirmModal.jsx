import { useId } from "react";
import { DotLoader } from "../../../components/DotLoader";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  busyLabel,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const titleId = useId();
  const bodyId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open,
    onClose: onCancel,
    closeDisabled: busy,
  });

  if (!open) return null;

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="artist-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="artist-modal__title">
          {title}
        </h3>
        <p id={bodyId} className="artist-modal__subcopy">
          {body}
        </p>
        <div className="artist-modal__actions">
          <button type="button" onClick={onCancel} className="btn btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn btn-secondary flow-page__btn--destructive"
            disabled={busy}
          >
            {busy ? <DotLoader size="sm" label={null} /> : null}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
