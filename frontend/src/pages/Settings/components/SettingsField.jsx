export function SettingsField({ select = false, textarea = false, className = "", children }) {
  const kind = select
    ? ""
    : textarea
      ? " artist-modal-field--textarea"
      : " artist-modal-field--text";
  return (
    <div
      className={`artist-modal-field aurral-radius-round${kind}${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}

export function SettingsInput({ wrapperClassName = "", className = "", ...props }) {
  return (
    <SettingsField className={wrapperClassName}>
      <input className={`artist-input${className ? ` ${className}` : ""}`} {...props} />
    </SettingsField>
  );
}

export function SettingsSelect({ wrapperClassName = "", className = "", children, ...props }) {
  return (
    <SettingsField select className={wrapperClassName}>
      <select
        className={`artist-modal-select${className ? ` ${className}` : ""}`}
        {...props}
      >
        {children}
      </select>
    </SettingsField>
  );
}

export function SettingsTextarea({ wrapperClassName = "", className = "", ...props }) {
  return (
    <SettingsField textarea className={wrapperClassName}>
      <textarea
        className={`settings-page__code-input settings-page__code-input--inner${className ? ` ${className}` : ""}`}
        {...props}
      />
    </SettingsField>
  );
}
