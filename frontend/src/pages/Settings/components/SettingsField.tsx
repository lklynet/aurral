import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function SettingsInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input${className ? ` ${className}` : ""}`} {...props} />;
}

export function SettingsTextarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={`input settings-textarea${className ? ` ${className}` : ""}`} {...props} />
  );
}
