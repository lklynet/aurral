import { useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

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

export function SettingsCommitInput({
  value,
  onCommit,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <SettingsInput
      {...props}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        props.onKeyDown?.(event);
      }}
    />
  );
}
