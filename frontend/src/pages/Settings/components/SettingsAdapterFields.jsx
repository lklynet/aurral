import { SettingsInput } from "./SettingsField";
import { SettingsModalField } from "./SettingsModalLayout";

export function SettingsAdapterFields({ definition, settings, onChange }) {
  return (definition?.fields || []).filter((field) => !field.hidden).map((field) => (
    <SettingsModalField key={field.key} label={field.label}>
      <SettingsInput
        type={field.type || "text"}
        required={field.required === true}
        autoComplete={field.secret ? "new-password" : "off"}
        value={settings?.[field.key] || ""}
        onChange={(event) => onChange({ [field.key]: event.target.value })}
      />
    </SettingsModalField>
  ));
}
