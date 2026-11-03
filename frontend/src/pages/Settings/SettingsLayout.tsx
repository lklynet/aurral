import { createContext, useContext, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronLeft, ChevronRight, X } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import TooltipButton from "../../components/TooltipButton";
import { useModalDialog } from "../../hooks/useModalDialog.ts";
import { SettingsLink, useSettingsRoute } from "./settingsRoute";
import "./settings.css";

export const SettingsSavingContext = createContext(false);

export function SettingsShell({
  label,
  view,
  onClose,
  closeDisabled = false,
  nav,
  children,
}: {
  label: string;
  view: "nav" | "pane";
  onClose: () => void;
  closeDisabled?: boolean;
  nav: ReactNode;
  children: ReactNode;
}) {
  const { dialogRef, handleBackdropClick } = useModalDialog({
    open: true,
    onClose,
    closeDisabled,
  });
  return createPortal(
    <div className="settings-dialog-backdrop" onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-view={view}
      >
        <div className="settings-dialog__nav">
          <div className="settings-dialog__phone-head">
            <span className="settings-dialog__phone-title">{label}</span>
            <TooltipButton
              label={`Close ${label.toLowerCase()}`}
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              disabled={closeDisabled}
            >
              <X aria-hidden="true" />
            </TooltipButton>
          </div>
          {nav}
        </div>
        <div className="settings-dialog__pane">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function SettingsPane({
  crumbs,
  title,
  backLabel,
  onBack,
  closeLabel,
  onClose,
  closeDisabled = false,
  status,
  actions,
  children,
}: {
  crumbs: { label: ReactNode; onClick?: () => void }[];
  title: ReactNode;
  backLabel: string;
  onBack: () => void;
  closeLabel: string;
  onClose: () => void;
  closeDisabled?: boolean;
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-page">
      <header className="settings-bar">
        <TooltipButton
          label={backLabel}
          className="btn btn-ghost btn-icon settings-bar__back"
          onClick={onBack}
        >
          <ChevronLeft aria-hidden="true" />
        </TooltipButton>
        <div className="settings-bar__crumbs">
          {crumbs.map((crumb, index) =>
            crumb.onClick ? (
              <button
                key={index}
                type="button"
                className="settings-bar__crumb"
                onClick={crumb.onClick}
              >
                {crumb.label}
              </button>
            ) : (
              <span key={index} className="settings-bar__root">
                {crumb.label}
              </span>
            ),
          )}
          <h2 className="settings-bar__title">{title}</h2>
        </div>
        <span className="settings-bar__saving" role="status" aria-live="polite">
          {status}
        </span>
        {actions}
        <TooltipButton
          label={closeLabel}
          className="btn btn-ghost btn-icon"
          onClick={onClose}
          disabled={closeDisabled}
        >
          <X aria-hidden="true" />
        </TooltipButton>
      </header>
      <div className="settings-page__scroll">
        <div className="settings-page__content">{children}</div>
      </div>
    </div>
  );
}

export function SettingsPage({
  title,
  back,
  children,
}: {
  title: ReactNode;
  back?: string;
  children: ReactNode;
}) {
  const saving = useContext(SettingsSavingContext);
  const route = useSettingsRoute();
  return (
    <SettingsPane
      crumbs={[{ label: "Settings" }, ...(back ? [{ label: back, onClick: route.back }] : [])]}
      title={title}
      backLabel={`Back to ${back ?? "Settings"}`}
      onBack={route.back}
      closeLabel="Close settings"
      onClose={route.close}
      status={
        saving ? (
          <>
            <DotLoader size="xs" label={null} /> Saving…
          </>
        ) : null
      }
    >
      {children}
    </SettingsPane>
  );
}

export function SettingsGroup({
  title,
  note,
  actions,
  children,
}: {
  title?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="settings-group" aria-labelledby={title ? headingId : undefined}>
      {title || actions ? (
        <div className="settings-group__head">
          {title ? (
            <h3 id={headingId} className="settings-group__title">
              {title}
            </h3>
          ) : null}
          {actions ? <div className="settings-group__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="settings-card">
        {note ? <p className="settings-group__note">{note}</p> : null}
        {children}
      </div>
    </section>
  );
}

type Tone = "default" | "warning" | "error";

export function SettingsRow({
  label,
  htmlFor,
  help,
  tone = "default",
  stack = false,
  children,
}: {
  label?: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  tone?: Tone;
  stack?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`settings-row${stack ? " settings-row--stack" : ""}`}>
      {label || help ? (
        <div className="settings-row__copy">
          {label ? (
            htmlFor ? (
              <label className="settings-row__label" htmlFor={htmlFor}>
                {label}
              </label>
            ) : (
              <span className="settings-row__label">{label}</span>
            )
          ) : null}
          {help ? <p className={`settings-row__help settings-row__help--${tone}`}>{help}</p> : null}
        </div>
      ) : null}
      {children ? <div className="settings-row__control">{children}</div> : null}
    </div>
  );
}

export type ServiceStatus = { label: ReactNode; tone?: "default" | "muted" | "error" };

export function SettingsServiceRow({
  to,
  name,
  status,
}: {
  to: string;
  name: ReactNode;
  status?: ServiceStatus | null;
}) {
  const tone = status?.tone ?? "default";
  return (
    <SettingsLink to={to} className="settings-service">
      <span className="settings-service__name">{name}</span>
      {status ? (
        <span className={`settings-service__status settings-service__status--${tone}`}>
          {tone === "error" ? <AlertCircle aria-hidden="true" /> : null}
          {status.label}
        </span>
      ) : null}
      <ChevronRight className="settings-service__chevron" aria-hidden="true" />
    </SettingsLink>
  );
}

export function SettingsNote({ tone = "default", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <p
      className={`settings-note settings-note--${tone}`}
      role={tone === "error" ? "alert" : undefined}
    >
      {tone !== "default" ? <AlertCircle aria-hidden="true" /> : null}
      <span>{children}</span>
    </p>
  );
}

export function SettingsActions({
  status,
  children,
}: {
  status?: { tone: "success" | "error"; message: ReactNode } | null;
  children: ReactNode;
}) {
  return (
    <div className="settings-actions">
      {children}
      {status ? (
        <p
          className={`settings-actions__status settings-actions__status--${status.tone}`}
          role={status.tone === "error" ? "alert" : "status"}
        >
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

export function useSettingsItem() {
  const { path } = useSettingsRoute();
  return path?.split("/")[1] || null;
}
