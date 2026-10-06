export function SettingsInput({ className = "", ...props }) {
  return <input className={`arr-input${className ? ` ${className}` : ""}`} {...props} />;
}

export function SettingsSelect({ className = "", children, ...props }) {
  return (
    <select className={`arr-input arr-select${className ? ` ${className}` : ""}`} {...props}>
      {children}
    </select>
  );
}

export function SettingsTextarea({ className = "", ...props }) {
  return <textarea className={`arr-input arr-textarea${className ? ` ${className}` : ""}`} {...props} />;
}
