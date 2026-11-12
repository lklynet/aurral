import { Fragment, useId, type ReactNode } from "react";
import { SettingsGroup, SettingsNote, SettingsRow } from "../../Settings/SettingsLayout.tsx";
import {
  CommaTokenInput,
  fetchFlowArtistSuggestions,
  fetchFlowTagSuggestions,
} from "./CommaTokenInput.tsx";
import PillToggle from "../../../components/PillToggle";
import Tooltip from "../../../components/Tooltip";
import TooltipButton from "../../../components/TooltipButton";
import { Select } from "../../../components/Select";
import { Minus, Plus } from "../../../components/icons";
import { FLOW_SOURCES, normalizeScheduleDays, type FlowSource } from "../../../../../lib/flows.ts";
import {
  YEAR_INPUT_ERROR,
  draftYearsInvalid,
  flowDraftTotal,
  focusNeedsSeeds,
  formatNextRefresh,
  type FlowDraft,
} from "../flowPageUtils.ts";
import { formatTrackTotal } from "../playlistPageUtils.ts";

type FlowDraftUpdater = (updater: (prev: FlowDraft) => FlowDraft) => void;

const SOURCES: Record<FlowSource, { label: string; description: string }> = {
  discover: { label: "Discover", description: "Your recommendations" },
  mix: { label: "Library", description: "Artists you own, tracks you don't" },
  trending: { label: "Trending", description: "Trending this week" },
  focus: {
    label: "Artists and tags",
    description: "From the artists below, your tags, or your recent listening",
  },
  newReleases: { label: "New releases", description: "Recent albums you're missing" },
};

const MAX_SOURCE_TRACKS = 100;
const STEP = 5;

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

const toTrackCount = (value: number) =>
  Math.min(MAX_SOURCE_TRACKS, Math.max(0, Math.round(value || 0)));

function TrackCountStepper({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (count: number) => void;
}) {
  return (
    <span className={`flow-editor__stepper${value === 0 ? " is-zero" : ""}`}>
      <TooltipButton
        className="btn btn-ghost btn-icon"
        label={`Fewer tracks`}
        aria-label={`Fewer tracks from ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(toTrackCount(Math.ceil(value / STEP) * STEP - STEP))}
      >
        <Minus aria-hidden="true" />
      </TooltipButton>
      <input
        id={id}
        type="number"
        min="0"
        max={MAX_SOURCE_TRACKS}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(toTrackCount(Number(event.target.value)))}
      />
      <TooltipButton
        className="btn btn-ghost btn-icon"
        label={`More tracks`}
        aria-label={`More tracks from ${label}`}
        disabled={value >= MAX_SOURCE_TRACKS}
        onClick={() => onChange(toTrackCount(Math.floor(value / STEP) * STEP + STEP))}
      >
        <Plus aria-hidden="true" />
      </TooltipButton>
    </span>
  );
}

export function FlowFormFields({
  draft,
  onDraftChange,
  enabled,
  enabledSwitch,
}: {
  draft: FlowDraft;
  onDraftChange: FlowDraftUpdater;
  enabled: boolean;
  enabledSwitch: ReactNode;
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
  const yearsInvalid = draftYearsInvalid(draft);
  const yearInput = (key: "yearFrom" | "yearTo", label: string) => (
    <input
      type="number"
      min="1000"
      max="9999"
      step="1"
      inputMode="numeric"
      placeholder="Any"
      aria-label={label}
      aria-invalid={yearsInvalid || undefined}
      className="input"
      value={draft[key] ?? ""}
      onChange={(event) => {
        const value = event.target.value;
        onDraftChange((prev) => ({ ...prev, [key]: value }));
      }}
    />
  );
  const tagInput = (key: "includeTags" | "excludeTags", label: string, placeholder: string) => (
    <SettingsRow label={label} stack>
      <CommaTokenInput
        value={draft[key]}
        placeholder={placeholder}
        fetchSuggestions={fetchFlowTagSuggestions}
        suggestionLabel="Tag suggestions"
        onChange={(value) => onDraftChange((prev) => ({ ...prev, [key]: value }))}
      />
    </SettingsRow>
  );

  return (
    <>
      <SettingsGroup
        title="Mix"
        actions={
          <span className="settings-group__meta">{formatTrackTotal(flowDraftTotal(draft))}</span>
        }
      >
        {FLOW_SOURCES.map((source) => {
          const { label, description } = SOURCES[source];
          const countId = `${idPrefix}-${source}`;
          const count = draft.counts[source];
          return (
            <Fragment key={source}>
              <SettingsRow
                label={
                  <span className={count === 0 ? "flow-editor__off" : undefined}>{label}</span>
                }
                htmlFor={countId}
                help={description}
              >
                <TrackCountStepper
                  id={countId}
                  label={label}
                  value={count}
                  onChange={(next) => setCount(source, next)}
                />
              </SettingsRow>
              {source === "focus" && count > 0 ? (
                <div className="flow-editor__nested">
                  <SettingsRow label="Similar to" stack>
                    <CommaTokenInput
                      value={draft.includeRelatedArtists}
                      placeholder="Add an artist"
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
                    <SettingsNote tone="warning">
                      Add an artist, turn on recent listening, or add a tag under Filters. Until
                      then this flow can&apos;t save.
                    </SettingsNote>
                  ) : null}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        <SettingsRow
          label="Deeper cuts"
          help="Prefers less popular tracks from Discover, Library, and Artists and tags"
        >
          {toggle("deepDive", "Deeper cuts")}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Schedule"
        actions={
          enabled ? (
            <span className="settings-group__meta">
              {formatNextRefresh(draft.scheduleDays, draft.scheduleTime)}
            </span>
          ) : null
        }
      >
        <SettingsRow label="Days">
          <div className="flow-page__weekday-grid" role="group" aria-label="Refresh days">
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

      <SettingsGroup title="Filters">
        {tagInput("includeTags", "Only these tags", "Any tag, like hip hop or 80s")}
        {tagInput("excludeTags", "Skip these tags", "Add a tag")}
        <SettingsRow
          label="Released"
          help={yearsInvalid ? YEAR_INPUT_ERROR : undefined}
          tone={yearsInvalid ? "error" : "default"}
        >
          <span className="flow-editor__years">
            {yearInput("yearFrom", "Released from")}
            to
            {yearInput("yearTo", "Released to")}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Playlist">
        <SettingsRow label="Flow on" help="Turning it off removes its tracks and stops refreshes">
          {enabledSwitch}
        </SettingsRow>
        <SettingsRow
          label="Download automatically"
          help="Off saves new tracks to the flow without downloading them"
        >
          {toggle("autoDownload", "Download automatically")}
        </SettingsRow>
        <SettingsRow label="Scrobble plays">
          {toggle("recordHistory", "Scrobble plays")}
        </SettingsRow>
        <SettingsRow label="Show in Library" help="List it with your playlists">
          {toggle("showInLibrary", "Show in Library")}
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
