import { Fragment, useId } from "react";
import {
  CommaTokenInput,
  fetchFlowArtistSuggestions,
  fetchFlowTagSuggestions,
} from "./CommaTokenInput.tsx";
import PillToggle from "../../../components/PillToggle";
import Tooltip from "../../../components/Tooltip";
import { Select } from "../../../components/Select";
import { FLOW_SOURCES, normalizeScheduleDays, type FlowSource } from "../../../../../lib/flows.ts";
import {
  FOCUS_NEEDS_SEEDS,
  flowDraftTotal,
  focusNeedsSeeds,
  type FlowDraft,
} from "../flowPageUtils.ts";

type FlowDraftUpdater = (updater: (prev: FlowDraft) => FlowDraft) => void;

const SOURCES: Record<FlowSource, { label: string; description: string }> = {
  discover: { label: "Discover", description: "Your recommendations" },
  mix: { label: "Library", description: "Artists you own, tracks you don't" },
  trending: { label: "Trending", description: "Trending this week" },
  focus: { label: "Focus", description: "Similar artists or your recent listening" },
  newReleases: { label: "New releases", description: "Recent albums you're missing" },
};

const MAX_SOURCE_TRACKS = 100;

const WEEKDAY_OPTIONS = [
  { id: 0, short: "Su", full: "Sunday" },
  { id: 1, short: "M", full: "Monday" },
  { id: 2, short: "T", full: "Tuesday" },
  { id: 3, short: "W", full: "Wednesday" },
  { id: 4, short: "Th", full: "Thursday" },
  { id: 5, short: "F", full: "Friday" },
  { id: 6, short: "S", full: "Saturday" },
];

const SCHEDULE_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: `${String(hour).padStart(2, "0")}:00`,
  label: `${hour % 12 || 12}:00 ${hour >= 12 ? "PM" : "AM"}`,
}));

const toTrackCount = (value: string) =>
  Math.min(MAX_SOURCE_TRACKS, Math.max(0, Math.round(Number(value) || 0)));

