import { useState } from "react";
import DownloadFolderField from "../../../components/DownloadFolderField";
import PillToggle from "../../../components/PillToggle";
import { SettingsInput } from "./SettingsField";
import { Select } from "../../../components/Select";
import { SettingsGroup, SettingsRow } from "../SettingsLayout";

type AdapterValue = string | number | boolean;

type AdapterField = {
  key: string;
  label: string;
  type?: string;
  section?: string;
  advanced?: boolean;
  hidden?: boolean;
  hint?: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  options?: readonly (string | { value: string; label: string })[];
};

type AdapterDefinition = {
  key: string;
  defaults?: Record<string, AdapterValue>;
  fields?: readonly AdapterField[];
};

type FieldGroup = { title: string; fields: AdapterField[] };

function fieldId(definition: AdapterDefinition | undefined, field: AdapterField) {
  return `settings-adapter-${definition?.key || "client"}-${field.key}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  );
}

function fieldValue(
  definition: AdapterDefinition | undefined,
  settings: Record<string, unknown> | undefined,
  field: AdapterField,
): unknown {
  return (
    settings?.[field.key] ??
    definition?.defaults?.[field.key] ??
    (field.type === "toggle" ? false : "")
  );
}

function groupFields(fields: readonly AdapterField[]) {
  const groups: FieldGroup[] = [];
  for (const field of fields) {
    const title = field.section || "";
    let group = groups.at(-1);
    if (!group || group.title !== title) {
      group = { title, fields: [] };
      groups.push(group);
    }
    group.fields.push(field);
  }
  return groups;
}

export function SettingsAdapterFields({
  definition,
  settings,
  onChange,
}: {
  definition?: AdapterDefinition;
  settings?: Record<string, unknown>;
  onChange: (patch: Record<string, AdapterValue>) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fields = (definition?.fields || []).filter((field) => !field.hidden);
  const advancedFields = fields.filter((field) => field.advanced);

  const renderControl = (field: AdapterField, id: string) => {
    const value = fieldValue(definition, settings, field);
    const updateValue = (nextValue: AdapterValue) => onChange({ [field.key]: nextValue });

    if (field.type === "toggle") {
      return (
        <PillToggle
          id={id}
          checked={value === true}
          aria-label={field.label}
          onChange={(event) => updateValue(event.target.checked)}
        />
      );
    }

    if (field.type === "path") {
      return (
        <DownloadFolderField
          id={id}
          value={String(value || "")}
          autoApplySuggestion={false}
          onChange={updateValue}
        />
      );
    }

    if (field.type === "select") {
      return (
        <Select
          id={id}
          value={String(value)}
          onChange={updateValue}
          options={(field.options || []).map((option) =>
            typeof option === "object" ? option : { value: option, label: option },
          )}
        />
      );
    }

    return (
      <SettingsInput
        id={id}
        type={field.type || "text"}
        required={field.required === true}
        min={field.min}
        max={field.max}
        placeholder={field.placeholder}
        autoComplete={field.secret ? "new-password" : "off"}
        value={String(value)}
        onChange={(event) => {
          const nextValue = event.target.value;
          updateValue(field.type === "number" && nextValue !== "" ? Number(nextValue) : nextValue);
        }}
      />
    );
  };

  const renderField = (field: AdapterField) => {
    const id = fieldId(definition, field);
    return (
      <SettingsRow key={field.key} label={field.label} htmlFor={id} help={field.hint}>
        {renderControl(field, id)}
      </SettingsRow>
    );
  };

  return (
    <>
      {groupFields(fields.filter((field) => !field.advanced)).map((group, index) => (
        <SettingsGroup key={`${group.title}-${index}`} title={group.title || undefined}>
          {group.fields.map(renderField)}
        </SettingsGroup>
      ))}
      {advancedFields.length > 0 ? (
        <SettingsGroup
          title="Advanced"
          actions={
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((current) => !current)}
            >
              {showAdvanced ? "Hide" : "Show"}
            </button>
          }
        >
          {showAdvanced ? advancedFields.map(renderField) : null}
        </SettingsGroup>
      ) : null}
    </>
  );
}
