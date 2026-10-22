import { Fragment, useState } from "react";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { SettingsInput, SettingsSelect } from "./SettingsField";
import {
  SettingsModalField,
  SettingsModalSection,
  SettingsModalToggle,
} from "./SettingsModalLayout";

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

function groupFields(fields: readonly AdapterField[], advanced: boolean) {
  const groups: FieldGroup[] = [];
  for (const field of fields) {
    if (Boolean(field.advanced) !== advanced) continue;
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
  const advancedGroups = groupFields(fields, true);

  const renderField = (field: AdapterField) => {
    const value = fieldValue(definition, settings, field);
    const updateValue = (nextValue: AdapterValue) => onChange({ [field.key]: nextValue });

    if (field.type === "toggle") {
      return (
        <SettingsModalToggle
          key={field.key}
          label={field.label}
          checked={value === true}
          onChange={(event) => updateValue(event.target.checked)}
        />
      );
    }

    const id = fieldId(definition, field);
    if (field.type === "path") {
      return (
        <SettingsModalField key={field.key} label={field.label} htmlFor={id} hint={field.hint}>
          <DownloadFolderField
            id={id}
            value={String(value || "")}
            autoApplySuggestion={false}
            onChange={updateValue}
          />
        </SettingsModalField>
      );
    }

    if (field.type === "select") {
      return (
        <SettingsModalField key={field.key} label={field.label} htmlFor={id} hint={field.hint}>
          <SettingsSelect
            id={id}
            required={field.required === true}
            value={String(value)}
            onChange={(event) => updateValue(event.target.value)}
          >
            {(field.options || []).map((option) => {
              const item = typeof option === "object" ? option : { value: option, label: option };
              return (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              );
            })}
          </SettingsSelect>
        </SettingsModalField>
      );
    }

    return (
      <SettingsModalField key={field.key} label={field.label} htmlFor={id} hint={field.hint}>
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
            updateValue(
              field.type === "number" && nextValue !== "" ? Number(nextValue) : nextValue,
            );
          }}
        />
      </SettingsModalField>
    );
  };

  const renderGroups = (advanced: boolean) =>
    groupFields(fields, advanced).map((group, index) =>
      group.title ? (
        <SettingsModalSection key={`${group.title}-${index}`} title={group.title}>
          {group.fields.map(renderField)}
        </SettingsModalSection>
      ) : (
        <Fragment key={`default-${index}`}>{group.fields.map(renderField)}</Fragment>
      ),
    );

  return (
    <>
      {renderGroups(false)}
      {advancedGroups.length > 0 ? (
        <div className="settings-page__advanced-toggle-row">
          <button
            type="button"
            className="settings-page__advanced-toggle"
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {showAdvanced ? "Hide advanced" : "Show advanced"}
          </button>
        </div>
      ) : null}
      {showAdvanced ? renderGroups(true) : null}
    </>
  );
}
