export function CommunityGuideModal({
  show,
  onClose,
  onApply,
}) {
  if (!show) return null;
  return (
    <div className="artist-modal-backdrop" onClick={onClose}>
      <div
        className="settings-page__modal"
        role="dialog"
        aria-labelledby="community-guide-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="community-guide-modal-title" className="settings-page__modal-title">
          Apply Davo&apos;s Recommended Settings
        </h3>
        <p className="settings-page__modal-copy">
          This will apply Davo&apos;s Community Lidarr Guide settings to your
          Lidarr instance:
        </p>
        <ul className="settings-page__modal-list">
          <li>Update quality definitions for FLAC and FLAC 24bit</li>
          <li>
            Add custom formats (Preferred Groups, CD, WEB, Lossless, Vinyl)
          </li>
          <li>Update naming scheme</li>
          <li>
            Create <strong>&quot;Aurral - HQ&quot;</strong> quality profile
            (FLAC + MP3-320)
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
          </a>{" "}
          for more details on these settings.
        </p>
        <div className="settings-page__modal-actions">
          <button type="button" onClick={onClose} className="btn btn-secondary">
            Cancel
          </button>
          <button type="button" onClick={onApply} className="btn btn-primary">
            Apply Settings
          </button>
        </div>
      </div>
    </div>
  );
}
