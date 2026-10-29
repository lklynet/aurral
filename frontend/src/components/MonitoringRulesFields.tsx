import { useId, useState } from "react";
import type { MonitorRules as MonitoringRules } from "../../../backend/services/aurralMonitoring.ts";
import PillToggle from "./PillToggle";
import {
  CATALOG_OPTIONS,
  EDITION_OPTIONS,
  EXTRA_TYPE_OPTIONS,
  MAX_LATEST_RELEASES,
  MAX_TOP_TRACKS,
  RELEASE_TYPE_OPTIONS,
} from "../utils/monitoringRules.ts";
import "./MonitoringRules.css";

export type { MonitoringRules };

interface ChoiceOption {
  value: string;
  label: string;
}

const CATALOG_HINTS = {
  all: "All matching releases available now.",
  since: "Matching releases from this year on.",
  latest: "Latest matching releases available now.",
  none: "No existing releases.",
};

const EDITION_HINTS = {
  standard: "The tracklist most releases of an album share.",
  expanded: "The longest edition with every standard track.",
};

interface NumberFieldProps {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

function NumberField({ id, label, value, min, max, disabled, onChange }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      className="artist-input monitoring-rules__number"
      aria-label={label}
      min={min}
      max={max}
      value={draft ?? value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        if (event.target.value !== "" && event.target.validity.valid)
          onChange(Number(event.target.value));
      }}
      onBlur={(event) => {
        const number = Math.round(Number(event.target.value));
        if (event.target.value !== "" && Number.isFinite(number) && !event.target.validity.valid) {
          onChange(Math.min(max, Math.max(min, number)));
        }
        setDraft(null);
      }}
    />
  );
}

interface ChoiceGroupProps {
  legend: string;
  options: ChoiceOption[];
  selected: readonly string[];
  disabled: boolean;
  keepOne?: boolean;
  onToggle: (value: string) => void;
}

function ChoiceGroup({
  legend,
  options,
  selected,
  disabled,
  keepOne = false,
  onToggle,
}: ChoiceGroupProps) {
  return (
    <fieldset className="monitoring-rules__choices">
      <legend className="artist-field-label">{legend}</legend>
      <div className="monitoring-rules__choice-list">
        {options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label key={option.value} className="artist-checkbox-label monitoring-rules__choice">
              <input
                type="checkbox"
                className="artist-checkbox"
                checked={checked}
                disabled={disabled || (keepOne && checked && selected.length === 1)}
                onChange={() => onToggle(option.value)}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

interface MonitoringRulesFieldsProps {
  rules: MonitoringRules;
  onChange: (rules: MonitoringRules) => void;
  disabled?: boolean;
}

export function MonitoringRulesFields({
  rules,
  onChange,
  disabled = false,
}: MonitoringRulesFieldsProps) {
  const id = useId();
  const currentYear = new Date().getFullYear();
  const update = (patch: Partial<MonitoringRules>) => onChange({ ...rules, ...patch });
  const toggle = (key: "types" | "extraTypes") => (value: string) =>
    update({
      [key]: rules[key].includes(value)
        ? rules[key].filter((entry) => entry !== value)
        : [...rules[key], value],
    });

  return (
    <div className="monitoring-rules">
      <div>
        <label className="artist-field-label" htmlFor={`${id}-catalog`}>
          Back catalogue
        </label>
        <div className="monitoring-rules__row">
          <div className="artist-modal-field monitoring-rules__select">
            <select
              id={`${id}-catalog`}
              className="artist-modal-select"
              value={rules.catalog}
              disabled={disabled}
              onChange={(event) =>
                update({
                  catalog: event.target.value as MonitoringRules["catalog"],
                  sinceYear:
                    event.target.value === "since"
                      ? rules.sinceYear || currentYear - 5
                      : rules.sinceYear,
                })
              }
            >
              {CATALOG_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {rules.catalog === "since" ? (
            <NumberField
              id={`${id}-since`}
              label="First year"
              value={rules.sinceYear}
              min={1900}
              max={currentYear + 1}
              disabled={disabled}
              onChange={(sinceYear) => update({ sinceYear })}
            />
          ) : null}
          {rules.catalog === "latest" ? (
            <NumberField
              id={`${id}-latest`}
              label="Number of releases"
              value={rules.latestCount}
              min={1}
              max={MAX_LATEST_RELEASES}
              disabled={disabled}
              onChange={(latestCount) => update({ latestCount })}
            />
          ) : null}
        </div>
        <p className="monitoring-rules__hint">{CATALOG_HINTS[rules.catalog]}</p>
      </div>

      <div className="monitoring-rules__toggle">
        <div>
          <span className="artist-field-label">New releases</span>
          <p className="monitoring-rules__hint">Download matching releases when they come out.</p>
        </div>
        <PillToggle
          checked={rules.newReleases}
          disabled={disabled}
          aria-label="New releases"
          onChange={(event: { target: { checked: boolean } }) =>
            update({ newReleases: event.target.checked })
          }
        />
      </div>

      <ChoiceGroup
        legend="Release types"
        options={RELEASE_TYPE_OPTIONS}
        selected={rules.types}
        disabled={disabled}
        keepOne
        onToggle={toggle("types")}
      />
      <ChoiceGroup
        legend="Also include"
        options={EXTRA_TYPE_OPTIONS}
        selected={rules.extraTypes}
        disabled={disabled}
        onToggle={toggle("extraTypes")}
      />

      <div className="monitoring-rules__pair">
        <div>
          <label className="artist-field-label" htmlFor={`${id}-edition`}>
            Edition
          </label>
          <div className="artist-modal-field">
            <select
              id={`${id}-edition`}
              className="artist-modal-select"
              value={rules.edition}
              disabled={disabled}
              onChange={(event) =>
                update({ edition: event.target.value as MonitoringRules["edition"] })
              }
            >
              {EDITION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <p className="monitoring-rules__hint">{EDITION_HINTS[rules.edition]}</p>
        </div>
        <div>
          <label className="artist-field-label" htmlFor={`${id}-top`}>
            Top tracks
          </label>
          <NumberField
            id={`${id}-top`}
            label="Top tracks"
            value={rules.topTracks}
            min={0}
            max={MAX_TOP_TRACKS}
            disabled={disabled}
            onChange={(topTracks) => update({ topTracks })}
          />
          <p className="monitoring-rules__hint">Popular songs missing from these releases.</p>
        </div>
      </div>
    </div>
  );
}
