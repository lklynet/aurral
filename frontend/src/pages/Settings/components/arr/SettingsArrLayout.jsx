import { useId } from "react";

export function SettingsArrFieldSet({ legend, actions = null, children }) {
  const headingId = useId();

  return (
    <section className="arr-fieldset" aria-labelledby={headingId}>
      <div className="arr-fieldset__head">
        <h2 id={headingId} className="arr-fieldset__legend">
          {legend}
        </h2>
        {actions ? <div className="arr-fieldset__actions">{actions}</div> : null}
      </div>
      <div className="arr-fieldset__body">{children}</div>
    </section>
  );
}

export function SettingsArrFormGroup({
  label,
  labelFor,
  help,
  helpWarning = false,
  size = "small",
  children,
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
      <div className="arr-form-control">
        {children}
      </div>
    </div>
  );
}

export function SettingsArrCardGrid({ children }) {
  return <div className="arr-card-grid">{children}</div>;
}
