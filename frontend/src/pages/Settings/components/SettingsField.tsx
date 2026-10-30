import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function SettingsInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input${className ? ` ${className}` : ""}`} {...props} />;
}

export function SettingsSelect({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`input${className ? ` ${className}` : ""}`} {...props}>
      {children}
    </select>
  );
}

export function SettingsTextarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={`input settings-textarea${className ? ` ${className}` : ""}`} {...props} />
  );
}
