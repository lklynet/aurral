import { createContext, useContext, useId, type ReactNode } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, X } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader";
import TooltipButton from "../../components/TooltipButton";
import { SettingsLink, useSettingsRoute } from "./settingsRoute";

export const SettingsSavingContext = createContext(false);

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
    <div className="settings-page">
      <header className="settings-bar">
        <TooltipButton
          label={`Back to ${back ?? "Settings"}`}
          className="btn btn-ghost btn-icon settings-bar__back"
          onClick={route.back}
        >
          <ChevronLeft aria-hidden="true" />
        </TooltipButton>
        <div className="settings-bar__crumbs">
          <span className="settings-bar__root">Settings</span>
          {back ? (
            <button type="button" className="settings-bar__crumb" onClick={route.back}>
              {back}
            </button>
          ) : null}
          <h2 className="settings-bar__title">{title}</h2>
        </div>
        <span className="settings-bar__saving" role="status" aria-live="polite">
          {saving ? (
            <>
              <DotLoader size="xs" label={null} /> Saving…
            </>
          ) : null}
        </span>
        <TooltipButton
          label="Close settings"
          className="btn btn-ghost btn-icon settings-bar__close"
          onClick={route.close}
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
