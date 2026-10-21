import { useId } from "react";
import type { ReactNode } from "react";

export function SettingsArrFieldSet({
  legend,
  actions = null,
  className = "",
  children,
}: {
  legend: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();

  return (
    <fieldset
      className={`arr-fieldset${className ? ` ${className}` : ""}`}
      aria-labelledby={headingId}
    >
      <legend id={headingId} className="arr-fieldset__legend">
        {legend}
      </legend>
      {actions ? <div className="arr-fieldset__actions">{actions}</div> : null}
      <div className="arr-fieldset__body">{children}</div>
    </fieldset>
  );
}

export function SettingsArrFormGroup({
  label,
  labelFor,
  help,
  helpWarning = false,
  size = "small",
  children,
}: {
  label: ReactNode;
  labelFor?: string;
  help?: ReactNode;
  helpWarning?: boolean;
  size?: "small" | "large";
  children: ReactNode;
}) {
  return (
    <div className={`arr-form-group arr-form-group--${size}`}>
      <div className="arr-form-copy">
        <label className="arr-form-label" htmlFor={labelFor}>
          {label}
        </label>
        {help ? (
          <p className={`arr-form-help${helpWarning ? " arr-form-help--warning" : ""}`}>{help}</p>
        ) : null}
      </div>
      <div className="arr-form-control">{children}</div>
    </div>
  );
}

export function SettingsArrCardGrid({ children }: { children: ReactNode }) {
  return <div className="arr-card-grid">{children}</div>;
}
