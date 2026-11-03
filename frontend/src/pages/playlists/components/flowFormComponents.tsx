import { Fragment, useId } from "react";
import { SettingsGroup, SettingsNote, SettingsRow } from "../../Settings/SettingsLayout.tsx";
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
import { formatTrackTotal } from "../playlistPageUtils.ts";

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
  onDraftChange,
}: {
  draft: FlowDraft;
  onDraftChange: FlowDraftUpdater;
}) {
  const setCount = (source: FlowSource, count: number) =>
    onDraftChange((prev) => ({ ...prev, counts: { ...prev.counts, [source]: count } }));
  const toggle = (
    key: "recentListening" | "deepDive" | "autoDownload" | "recordHistory" | "showInLibrary",
    label: string,
  ) => (
    <PillToggle
      checked={draft[key] === true}
      aria-label={label}
      onChange={(event) => onDraftChange((prev) => ({ ...prev, [key]: event.target.checked }))}
    />
  );
  const scheduleDays = normalizeScheduleDays(draft.scheduleDays);
  const idPrefix = useId();
  const yearInput = (key: "yearFrom" | "yearTo", label: string) => (
    <input
      type="number"
      min="1000"
      max="9999"
      step="1"
      inputMode="numeric"
      placeholder="Any"
      aria-label={label}
      className="input"
      value={draft[key] ?? ""}
      onChange={(event) => {
        const value = event.target.value;
        onDraftChange((prev) => ({ ...prev, [key]: value }));
      }}
    />
  );

  return (
    <>
      <SettingsGroup title="Schedule">
        <SettingsRow label="Days">
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
                      onDraftChange((prev) => {
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
        </SettingsRow>
        <SettingsRow label="Time" htmlFor={`${idPrefix}-time`}>
          <Select
            id={`${idPrefix}-time`}
            value={String(draft.scheduleTime || "00:00")}
            onChange={(time) =>
              onDraftChange((prev) => ({ ...prev, scheduleTime: time || "00:00" }))
            }
            options={SCHEDULE_HOUR_OPTIONS}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Tracks"
        actions={
          <span className="settings-group__meta">{formatTrackTotal(flowDraftTotal(draft))}</span>
        }
      >
        {FLOW_SOURCES.map((source) => {
          const { label, description } = SOURCES[source];
          const countId = `${idPrefix}-${source}`;
          return (
            <Fragment key={source}>
              <SettingsRow label={label} htmlFor={countId} help={description}>
                <span className="flow-editor__count">
                  <input
                    id={countId}
                    type="number"
                    min="0"
                    max={MAX_SOURCE_TRACKS}
                    inputMode="numeric"
                    className="input"
                    value={draft.counts[source]}
                    onChange={(event) => setCount(source, toTrackCount(event.target.value))}
                  />
                </span>
              </SettingsRow>
              {source === "focus" && draft.counts.focus > 0 ? (
                <>
                  <SettingsRow label="Similar to" stack>
                    <CommaTokenInput
                      value={draft.includeRelatedArtists}
                      placeholder="Artists"
                      fetchSuggestions={fetchFlowArtistSuggestions}
                      suggestionLabel="Similar artist suggestions"
                      onChange={(includeRelatedArtists) =>
                        onDraftChange((prev) => ({ ...prev, includeRelatedArtists }))
                      }
                    />
                  </SettingsRow>
                  <SettingsRow label="Also use my recent listening">
                    {toggle("recentListening", "Also use my recent listening")}
                  </SettingsRow>
                  {focusNeedsSeeds(draft) ? (
                    <SettingsNote tone="warning">{FOCUS_NEEDS_SEEDS}</SettingsNote>
                  ) : null}
                </>
              ) : null}
            </Fragment>
          );
        })}
        <SettingsRow
          label="Deeper cuts"
          help="Tracks ranked 10 to 25 instead of each artist's top 10"
        >
          {toggle("deepDive", "Deeper cuts")}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Filters">
        <SettingsRow label="Tags" help="Start a tag with - to leave it out." stack>
          <CommaTokenInput
            value={draft.includeTags}
            placeholder="hip hop, 80s, happy"
            fetchSuggestions={fetchFlowTagSuggestions}
            suggestionLabel="Tag suggestions"
            excludable
            onChange={(includeTags) => onDraftChange((prev) => ({ ...prev, includeTags }))}
          />
        </SettingsRow>
        <SettingsRow label="Released">
          <span className="flow-editor__years">
            {yearInput("yearFrom", "Release year from")}
            to
            {yearInput("yearTo", "Release year to")}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Playlist">
        <SettingsRow label="Download automatically">
          {toggle("autoDownload", "Download automatically")}
        </SettingsRow>
        <SettingsRow label="Scrobble tracks">
          {toggle("recordHistory", "Scrobble tracks")}
        </SettingsRow>
        <SettingsRow label="Show in library">
          {toggle("showInLibrary", "Show in library")}
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