export function FlowFormFields({
  draft,
  inputClassName = "flow-page__field-control",
  errorMessage,
  onDraftChange,
  onClearError,
}: {
  draft: FlowDraft;
  inputClassName?: string;
  errorMessage?: string | null;
  onDraftChange: FlowDraftUpdater;
  onClearError?: () => void;
}) {
  const updateDraft: FlowDraftUpdater = (updater) => {
    onDraftChange(updater);
    onClearError?.();
  };
  const setCount = (source: FlowSource, count: number) =>
    updateDraft((prev) => ({ ...prev, counts: { ...prev.counts, [source]: count } }));
  const scheduleDays = normalizeScheduleDays(draft.scheduleDays);
  const idPrefix = useId();
  const yearInput = (key: "yearFrom" | "yearTo", label: string) => (
    <div className="flow-page__field-round">
      <input
        type="number"
        min="1000"
        max="9999"
        step="1"
        inputMode="numeric"
        placeholder="Any"
        aria-label={label}
        className={`${inputClassName} flow-page__field-input--size`}
        value={draft[key] ?? ""}
        onChange={(event) => {
          const value = event.target.value;
          updateDraft((prev) => ({ ...prev, [key]: value }));
        }}
      />
    </div>
  );

  return (
    <div className="flow-page__form">
      <div className="flow-page__form-section">
        <div className="flow-page__schedule-line">
          <span className="flow-page__schedule-word">Updates</span>
          <div className="flow-page__weekday-grid" role="group" aria-label="Update days">
            {WEEKDAY_OPTIONS.map((day) => {
              const checked = scheduleDays.includes(day.id);
              const isLastDay = checked && scheduleDays.length === 1;
              return (
                <Tooltip key={day.id} content={day.full}>
                  <button
                    type="button"
                    className={`flow-page__weekday${checked ? " is-active" : ""}`}
                    aria-label={day.full}
                    aria-pressed={checked}
                    aria-disabled={isLastDay}
                    onClick={() => {
                      if (isLastDay) return;
                      updateDraft((prev) => {
                        const current = normalizeScheduleDays(prev.scheduleDays);
                        return {
                          ...prev,
                          scheduleDays: checked
                            ? current.filter((entry) => entry !== day.id)
                            : normalizeScheduleDays([...current, day.id]),
                        };
                      });
                    }}
                  >
                    <span>{day.short}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
          <span className="flow-page__schedule-word">at</span>
          <div className="flow-page__field-round flow-page__field-round--select">
            <Select
              className={`${inputClassName} flow-page__field-select`}
              aria-label="Update hour"
              value={String(draft.scheduleTime || "00:00")}
              onChange={(time) =>
                updateDraft((prev) => ({ ...prev, scheduleTime: time || "00:00" }))
              }
              options={SCHEDULE_HOUR_OPTIONS}
            />
          </div>
        </div>
      </div>

      <div className="flow-page__form-section">
        <div className="flow-page__section-head">
          <span className="flow-page__section-title">Tracks</span>
          <span className="flow-page__section-total">{flowDraftTotal(draft)}</span>
        </div>
        <div className="flow-page__sources" role="group" aria-label="Sources">
          {FLOW_SOURCES.map((source) => {
            const { label, description } = SOURCES[source];
            const count = draft.counts[source];
            const countId = `${idPrefix}-${source}`;
            const showFocusOptions = source === "focus" && count > 0;
            return (
              <Fragment key={source}>
                <div className={`flow-page__source${count > 0 ? "" : " is-off"}`}>
                  <label className="flow-page__source-name" htmlFor={countId}>
                    {label}
                  </label>
                  {showFocusOptions ? (
                    <div className="flow-page__source-detail">
                      <CommaTokenInput
                        value={draft.includeRelatedArtists}
                        placeholder="Similar to these artists"
                        fetchSuggestions={fetchFlowArtistSuggestions}
                        suggestionLabel="Similar artist suggestions"
                        onChange={(includeRelatedArtists) =>
                          updateDraft((prev) => ({ ...prev, includeRelatedArtists }))
                        }
                      />
                    </div>
                  ) : (
                    <span className="flow-page__source-detail">{description}</span>
                  )}
                  <input
                    id={countId}
                    type="number"
                    min="0"
                    max={MAX_SOURCE_TRACKS}
                    inputMode="numeric"
                    aria-label={`${label} tracks`}
                    className={`${inputClassName} flow-page__source-count`}
                    value={count}
                    onChange={(event) => setCount(source, toTrackCount(event.target.value))}
                  />
                </div>
                {showFocusOptions ? (
                  <label className="flow-page__switch flow-page__source-option">
                    <PillToggle
                      checked={draft.recentListening === true}
                      aria-label="Also use my recent listening"
                      onChange={(event) =>
                        updateDraft((prev) => ({ ...prev, recentListening: event.target.checked }))
                      }
                    />
                    Also use my recent listening
                  </label>
                ) : null}
              </Fragment>
            );
          })}
        </div>
        {focusNeedsSeeds(draft) ? (
          <div className="flow-page__warning-text">{FOCUS_NEEDS_SEEDS}</div>
        ) : null}
        <div className="flow-page__toggle-row">
          <label className="flow-page__switch">
            <PillToggle
              checked={draft.deepDive === true}
              aria-label="Deeper cuts"
              onChange={(event) =>
                updateDraft((prev) => ({ ...prev, deepDive: event.target.checked }))
              }
            />
            Deeper cuts
          </label>
          <span className="flow-page__hint">
            {"Tracks ranked 10 to 25 instead of each artist's top 10"}
          </span>
        </div>
      </div>

      <div className="flow-page__form-section">
        <div className="flow-page__section-title">Filters</div>
        <div className="flow-page__filter-row">
          <div className="flow-page__field flow-page__field--grow">
            <label className="flow-page__field-label">Tags</label>
            <CommaTokenInput
              value={draft.includeTags}
              placeholder="hip hop, 80s, happy"
              fetchSuggestions={fetchFlowTagSuggestions}
              suggestionLabel="Tag suggestions"
              excludable
              onChange={(includeTags) => updateDraft((prev) => ({ ...prev, includeTags }))}
            />
            <div className="flow-page__hint">Start a tag with - to leave it out.</div>
          </div>
          <div className="flow-page__field">
            <label className="flow-page__field-label">Released</label>
            <div className="flow-page__year-range">
              {yearInput("yearFrom", "Release year from")}
              <span className="flow-page__year-range-sep">to</span>
              {yearInput("yearTo", "Release year to")}
            </div>
          </div>
        </div>
      </div>

      {errorMessage ? <div className="flow-page__error-text">{errorMessage}</div> : null}
    </div>
  );
}
