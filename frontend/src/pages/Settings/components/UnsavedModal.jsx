import { AlertTriangle } from "lucide-react";

export function UnsavedModal({ show, onCancel, onConfirm }) {
  if (!show) return null;
  return (
    <div className="artist-modal-backdrop" onClick={onCancel}>
      <div
        className="settings-page__modal"
        role="dialog"
        aria-labelledby="unsaved-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-page__modal-alert">
          <AlertTriangle className="settings-page__modal-alert-icon" />
          <div>
            <h3 id="unsaved-modal-title" className="settings-page__modal-title">
              Unsaved Changes
            </h3>
            <p className="settings-page__modal-copy">
              You have unsaved changes. Are you sure you want to leave? Your
              changes will be lost.
            </p>
          </div>
        </div>
        <div className="settings-page__modal-actions">
          <button type="button" onClick={onCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn btn-danger"
          >
            Leave Without Saving
          </button>
        </div>
      </div>
    </div>
  );
}
