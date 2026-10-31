import {
  CommaTokenInput,
  fetchFlowArtistSuggestions,
  fetchFlowTagSuggestions,
} from "./CommaTokenInput.tsx";
import PillToggle from "../../../components/PillToggle";
import Tooltip from "../../../components/Tooltip";
import { Select } from "../../../components/Select";
import { FLOW_SOURCES, type FlowSource } from "../../../../../lib/flows.ts";
import {
  FOCUS_NEEDS_SEEDS,
  flowDraftTotal,
  focusNeedsSeeds,
  normalizeScheduleDays,
  type FlowDraft,
} from "../flowPageUtils.ts";

type FlowDraftUpdater = (updater: (prev: FlowDraft) => FlowDraft) => void;

const SOURCES: Record<FlowSource, { label: string; description: string }> = {
  discover: { label: "Discover", description: "Your recommendations" },
  mix: { label: "Library", description: "Artists you own, tracks you don't" },
  trending: { label: "Trending", description: "Trending this week" },
  focus: { label: "Focus", description: "Similar to" },
  newReleases: { label: "New releases", description: "Recent albums you're missing" },
};

const NEW_SOURCE_TRACKS = 10;
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
        <div className="flow-page__section-title">Only include</div>
        <div className="flow-page__filter-row">
          <div className="flow-page__field flow-page__field--grow">
            <label className="flow-page__field-label">Tags</label>
            <CommaTokenInput
              value={draft.includeTags}
              placeholder="hip hop, 80s, happy"
              fetchSuggestions={fetchFlowTagSuggestions}
              suggestionLabel="Tag suggestions"
              onChange={(includeTags) => updateDraft((prev) => ({ ...prev, includeTags }))}
            />
          </div>
          <div className="flow-page__field">
            <label className="flow-page__field-label">Release years</label>
            <div className="flow-page__year-range">
              {yearInput("yearFrom", "Release year from")}
              <span className="flow-page__year-range-sep">to</span>
              {yearInput("yearTo", "Release year to")}
            </div>
          </div>
        </div>
      </div>

      <div className="flow-page__form-section">
        <div className="flow-page__sources" role="group" aria-label="Sources">
          {FLOW_SOURCES.map((source) => {
            const { label, description } = SOURCES[source];
            const count = draft.counts[source];
            return (
              <div key={source} className={`flow-page__source${count > 0 ? "" : " is-off"}`}>
                <label className="flow-page__source-name">
                  <input
                    type="checkbox"
                    className="artist-checkbox"
                    checked={count > 0}
                    onChange={(event) =>
                      setCount(source, event.target.checked ? NEW_SOURCE_TRACKS : 0)
                    }
                  />
                  {label}
                </label>
                {source === "focus" ? (
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
                    <label className="flow-page__switch">
                      <PillToggle
                        checked={draft.recentListening === true}
                        aria-label="Recent listening"
                        onChange={(event) =>
                          updateDraft((prev) => ({
                            ...prev,
                            recentListening: event.target.checked,
                          }))
                        }
                      />
                      Recent listening
                    </label>
                  </div>
                ) : (
                  <span className="flow-page__source-detail">{description}</span>
                )}
                <input
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
            );
          })}
          <div className="flow-page__source flow-page__source--total">
            <span className="flow-page__source-name">Total</span>
            <span className="flow-page__source-count">{flowDraftTotal(draft)}</span>
          </div>
        </div>
        {focusNeedsSeeds(draft) ? (
          <div className="flow-page__warning-text">{FOCUS_NEEDS_SEEDS}</div>
        ) : null}
      </div>

      <div className="flow-page__form-section">
        <div className="flow-page__schedule-row">
          <div className="flow-page__field">
            <label className="flow-page__field-label">Update hour</label>
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
          <div className="flow-page__field flow-page__field--schedule-days">
            <label className="flow-page__field-label">Update days</label>
            <div className="flow-page__weekday-grid">
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
          </div>
          <Tooltip content="Uses tracks ranked 10 to 25 instead of the top 10.">
            <label className="flow-page__switch flow-page__switch--end">
              <PillToggle
                checked={draft.deepDive === true}
                aria-label="Deep Dive"
                onChange={(event) =>
                  updateDraft((prev) => ({ ...prev, deepDive: event.target.checked }))
                }
              />
              Deep Dive
            </label>
          </Tooltip>
        </div>
      </div>

      {errorMessage ? <div className="flow-page__error-text">{errorMessage}</div> : null}
    </div>
  );
}
