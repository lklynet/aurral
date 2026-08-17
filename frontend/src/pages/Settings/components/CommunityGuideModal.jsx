import { useId } from "react";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

export function CommunityGuideModal({ show, onClose, onApply }) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: show,
    onClose,
  });

  if (!show) return null;
  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="settings-page__modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="settings-page__modal-title">
          Apply recommended settings
        </h3>
        <p className="settings-page__modal-copy">
          Apply Davo&apos;s Community Lidarr Guide settings to your Lidarr instance:
        </p>
        <ul className="settings-page__modal-list">
          <li>Update quality definitions for FLAC and FLAC 24bit</li>
          <li>Add custom formats (Preferred Groups, CD, WEB, Lossless, Vinyl)</li>
          <li>Update naming scheme</li>
          <li>
            Create <strong>&quot;Aurral - HQ&quot;</strong> quality profile (FLAC + MP3-320)
          </li>
        </ul>
        <p className="settings-page__modal-footnote">
          <a
            href="https://wiki.servarr.com/lidarr/community-guide"
            target="_blank"
            rel="noopener noreferrer"
            className="settings-page__link"
          >
            Read the full guide
          </a>
        </p>
        <div className="settings-page__modal-actions">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button type="button" onClick={onApply} className="btn btn-primary">
            Apply settings
          </button>
        </div>
      </div>
    </div>
  );
}
