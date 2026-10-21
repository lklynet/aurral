import type { ComponentProps, ReactNode } from "react";
import PillToggle from "../../../components/PillToggle";

export function SettingsModalSection({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`settings-modal__section${className ? ` ${className}` : ""}`}>
      {title ? <h4 className="settings-modal__section-title">{title}</h4> : null}
      <div className="settings-modal__section-body">{children}</div>
    </section>
  );
}

export function SettingsModalField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label?: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-modal__field">
      {label ? (
        <label className="settings-modal__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {hint ? <p className="settings-modal__hint">{hint}</p> : null}
    </div>
  );
}

export function SettingsModalToggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange?: ComponentProps<typeof PillToggle>["onChange"];
  disabled?: boolean;
}) {
  return (
    <div className="settings-modal__toggle">
      <span className="settings-modal__toggle-label">{label}</span>
      <PillToggle
        className="settings-toggle"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  );
}

export function SettingsModalToggleGroup({ children }: { children: ReactNode }) {
  return <div className="settings-modal__toggle-group">{children}</div>;
}

export function SettingsModalIntro({ children }: { children: ReactNode }) {
  return <p className="settings-modal__intro">{children}</p>;
}

export function SettingsModalCallout({ children }: { children: ReactNode }) {
  return <div className="settings-modal__callout">{children}</div>;
}

export function SettingsModalActions({ children }: { children: ReactNode }) {
  return <div className="settings-modal__actions">{children}</div>;
}
