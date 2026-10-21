import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

type LegacyStyleProps = { legacyStyle?: boolean };

export function SettingsInput({
  legacyStyle = false,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & LegacyStyleProps) {
  return (
    <input
      className={
        legacyStyle
          ? `artist-input${className ? ` ${className}` : ""}`
          : `arr-input${className ? ` ${className}` : ""}`
      }
      {...props}
    />
  );
}

export function SettingsSelect({
  legacyStyle = false,
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & LegacyStyleProps) {
  return (
    <select
      className={
        legacyStyle
          ? `artist-modal-select${className ? ` ${className}` : ""}`
          : `arr-input arr-select${className ? ` ${className}` : ""}`
      }
      {...props}
    >
      {children}
    </select>
  );
}

export function SettingsTextarea({
  legacyStyle = false,
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & LegacyStyleProps) {
  return (
    <textarea
      className={
        legacyStyle
          ? `settings-page__code-input settings-page__code-input--inner${
              className ? ` ${className}` : ""
            }`
          : `arr-input arr-textarea${className ? ` ${className}` : ""}`
      }
      {...props}
    />
  );
}
