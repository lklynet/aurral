import { ChevronDown } from "lucide-react";
import PillToggle from "../../../components/PillToggle";
import {
  MixSlider,
  getFocusDraftValidation,
  CommaTokenInput,
  fetchFlowTagSuggestions,
  fetchFlowArtistSuggestions,
  WEEKDAY_OPTIONS,
  SCHEDULE_HOUR_OPTIONS,
} from "./MixSlider.jsx";

export function FlowScheduleFields({
  draft,
  inputClassName = "flow-page__field-control",
  onDraftChange,
  onClearError,
  sizeLabel = "Tracks",
}) {
  const updateDraft = (updater) => {
    onDraftChange((prev) => updater(prev));
    if (onClearError) onClearError();
  };
  const scheduleDays = Array.isArray(draft?.scheduleDays)
    ? [
        ...new Set(
          draft.scheduleDays
            .map((entry) => Number(entry))
            .filter((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6),
        ),
      ].sort((a, b) => a - b)
    : [];
  const scheduleTime = String(draft?.scheduleTime || "00:00");

  return (
    <div className="flow-page__form-section">
      <div className="flow-page__schedule-row">
        <div className="flow-page__field">
          <label className="flow-page__field-label">{sizeLabel}</label>
          <div className="flow-page__field-round">
            <input
              type="number"
              min="1"
              max="100"
              className={`${inputClassName} flow-page__field-input--size`}
              value={draft.size}
              onChange={(event) => {
                const value = event.target.value;
                updateDraft((prev) => ({ ...prev, size: value }));
              }}
            />
          </div>
        </div>
        <div className="flow-page__field">
          <label className="flow-page__field-label">Update hour</label>
          <div className="flow-page__field-round flow-page__field-round--select">
            <select
              className={`${inputClassName} flow-page__field-select`}
              value={scheduleTime}
              onChange={(event) =>
                updateDraft((prev) => ({
                  ...prev,
                  scheduleTime: event.target.value || "00:00",
                }))
              }
            >
              {SCHEDULE_HOUR_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown className="flow-page__select-icon" />
          </div>
        </div>
        <div className="flow-page__field flow-page__field--schedule-days">
          <label className="flow-page__field-label">Update days</label>
          <div className="flow-page__weekday-grid">
            {WEEKDAY_OPTIONS.map((day) => {
              const checked = scheduleDays.includes(day.id);
              return (
                <button
                  key={day.id}
                  type="button"
                  className={`flow-page__weekday${checked ? " is-active" : ""}`}
                  title={day.full}
                  aria-label={day.full}
                  aria-pressed={checked}
                  disabled={checked && scheduleDays.length === 1}
                  onClick={() =>
                    updateDraft((prev) => {
                      const current = Array.isArray(prev?.scheduleDays) ? prev.scheduleDays : [];
                      const normalized = [
                        ...new Set(
                          current
                            .map((entry) => Number(entry))
                            .filter(
                              (entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6,
                            ),
                        ),
                      ];
                      if (checked && normalized.length === 1) {
                        return prev;
                      }
                      const next = checked
                        ? normalized.filter((entry) => entry !== day.id)
                        : [...normalized, day.id];
                      return {
                        ...prev,
                        scheduleDays: next.sort((a, b) => a - b),
                      };
                    })
                  }
                >
                  <span>{day.short}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flow-page__history-setting">
        <div className="flow-page__history-copy">
          <div className="flow-page__field-label">Record listening history</div>
          <p className="flow-page__history-description">
            When off, tracks from this flow will not affect future recommendations or connected
            scrobblers.
          </p>
        </div>
        <div className="flow-page__history-control">
          <span className="flow-page__history-state" aria-hidden="true">
            {draft?.recordHistory !== false ? "On" : "Off"}
          </span>
          <PillToggle
            checked={draft?.recordHistory !== false}
            aria-label={`Record listening history ${draft?.recordHistory !== false ? "on" : "off"}`}
            onChange={(event) =>
              updateDraft((prev) => ({
                ...prev,
                recordHistory: event.target.checked,
              }))
            }
          />
        </div>
      </div>
    </div>
  );
}

export function PresetRecipeFields({
  draft,
  inputClassName = "flow-page__field-control",
  errorMessage,
  onDraftChange,
  onClearError,
  title,
  description,
  sizeLabel = "Tracks",
}) {
  return (
    <div className="flow-page__form">
      <div className="flow-page__preset-recipe">
        <p className="flow-page__preset-recipe-label">{title}</p>
        <p className="flow-page__preset-recipe-desc">{description}</p>
      </div>
      <FlowScheduleFields
        draft={draft}
        inputClassName={inputClassName}
        onDraftChange={onDraftChange}
        onClearError={onClearError}
        sizeLabel={sizeLabel}
      />
      {errorMessage ? <div className="flow-page__error-text">{errorMessage}</div> : null}
    </div>
  );
}

export function ReleaseRadarRecipeFields(props) {
  return (
    <PresetRecipeFields
      {...props}
      title="New releases"
      description="Finds recent albums from artists in your library that you do not have yet, then picks a standout track from each release. The track limit is a maximum; if fewer albums qualify, the playlist will be shorter. It refreshes on your schedule below."
      sizeLabel="Max tracks"
    />
  );
}

export function EditorialRecipeFields({ tag = "", ...props }) {
  const tagLabel = tag ? tag.charAt(0).toUpperCase() + tag.slice(1) : "";
  return (
    <PresetRecipeFields
      {...props}
      title={tagLabel ? `${tagLabel} picks` : "Curated picks"}
      description={
        <>
          The top tracks from Last.fm&rsquo;s {tag || "genre"} chart right now, refreshed on your
          schedule below.
        </>
      }
    />
  );
}

export function FlowFormFields({
  draft,
  inputClassName = "flow-page__field-control",
  errorMessage,
  onDraftChange,
  onClearError,
  normalizeMixPercent,
  disabledSources = {},
}) {
  const updateDraft = (updater) => {
    onDraftChange((prev) => updater(prev));
    if (onClearError) onClearError();
  };
  const normalizedMix = normalizeMixPercent(draft?.mix);
  const totalSize = Math.max(0, Math.round(Number(draft?.size) || 0));
  const { focusEnabled, focusValidationError } = getFocusDraftValidation(
    draft,
    normalizeMixPercent,
  );

  const mixScaled = (() => {
    const entries = [
      { key: "discover", value: normalizedMix.discover },
      { key: "mix", value: normalizedMix.mix },
      { key: "trending", value: normalizedMix.trending },
      { key: "focus", value: normalizedMix.focus },
    ];
    const scaled = entries.map((e) => ({
      ...e,
      raw: (e.value / 100) * totalSize,
    }));
    const floored = scaled.map((e) => ({
      ...e,
      count: Math.floor(e.raw),
      remainder: e.raw - Math.floor(e.raw),
    }));
    let leftover = totalSize - floored.reduce((acc, e) => acc + e.count, 0);
    const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
    for (let i = 0; i < ordered.length && leftover > 0; i++) {
      ordered[i].count += 1;
      leftover -= 1;
    }
    const out = {};
    for (const item of ordered) out[item.key] = item.count;
    return out;
  })();

  return (
    <div className="flow-page__form">
      <FlowScheduleFields
        draft={draft}
        inputClassName={inputClassName}
        onDraftChange={onDraftChange}
        onClearError={onClearError}
      />

      <div className="flow-page__form-section">
        <div className="flow-page__field-label flow-page__field-label--section">Source mix</div>

        <div>
          <MixSlider
            mix={draft.mix}
            trackCounts={mixScaled}
            disabledSources={disabledSources}
            trailingControl={
              <button
                type="button"
                onClick={() =>
                  updateDraft((prev) => ({
                    ...prev,
                    deepDive: !(prev?.deepDive === true),
                  }))
                }
                className={`flow-page__mix-toggle flow-page__mix-toggle--feature${draft.deepDive === true ? " is-active" : ""}${Object.keys(disabledSources || {}).length > 0 ? " is-disabled" : ""}`}
                aria-pressed={draft.deepDive === true}
                disabled={Object.keys(disabledSources || {}).length > 0}
                title={
                  Object.keys(disabledSources || {}).length > 0
                    ? "Last.fm API key required. Deep Dive skips the most obvious tracks and pulls tracks ranked 10-25."
                    : "Deep Dive skips the most obvious tracks and pulls tracks ranked 10-25."
                }
                aria-label={`Deep Dive ${draft.deepDive === true ? "on" : "off"}. Deep Dive pulls tracks ranked 10 through 25 instead of the top 10.`}
              >
                <span>Deep Dive</span>
                <span className="flow-page__mix-toggle-state">
                  {draft.deepDive === true ? "On" : "Off"}
                </span>
              </button>
            }
            onChange={(nextMix) =>
              updateDraft((prev) => ({
                ...prev,
                mix: nextMix,
              }))
            }
            normalizeMixPercent={normalizeMixPercent}
          />
          {Object.keys(disabledSources || {}).length > 0 ? (
            <p className="flow-page__warning-text">
              Flow generation requires Last.fm for source selection in this version.
            </p>
          ) : null}
        </div>
      </div>

      <div
        className={`flow-page__form-section${focusEnabled ? "" : " flow-page__form-section--dimmed"}`}
      >
        <div className="flow-page__field">
          <div className="flow-page__field-label flow-page__field-label--section">
            Focus filters
          </div>
          {focusValidationError ? (
            <div className="flow-page__warning-text">{focusValidationError}</div>
          ) : null}
        </div>

        <div className="flow-page__form-grid">
          <div className="flow-page__field">
            <label className="flow-page__field-label">Tags (genre, decade, mood)</label>
            <CommaTokenInput
              value={draft.includeTags}
              placeholder="indie, 80s, happy"
              fetchSuggestions={fetchFlowTagSuggestions}
              suggestionLabel="Genre tag suggestions"
              onChange={(nextValue) =>
                updateDraft((prev) => ({
                  ...prev,
                  includeTags: nextValue,
                }))
              }
            />
          </div>

          <div className="flow-page__field">
            <label className="flow-page__field-label">Related artists</label>
            <CommaTokenInput
              value={draft.includeRelatedArtists}
              placeholder="artist a, artist b"
              fetchSuggestions={fetchFlowArtistSuggestions}
              suggestionLabel="Related artist suggestions"
              onChange={(nextValue) =>
                updateDraft((prev) => ({
                  ...prev,
                  includeRelatedArtists: nextValue,
                }))
              }
            />
          </div>

          <div className="flow-page__field">
            <label className="flow-page__field-label">Release year(s)</label>
            <div className="flow-page__year-range">
              <div className="flow-page__field-round">
                <input
                  type="number"
                  min="1000"
                  max="9999"
                  step="1"
                  inputMode="numeric"
                  placeholder="Any"
                  aria-label="Release year from"
                  className={`${inputClassName} flow-page__field-input--size`}
                  value={draft.yearFrom ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateDraft((prev) => ({ ...prev, yearFrom: value }));
                  }}
                />
              </div>
              <span className="flow-page__year-range-sep" aria-hidden="true">
                –
              </span>
              <div className="flow-page__field-round">
                <input
                  type="number"
                  min="1000"
                  max="9999"
                  step="1"
                  inputMode="numeric"
                  placeholder="Any"
                  aria-label="Release year to"
                  className={`${inputClassName} flow-page__field-input--size`}
                  value={draft.yearTo ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateDraft((prev) => ({ ...prev, yearTo: value }));
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {errorMessage && <div className="flow-page__error-text">{errorMessage}</div>}
    </div>
  );
}
