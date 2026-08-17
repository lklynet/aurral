import { useId } from "react";
import { Pencil, X } from "lucide-react";
import { useModalDialog } from "../../../hooks/useModalDialog.js";

function statusTone(className) {
  if (className === "is-enabled") return "ok";
  if (className === "is-warning") return "warn";
  if (className === "is-disabled") return "danger";
  return "muted";
}

export function IntegrationCard({ title, subtitle, status, meta, onClick }) {
  return (
    <button type="button" className="arr-card" onClick={onClick}>
      <span className="arr-card__main">
        <span className="arr-card__title">{title}</span>
        {subtitle ? <span className="arr-card__subtitle">{subtitle}</span> : null}
        {meta ? <span className="arr-card__meta">{meta}</span> : null}
      </span>
      <span className="arr-card__side">
        <span className="arr-card__status-wrap">
          <span
            className={`arr-card__status arr-card__status--${statusTone(status.className)}`}
            aria-hidden="true"
          />
          <span className="arr-card__status-label">{status.label}</span>
        </span>
        <Pencil className="artist-icon-sm" aria-hidden />
      </span>
    </button>
  );
}

export function SettingsIntegrationModal({
  title,
  children,
  onClose,
  wide = true,
  footerActions = null,
  testStatus = null,
}) {
  const titleId = useId();
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: true,
    onClose,
  });

  return (
    <div className="artist-modal-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className={`settings-arr__modal settings-page__modal settings-page__modal--integration${
          wide ? " settings-page__modal--wide" : ""
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="settings-page__modal-header">
          <h3 id={titleId} className="settings-page__modal-title">
            {title}
          </h3>
          <button
            type="button"
            className="arr-btn arr-btn--ghost arr-btn--icon"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="artist-icon-md" aria-hidden="true" />
          </button>
        </div>
        <div className="settings-page__modal-body">
          <div className="settings-modal">{children}</div>
        </div>
        {footerActions || testStatus ? (
          <div className="settings-page__modal-actions">
            {testStatus ? (
              <p
                className={`settings-page__modal-result settings-page__modal-result--${testStatus.tone}`}
                role={testStatus.tone === "error" ? "alert" : "status"}
              >
                {testStatus.message}
              </p>
            ) : null}
            {footerActions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
