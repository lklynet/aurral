import {
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  Loader2,
  Check,
  Clock,
  Trash2,
  Pencil,
  FilePlus2,
  ListMusic,
  Sparkles,
  Download,
  Upload,
  Play,
  Pause,
  Shuffle,
  Plus,
  Search,
  ChevronDown,
  MoreHorizontal,
  Save,
  X,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import {
  getFlowTrackDisplayNumber,
  sortFlowTracks,
} from "../utils/flowTrackSort";
import { Link } from "react-router-dom";
import PillToggle from "../components/PillToggle";
import FlipSaveButton from "../components/FlipSaveButton";
import { useAudioQueue } from "../hooks/useAudioQueue";
import { normalizeFlowTrack } from "../utils/audioQueue";
import {
  TrackPlaylistMenu,
  TrackPlaylistSubmenu,
} from "./ArtistDetails/components/TrackPlaylistMenu";
import { TAG_COLORS } from "./ArtistDetails/constants";
import { getTagColor } from "./ArtistDetails/utils";

const SOURCE_MIX_COLORS = {
  discover: TAG_COLORS[10],
  mix: TAG_COLORS[4],
  trending: TAG_COLORS[12],
  focus: TAG_COLORS[2],
};

const SOURCE_MIX_OPTIONS = [
  { key: "discover", label: "Discover" },
  { key: "mix", label: "Library" },
  { key: "trending", label: "Trending" },
  { key: "focus", label: "Focus" },
];

const WEEKDAY_OPTIONS = [
  { id: 0, short: "Su", full: "Sunday" },
  { id: 1, short: "M", full: "Monday" },
  { id: 2, short: "T", full: "Tuesday" },
  { id: 3, short: "W", full: "Wednesday" },
  { id: 4, short: "Th", full: "Thursday" },
  { id: 5, short: "F", full: "Friday" },
  { id: 6, short: "S", full: "Saturday" },
];

const FLOW_WORKER_CONCURRENCY_OPTIONS = [1, 2, 3];
const FLOW_WORKER_EXISTING_FILE_OPTIONS = [
  { id: "download", label: "Download" },
  { id: "reuse", label: "Reuse existing files" },
];
const FLOW_WORKER_RETRY_CYCLE_OPTIONS = [
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1440, label: "1 day" },
];
const SCHEDULE_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => {
  const normalized = `${String(hour).padStart(2, "0")}:00`;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return {
    value: normalized,
    label: `${hour12}:00 ${suffix}`,
  };
});

const getEnabledSourceKeys = (mix) =>
  SOURCE_MIX_OPTIONS.map((option) => option.key).filter(
    (key) => Number(mix?.[key] || 0) > 0
  );

const distributeEvenly = (keys, total = 100) => {
  if (!Array.isArray(keys) || keys.length === 0) return {};
  const base = Math.floor(total / keys.length);
  let remainder = total - base * keys.length;
  return keys.reduce((acc, key) => {
    acc[key] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return acc;
  }, {});
};

const toggleSourceInMix = (mix, key, normalizeMixPercent) => {
  const normalized = normalizeMixPercent(mix);
  const activeKeys = getEnabledSourceKeys(normalized);
  const isActive = normalized[key] > 0;
  if (isActive) {
    if (activeKeys.length <= 1) {
      return normalized;
    }
    const next = { ...normalized, [key]: 0 };
    const remainingKeys = activeKeys.filter((entry) => entry !== key);
    const remainingTotal = remainingKeys.reduce(
      (sum, entry) => sum + Number(next[entry] || 0),
      0
    );
    if (remainingTotal <= 0) {
      return normalizeMixPercent(distributeEvenly(remainingKeys));
    }
    return normalizeMixPercent(next);
  }

  const nextKeys = [...activeKeys, key];
  if (activeKeys.length === 0) {
    return normalizeMixPercent(distributeEvenly(nextKeys));
  }
  const nextValue = Math.round(100 / nextKeys.length);
  const scale = (100 - nextValue) / 100;
  const next = { discover: 0, mix: 0, trending: 0, focus: 0, [key]: nextValue };
  for (const activeKey of activeKeys) {
    next[activeKey] = Math.max(1, normalized[activeKey] * scale);
  }
  return normalizeMixPercent(next);
};

export function MixSlider({
  mix,
  onChange,
  normalizeMixPercent,
  trackCounts = {},
  trailingControl = null,
  disabledSources = {},
}) {
  const normalized = normalizeMixPercent(mix);
  const activeKeys = getEnabledSourceKeys(normalized);
  const barRef = useRef(null);
  const dragRef = useRef(null);

  const updateFromClientX = useCallback(
    (clientX, handleIndex) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clampedX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      const percent = rect.width > 0 ? (clampedX / rect.width) * 100 : 0;
      if (activeKeys.length < 2) return;
      const leftKey = activeKeys[handleIndex];
      const rightKey = activeKeys[handleIndex + 1];
      if (!leftKey || !rightKey) return;
      const prefixStart = activeKeys
        .slice(0, handleIndex)
        .reduce((sum, key) => sum + Number(normalized[key] || 0), 0);
      const pairTotal =
        Number(normalized[leftKey] || 0) + Number(normalized[rightKey] || 0);
      const nextLeft = Math.min(
        Math.max(percent - prefixStart, 0),
        pairTotal,
      );
      const next = {
        discover: normalized.discover,
        mix: normalized.mix,
        trending: normalized.trending,
        focus: normalized.focus,
      };
      next[leftKey] = nextLeft;
      next[rightKey] = Math.max(0, pairTotal - nextLeft);
      onChange(normalizeMixPercent(next));
    },
    [activeKeys, normalized, onChange, normalizeMixPercent]
  );

  const startDrag = (event, handle) => {
    event.preventDefault();
    dragRef.current = { handle };
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    updateFromClientX(event.clientX, handle);
  };

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current) return;
      updateFromClientX(event.clientX, dragRef.current.handle);
    };
    const handleUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [updateFromClientX]);

  const labelMinPercent = 6;
  const cumulativePositions = [];
  let runningPosition = 0;
  for (const key of activeKeys) {
    runningPosition += Number(normalized[key] || 0);
    cumulativePositions.push(runningPosition);
  }
  const handles = cumulativePositions
    .slice(0, -1)
    .map((position, index) => ({
      key: `boundary-${index}`,
      position: Math.min(Math.max(position, 1.5), 98.5),
      handleIndex: index,
      ariaLabel: `Adjust ${SOURCE_MIX_OPTIONS.find((option) => option.key === activeKeys[index])?.label || "source"} and ${SOURCE_MIX_OPTIONS.find((option) => option.key === activeKeys[index + 1])?.label || "source"} mix`,
    }));

  return (
    <div className="flow-page__mix">
      <div className="flow-page__mix-header">
        <div className="flow-page__mix-toggles">
          {SOURCE_MIX_OPTIONS.map((option) => {
            const isActive = normalized[option.key] > 0;
            const isOnlyActive = isActive && activeKeys.length === 1;
            const disabledReason = disabledSources?.[option.key];
            const isDisabled = Boolean(disabledReason) || isOnlyActive;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() =>
                  !disabledReason &&
                  onChange(toggleSourceInMix(normalized, option.key, normalizeMixPercent))
                }
                disabled={isDisabled}
                className={`flow-page__mix-toggle${isActive ? " is-active" : ""}${isDisabled ? " is-disabled" : ""}`}
                style={
                  isActive
                    ? { backgroundColor: SOURCE_MIX_COLORS[option.key] }
                    : undefined
                }
                aria-pressed={isActive}
                title={disabledReason || undefined}
              >
                <span>{option.label}</span>
                <span className="flow-page__mix-toggle-state">
                  {disabledReason ? "Needs Last.fm" : isActive ? "On" : "Off"}
                </span>
              </button>
            );
          })}
        </div>
        {trailingControl ? (
          <div className="flow-page__mix-trailing">{trailingControl}</div>
        ) : null}
      </div>
      <div
        ref={barRef}
        className="flow-page__mix-bar"
        style={{ touchAction: handles.length > 0 ? "none" : "auto" }}
      >
        <div className="flow-page__mix-bar-inner">
          {activeKeys.map((key) => {
            const percent = Number(normalized[key] || 0);
            if (percent <= 0) return null;
            const option =
              SOURCE_MIX_OPTIONS.find((entry) => entry.key === key) ||
              { key, label: key };
            const showLabel = percent >= labelMinPercent;
            return (
              <div
                key={key}
                className={`flow-page__mix-segment flow-page__mix-segment--${key}`}
                style={{
                  width: `${percent}%`,
                  backgroundColor: SOURCE_MIX_COLORS[key],
                }}
              >
                {showLabel
                  ? `${option.label} (${trackCounts[key] ?? 0})`
                  : ""}
              </div>
            );
          })}
        </div>
        {handles.map((handle) => (
          <button
            key={handle.key}
            type="button"
            onPointerDown={(event) => startDrag(event, handle.handleIndex)}
            className="flow-page__mix-handle"
            style={{ left: `${handle.position}%` }}
            aria-label={handle.ariaLabel}
          >
            <span className="flow-page__mix-handle-thumb" />
          </button>
        ))}
      </div>
    </div>
  );
}

function getCommaTokenInputState(value, options = {}) {
  const raw = String(value ?? "");
  const endsWithComma = raw.endsWith(",");
  const commitAll = options?.commitAll === true;
  const parts = raw.split(",");
  const dedupeCommitted = (entries) => {
    const seen = new Set();
    return entries
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => {
        const key = entry.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
  const committedParts = dedupeCommitted(parts.slice(0, -1));
  if (endsWithComma || commitAll) {
    return {
      committed: dedupeCommitted(parts),
      pending: "",
    };
  }
  const pending = String(parts[parts.length - 1] ?? "").replace(/^\s+/, "");
  return {
    committed: committedParts,
    pending,
  };
}

function buildCommaTokenInputValue(committed, pending) {
  const seen = new Set();
  const safeCommitted = committed
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const rawPending = String(pending ?? "").replace(/^\s+/, "");
  const normalizedPending = rawPending.trim();
  if (safeCommitted.length === 0) return rawPending.replace(/^\s+/, "");
  if (!normalizedPending) return `${safeCommitted.join(", ")}, `;
  return `${safeCommitted.join(", ")}, ${rawPending}`;
}

function getFocusDraftValidation(draft, normalizeMixPercent) {
  const normalizedMix = normalizeMixPercent(draft?.mix);
  const focusEnabled = Number(normalizedMix.focus || 0) > 0;
  const hasFocusFilters =
    getCommaTokenInputState(draft?.includeTags, { commitAll: true }).committed.length > 0 ||
    getCommaTokenInputState(draft?.includeRelatedArtists, { commitAll: true }).committed.length > 0;
  return {
    focusEnabled,
    hasFocusFilters,
    focusValidationError:
      focusEnabled && !hasFocusFilters
        ? "Focus needs at least one genre tag or related artist."
        : "",
  };
}

function CommaTokenInput({
  value,
  placeholder,
  onChange,
}) {
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef(null);
  const { committed, pending } = getCommaTokenInputState(value, {
    commitAll: !isFocused,
  });
  const rawValue = String(value ?? "");

  const commitNormalizedValue = useCallback(() => {
    const nextCommitted = getCommaTokenInputState(rawValue, {
      commitAll: true,
    }).committed;
    onChange(buildCommaTokenInputValue(nextCommitted, ""));
  }, [onChange, rawValue]);

  useEffect(() => {
    if (!isFocused) return;
    inputRef.current?.focus();
  }, [isFocused]);

  return (
    <div
      className="flow-page__token-input"
      onClick={() => setIsFocused(true)}
    >
      {isFocused ? (
        <input
          ref={inputRef}
          type="text"
          className="flow-page__token-input-field"
          placeholder={placeholder}
          value={rawValue}
          onFocus={() => setIsFocused(true)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitNormalizedValue();
              inputRef.current?.blur();
            }
          }}
          onBlur={() => {
            setIsFocused(false);
            commitNormalizedValue();
          }}
        />
      ) : (
        <div className="flow-page__token-input-chips">
          {committed.map((entry) => (
            <span
              key={`${placeholder}-${entry}`}
              className="flow-page__token-chip"
              style={{ backgroundColor: getTagColor(entry) }}
            >
              {entry}
            </span>
          ))}
          {committed.length === 0 ? (
            <span className="flow-page__token-placeholder">{placeholder}</span>
          ) : null}
          {pending ? (
            <span className="flow-page__token-pending">{pending}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

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
    ? [...new Set(draft.scheduleDays.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6))].sort(
        (a, b) => a - b
      )
    : [];
  const scheduleTime = String(draft?.scheduleTime || "00:00");

  return (
    <div className="flow-page__form-section">
      <div className="flow-page__schedule-row">
        <div className="flow-page__field">
          <label className="flow-page__field-label">
            {sizeLabel}
          </label>
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
          <label className="flow-page__field-label">
            Update hour
          </label>
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
          <label className="flow-page__field-label">
            Update days
          </label>
          <div className="flow-page__weekday-grid">
            {WEEKDAY_OPTIONS.map((day) => {
              const checked = scheduleDays.includes(day.id);
              return (
                <label
                  key={day.id}
                  className={`flow-page__weekday${checked ? " is-active" : ""}`}
                  title={day.full}
                >
                  <input
                    type="checkbox"
                    className="flow-page__weekday-input"
                    checked={checked}
                    disabled={checked && scheduleDays.length === 1}
                    onChange={() =>
                      updateDraft((prev) => {
                        const current = Array.isArray(prev?.scheduleDays)
                          ? prev.scheduleDays
                          : [];
                        const normalized = [...new Set(current
                          .map((entry) => Number(entry))
                          .filter((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6))];
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
                  />
                  <span>{day.short}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReleaseRadarRecipeFields({
  draft,
  inputClassName = "flow-page__field-control",
  errorMessage,
  onDraftChange,
  onClearError,
}) {
  return (
    <div className="flow-page__form">
      <div className="flow-page__preset-recipe">
        <p className="flow-page__preset-recipe-label">New releases</p>
        <p className="flow-page__preset-recipe-desc">
          Finds recent albums from artists in your library that you do not have
          yet, then picks a standout track from each release. The track limit is
          a maximum; if fewer albums qualify, the playlist will be shorter. It
          refreshes on your schedule below.
        </p>
      </div>
      <FlowScheduleFields
        draft={draft}
        inputClassName={inputClassName}
        onDraftChange={onDraftChange}
        onClearError={onClearError}
        sizeLabel="Max tracks"
      />
      {errorMessage ? (
        <div className="flow-page__error-text">{errorMessage}</div>
      ) : null}
    </div>
  );
}

export function FlowFormFields({
  draft,
  remaining,
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
  const totalSize = Number.isFinite(Number(remaining)) && Number(remaining) > 0 ? Math.round(Number(remaining)) : 0;
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
        <div className="flow-page__field-label flow-page__field-label--section">
          Source mix
        </div>

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

      <div className={`flow-page__form-section${focusEnabled ? "" : " flow-page__form-section--dimmed"}`}>
        <div className="flow-page__field">
          <div className="flow-page__field-label flow-page__field-label--section">
            Focus filters
          </div>
          {focusValidationError ? (
            <div className="flow-page__warning-text">
              {focusValidationError}
            </div>
          ) : null}
        </div>

        <div className="flow-page__form-grid">
          <div className="flow-page__field">
            <label className="flow-page__field-label">
              Genre tags (separate by comma)
            </label>
            <CommaTokenInput
              value={draft.includeTags}
              placeholder="lofi, indie"
              onChange={(nextValue) =>
                updateDraft((prev) => ({
                  ...prev,
                  includeTags: nextValue,
                }))
              }
            />
          </div>

          <div className="flow-page__field">
            <label className="flow-page__field-label">
              Related artists (separate by comma)
            </label>
            <CommaTokenInput
              value={draft.includeRelatedArtists}
              placeholder="artist a, artist b"
              onChange={(nextValue) =>
                updateDraft((prev) => ({
                  ...prev,
                  includeRelatedArtists: nextValue,
                }))
              }
            />
          </div>
        </div>
      </div>
      
      {errorMessage && <div className="flow-page__error-text">{errorMessage}</div>}
    </div>
  );
}

export function FlowPageHeader({ onNewFlow }) {
  return (
    <div className="flow-page__page-header">
      <div className="flow-page__page-header-row">
        <h1 className="flow-page__page-title">Playlists</h1>
      </div>
      <div className="flow-page__header-actions">
        <button
          onClick={onNewFlow}
          className="btn btn-primary btn-sm"
        >
          <FilePlus2 className="artist-icon-sm" />
          New Flow
        </button>
      </div>
    </div>
  );
}

export function FlowStatusCards({
  status,
  enabledCount,
  flowCount,
  runningCount,
  completedCount,
}) {
  const queuePending = Number(status?.operationQueue?.pending || 0);
  const queueProcessing = status?.operationQueue?.processing === true;
  const idleCount = Math.max(flowCount - runningCount - completedCount, 0);
  const workerRunning = status?.worker?.running === true;
  const pending = Number(status?.stats?.pending || 0);
  const downloading = Number(status?.stats?.downloading || 0);
  const done = Number(status?.stats?.done || 0);
  const total = pending + downloading + done;
  const processed = done;
  const progressPct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const hintMessage = String(status?.hint?.message || "").trim();
  const baseSummaryMessage =
    runningCount > 0
      ? `Processing ${runningCount} ${runningCount === 1 ? "playlist" : "playlists"} (${pending} pending, ${done} completed)`
      : done > 0
        ? `No active processing (${done} completed)`
        : "No active processing";
  const hasCurrentJob =
    status?.worker?.currentJob?.artistName && status?.worker?.currentJob?.trackName;
  const hintLower = hintMessage.toLowerCase();
  const hintIsDownloadLike =
    hintLower.includes("download") || hintLower.includes("downloading");
  const shouldShowHint =
    hintMessage.length > 0 && !(hasCurrentJob && hintIsDownloadLike);
  const summaryMessage = hasCurrentJob
    ? "Downloading tracks"
    : shouldShowHint
      ? hintMessage
      : baseSummaryMessage;
  const hasPreparationSignal = queuePending > 0 || queueProcessing || (shouldShowHint && !workerRunning);
  const statusLabel = workerRunning
    ? "Running"
    : hasPreparationSignal
        ? "Preparing"
        : "Stopped";
  const statusBadgeClass =
    statusLabel === "Running"
      ? "badge-success"
      : statusLabel === "Preparing"
        ? "badge-secondary"
        : "badge-neutral";

  return (
    <div className="flow-page__worker-card">
      <div className="flow-page__worker-card-header">
        <h2 className="flow-page__worker-card-title">Worker Overview</h2>
        <span className={`badge ${statusBadgeClass}`}>
          {statusLabel}
        </span>
      </div>
      <div className="flow-page__worker-summary">
        {workerRunning ? (
          <Loader2 className="flow-page__worker-summary-icon animate-spin" />
        ) : (
          <Clock className="flow-page__worker-summary-icon flow-page__worker-summary-icon--idle" />
        )}
        <span>{summaryMessage}</span>
      </div>
      {total > 0 ? (
        <div className="flow-page__progress">
          <div className="flow-page__progress-bar">
            <div
              className="flow-page__progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="flow-page__worker-stats">
        <div className="flow-page__worker-stats-row">
          <div className="flow-page__worker-stats-group">
            <span className="flow-page__worker-stats-label">
              Flows
            </span>
            <span>On <span className="flow-page__worker-stats-value">{enabledCount}/{flowCount}</span></span>
            <span className="flow-page__card-meta-dot">•</span>
            <span>Running <span className="flow-page__worker-stats-value">{runningCount}</span></span>
            <span className="flow-page__card-meta-dot">•</span>
            <span>Completed <span className="flow-page__worker-stats-value">{completedCount}</span></span>
            <span className="flow-page__card-meta-dot">•</span>
            <span>Idle <span className="flow-page__worker-stats-value">{idleCount}</span></span>
          </div>
          <div className="flow-page__worker-stats-divider" />
          <div className="flow-page__worker-stats-group">
            <span className="flow-page__worker-stats-label">
              Tracks
            </span>
            <span>Pending <span className="flow-page__worker-stats-value">{pending}</span></span>
            <span className="flow-page__card-meta-dot">•</span>
            <span>Downloading <span className="flow-page__worker-stats-value">{downloading}</span></span>
            <span className="flow-page__card-meta-dot">•</span>
            <span>Done <span className="flow-page__worker-stats-value">{done}</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FlowTrackPlaylistMenus({
  track,
  useTrackContextMenu,
  playlists,
  playlistsLoading,
  playlistSavingKey,
  playlistMenuError,
  excludedPlaylistIds,
  getDefaultPlaylistName,
  onLoadPlaylists,
  onAddTrackToPlaylist,
  onMoveTrackToPlaylist,
  children,
}) {
  const canUsePlaylistMenus =
    track?.artistName &&
    track?.trackName &&
    (onAddTrackToPlaylist || onMoveTrackToPlaylist);
  const saving = playlistSavingKey === String(track?.id || "");
  const defaultNewPlaylistName =
    getDefaultPlaylistName?.(track) || "Playlist";
  const sharedMenuProps = {
    track,
    playlists,
    loading: playlistsLoading,
    saving,
    error: playlistMenuError,
    defaultNewPlaylistName,
    excludedPlaylistIds,
    onLoadPlaylists,
  };

  if (!canUsePlaylistMenus) {
    return typeof children === "function" ? children() : children;
  }

  if (useTrackContextMenu) {
    return children({
      playlistMenuProps: {
        ...sharedMenuProps,
        onAddTrackToPlaylist: onAddTrackToPlaylist
          ? (target) => onAddTrackToPlaylist(track, target)
          : null,
        onMoveTrackToPlaylist: onMoveTrackToPlaylist
          ? (target) => onMoveTrackToPlaylist(track, target)
          : null,
      },
    });
  }

  return (
    <>
      {onAddTrackToPlaylist ? (
        <TrackPlaylistMenu
          {...sharedMenuProps}
          triggerVariant="compact"
          onSelect={(target) => onAddTrackToPlaylist(track, target)}
        />
      ) : null}
      {typeof children === "function" ? children() : children}
    </>
  );
}

function FlowTrackKebabMenu({
  track,
  canReSearch,
  isReSearching,
  canDelete,
  isDeleting,
  onReSearch,
  onDelete,
  playlistMenuProps = null,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState(null);
  const [menuPosition, setMenuPosition] = useState(null);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const onLoadPlaylistsRef = useRef(playlistMenuProps?.onLoadPlaylists);
  onLoadPlaylistsRef.current = playlistMenuProps?.onLoadPlaylists;

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
        setOpenSubmenu(null);
        setMenuPosition(null);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    onLoadPlaylistsRef.current?.();
  }, [isOpen]);

  const close = () => {
    setIsOpen(false);
    setOpenSubmenu(null);
    setMenuPosition(null);
  };
  const trackLabel = track?.trackName || "track";
  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = 216;
      const viewportPadding = 12;
      setMenuPosition({
        top: rect.bottom + 8,
        left: Math.min(
          Math.max(viewportPadding, rect.right - menuWidth),
          window.innerWidth - menuWidth - viewportPadding,
        ),
      });
    }
    setIsOpen(true);
  };

  return (
    <div
      className={`flow-page__track-menu${isOpen ? " is-open" : ""}`}
      ref={menuRef}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (isOpen) {
            close();
            return;
          }
          openMenu();
        }}
        className="btn btn-secondary btn-icon btn-xs flow-page__track-menu-trigger"
        aria-label={`Options for ${trackLabel}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreHorizontal className="artist-icon-xs" />
      </button>
      {isOpen ? (
        <>
          <button
            type="button"
            className="artist-backdrop-button"
            onClick={close}
            aria-label="Close track menu"
          />
          <div
            className="artist-floating-menu flow-page__track-menu-dropdown"
            style={{
              top: menuPosition?.top ?? 0,
              left: menuPosition?.left ?? 0,
            }}
            role="menu"
          >
            {canReSearch ? (
              <button
                type="button"
                role="menuitem"
                className="artist-menu-item"
                disabled={isReSearching}
                onClick={() => {
                  onReSearch?.(track);
                  close();
                }}
              >
                <span className="artist-menu-item__main">
                  {isReSearching ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <Search className="artist-icon-sm" />
                  )}
                  Re-search
                </span>
              </button>
            ) : null}
            {playlistMenuProps?.onAddTrackToPlaylist ? (
              <TrackPlaylistSubmenu
                label="Add to playlist"
                icon={Plus}
                track={playlistMenuProps.track}
                playlists={playlistMenuProps.playlists}
                loading={playlistMenuProps.loading}
                saving={playlistMenuProps.saving}
                error={playlistMenuProps.error}
                defaultNewPlaylistName={playlistMenuProps.defaultNewPlaylistName}
                excludedPlaylistIds={playlistMenuProps.excludedPlaylistIds}
                onSelect={playlistMenuProps.onAddTrackToPlaylist}
                onClose={close}
                toggleOnClick
                isOpen={openSubmenu === "add"}
                onToggle={() =>
                  setOpenSubmenu((current) =>
                    current === "add" ? null : "add",
                  )
                }
              />
            ) : null}
            {playlistMenuProps?.onMoveTrackToPlaylist ? (
              <TrackPlaylistSubmenu
                label="Move to playlist"
                icon={ListMusic}
                track={playlistMenuProps.track}
                playlists={playlistMenuProps.playlists}
                loading={playlistMenuProps.loading}
                saving={playlistMenuProps.saving}
                error={playlistMenuProps.error}
                defaultNewPlaylistName={playlistMenuProps.defaultNewPlaylistName}
                excludedPlaylistIds={playlistMenuProps.excludedPlaylistIds}
                onSelect={playlistMenuProps.onMoveTrackToPlaylist}
                onClose={close}
                toggleOnClick
                isOpen={openSubmenu === "move"}
                onToggle={() =>
                  setOpenSubmenu((current) =>
                    current === "move" ? null : "move",
                  )
                }
              />
            ) : null}
            {canDelete ? (
              <button
                type="button"
                role="menuitem"
                className="artist-menu-item artist-menu-item--danger"
                disabled={isDeleting}
                onClick={() => {
                  onDelete?.(track);
                  close();
                }}
              >
                <span className="artist-menu-item__main">
                  {isDeleting ? (
                    <Loader2 className="artist-icon-sm animate-spin" />
                  ) : (
                    <Trash2 className="artist-icon-sm" />
                  )}
                  Remove from playlist
                </span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function MoreMenu({ children, activeButtonClass = "btn-primary" }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div className={`flow-page__menu-wrap${isOpen ? " is-open" : ""}`} ref={menuRef}>
      <button 
        type="button" 
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }} 
        className={`btn btn-sm btn--toolbar ${isOpen ? activeButtonClass : "btn-secondary"}`}
        aria-label="More options"
      >
        <MoreHorizontal className="artist-icon-sm" />
        <span className="flow-page__btn-label--wide">More</span>
      </button>
      {isOpen && (
        <>
          <button
            type="button"
            className="artist-backdrop-button"
            onClick={() => setIsOpen(false)}
            aria-label="Close menu"
          />
          <div
            className="artist-dropdown artist-dropdown--right"
            onClick={() => setIsOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function getTrackStatusMeta(status) {
  switch (String(status || "").toLowerCase()) {
    case "done":
      return { label: "Downloaded", className: "flow-page__track-status-dot--done" };
    case "downloading":
      return {
        label: "Downloading",
        className: "flow-page__track-status-dot--downloading",
      };
    case "failed":
      return { label: "Failed", className: "flow-page__track-status-dot--failed" };
    case "pending":
    default:
      return { label: "Queued", className: "flow-page__track-status-dot--pending" };
  }
}

function TrackStatusDot({ status }) {
  const meta = getTrackStatusMeta(status);
  const normalized = String(status || "").toLowerCase();
  const isLinkable = normalized !== "done";
  if (isLinkable) {
    return (
      <Link
        to="/downloads"
        className={`flow-page__track-status-dot flow-page__track-status-dot--link ${meta.className}`}
        title={`${meta.label} — view activity`}
        aria-label={`${meta.label}, view activity`}
      />
    );
  }
  return (
    <span
      className={`flow-page__track-status-dot ${meta.className}`}
      title={meta.label}
      aria-label={meta.label}
      role="img"
    />
  );
}

export function PlaylistArtworkThumb({
  artworkUrl,
  name,
  className = "",
  onClick,
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [artworkUrl]);

  const fallbackLabel = String(name || "?").trim().charAt(0).toUpperCase() || "?";
  const classes = `flow-page__artwork${onClick ? " flow-page__artwork--interactive" : ""}${className ? ` ${className}` : ""}`;
  const content =
    !imageFailed && artworkUrl ? (
      <img
        src={artworkUrl}
        alt={`${name} cover`}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    ) : (
      <div className="flow-page__artwork-fallback">{fallbackLabel}</div>
    );

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onClick}
        aria-label={`Edit ${name} cover`}
      >
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}

const MOBILE_CARD_MEDIA_QUERY = "(max-width: 639px)";

const shouldHandleMobileCardTap = (event) => {
  if (
    typeof window === "undefined" ||
    !window.matchMedia(MOBILE_CARD_MEDIA_QUERY).matches
  ) {
    return false;
  }
  const interactiveTarget = event.target?.closest(
    'button, a, input, textarea, select, label, [role="button"], [data-no-card-toggle="true"]',
  );
  return !interactiveTarget;
};

const formatFlowLastRun = (lastRunAt) => {
  const timestamp =
    typeof lastRunAt === "number" ? lastRunAt : Number.parseInt(lastRunAt, 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

export function FlowCard({
  flow,
  isAdminView = false,
  artworkUrl,
  enabled,
  state,
  stats,
  currentJob,
  statusHint,
  operationQueue,
  nextRun,
  isEditing,
  isNameEditing,
  isNameDirty,
  isNameApplying,
  isTracksOpen,
  tracks,
  tracksLoading,
  tracksError,
  simpleDraft,
  simpleRemaining,
  simpleError,
  isApplying,
  hasChanges,
  canExport,
  canConvertToStatic,
  convertingId,
  togglingId,
  rerunningId,
  deletingId,
  onRunNow,
  onExport,
  onConvertToStatic,
  onToggleNameEditing,
  onToggleEditing,
  onToggleEnabled,
  onDelete,
  onViewTracks,
  onAddTrackToPlaylist,
  onNavigateArtist,
  onNameCancel,
  onNameApply,
  onCancel,
  onApply,
  onDraftChange,
  onClearError,
  normalizeMixPercent,
  disabledSources = {},
}) {
  const { focusValidationError } = getFocusDraftValidation(
    simpleDraft,
    normalizeMixPercent,
  );
  const sourceValidationError = SOURCE_MIX_OPTIONS.find(
    (option) =>
      Number(normalizeMixPercent(simpleDraft?.mix)?.[option.key] || 0) > 0 &&
      disabledSources?.[option.key],
  )?.key;
  const saveDisabled =
    !hasChanges || Boolean(focusValidationError) || Boolean(sourceValidationError);
  const showSavedState = !hasChanges;
  const processed = Number(stats?.done || 0);
  const total = Number(stats?.total || 0);
  const processedDisplay = total > 0 ? Math.min(processed, total) : processed;
  const progressPct = total > 0 ? Math.min(100, Math.round((processedDisplay / total) * 100)) : 0;
  const isCurrentJobForFlow =
    currentJob?.playlistType === flow.id &&
    currentJob?.artistName &&
    currentJob?.trackName;
  const jobProgressPct = Math.max(
    0,
    Math.min(100, Math.round(Number(currentJob?.progressPct || 0))),
  );
  const hintPhase = String(statusHint?.phase || "").trim();
  const hintMessage = String(statusHint?.message || "").trim();
  const queueProcessing = operationQueue?.processing === true;
  const queueLabel = String(operationQueue?.currentLabel || "").trim();
  const queueAction = queueLabel.includes(":")
    ? queueLabel.slice(0, queueLabel.indexOf(":"))
    : queueLabel;
  const queueFlowId = queueLabel.includes(":")
    ? queueLabel.slice(queueLabel.indexOf(":") + 1)
    : "";
  const queueTargetsThisFlow = queueFlowId === flow.id;
  const isGeneratingThisFlow =
    enabled &&
    queueProcessing &&
    (queueAction === "enable" || queueAction === "scheduled") &&
    queueTargetsThisFlow;
  const isQueueCleanupThisFlow =
    enabled &&
    queueProcessing &&
    (queueAction === "disable" || queueAction === "delete" || queueAction === "reset") &&
    queueTargetsThisFlow;
  const pendingCount = Number(stats?.pending || 0);
  const downloadingCount = Number(stats?.downloading || 0);
  const isQueued =
    enabled &&
    pendingCount > 0 &&
    !isCurrentJobForFlow &&
    hintPhase === "downloading";
  const hasFlowWorkInProgress =
    pendingCount > 0 ||
    downloadingCount > 0 ||
    isCurrentJobForFlow ||
    isGeneratingThisFlow ||
    isQueueCleanupThisFlow;
  const isRerunningThisFlow = rerunningId === flow.id;
  const canRunNow = enabled && !hasFlowWorkInProgress && !isRerunningThisFlow;
  let flowWorkerMessage = "";
  if (isCurrentJobForFlow) {
    flowWorkerMessage = `Download: ${currentJob.trackName} (${jobProgressPct}%)`;
  } else if (isGeneratingThisFlow) {
    flowWorkerMessage = "Generating playlist";
  } else if (isQueueCleanupThisFlow) {
    flowWorkerMessage = "Cleaning flow files";
  } else if (isQueued) {
    flowWorkerMessage = "Queued";
  } else if (enabled && queueProcessing && pendingCount > 0) {
    flowWorkerMessage = "Queued";
  } else if (enabled && hintPhase === "queued" && pendingCount > 0) {
    flowWorkerMessage = "Tracks queued and waiting";
  } else if (
    enabled &&
    hintMessage &&
    (!queueProcessing || queueTargetsThisFlow) &&
    (hintPhase !== "queued" || hasFlowWorkInProgress) &&
    hintPhase !== "downloading" &&
    hintPhase !== "completed"
  ) {
    flowWorkerMessage = hintMessage;
  }
  const metaItems = [];
  const lastRun = formatFlowLastRun(flow?.lastRunAt);
  if (lastRun) {
    metaItems.push(`Last run ${lastRun}`);
  }
  if (enabled && nextRun && state !== "running" && !isGeneratingThisFlow) {
    metaItems.push(
      nextRun === "soon" ? "Next update soon" : `Next update in ${nextRun}`,
    );
  }
  const typeLabel = enabled ? "Flow" : "Flow draft";
  const statusSummary = enabled ? "" : "Flow ready when enabled";
  const ownerLabel = isAdminView && flow?.ownerUsername
    ? `Owner: ${flow.ownerUsername}`
    : null;

  const handleMobileTrackToggle = (event) => {
    if (!shouldHandleMobileCardTap(event)) return;
    onViewTracks?.();
  };

  return (
    <div className="flow-page__card">
      <div className="flow-page__card-body">
        <div
          className="flow-page__card-main"
          onClick={handleMobileTrackToggle}
        >
          <div className={enabled ? "" : "flow-page__card--dimmed"}>
            <PlaylistArtworkThumb artworkUrl={artworkUrl} name={flow.name} />
          </div>
          <div className="flow-page__card-content">
            <div className="flow-page__card-top">
              <div className={enabled ? "" : "flow-page__card--dimmed"}>
                <div className="flow-page__card-badges">
                  <span className="flow-page__badge flow-page__badge--type">
                    {typeLabel}
                  </span>
                  <span className="flow-page__badge flow-page__badge--count">
                    {flow.size} tracks
                  </span>
                  {ownerLabel ? (
                    <span className="flow-page__badge flow-page__badge--owner">
                      {ownerLabel}
                    </span>
                  ) : null}
                  {state === "running" && (
                    <span className="badge badge-success flow-page__status-badge">
                      <Loader2 className="artist-icon-xs animate-spin" />
                      Running
                    </span>
                  )}
                  {togglingId === flow.id && (
                    <span className="badge badge-secondary flow-page__status-badge">
                      <Loader2 className="artist-icon-xs animate-spin" />
                      Updating
                    </span>
                  )}
                </div>
              </div>
              <div className="flow-page__card-actions">
                <button
                  onClick={onViewTracks}
                  className={`btn btn--hide-mobile btn-sm btn--toolbar ${isTracksOpen ? "btn-neutral-active" : "btn-secondary"}`}
                  aria-label={isTracksOpen ? `Close ${flow.name} tracks` : `View ${flow.name} tracks`}
                  title={isTracksOpen ? `Close ${flow.name} tracks` : `View ${flow.name} tracks`}
                  aria-pressed={isTracksOpen}
                  disabled={!enabled && !isTracksOpen}
                >
                  <ListMusic className="artist-icon-sm" />
                  <span className="flow-page__btn-label--md">Tracks</span>
                </button>
                <button
                  onClick={onToggleEditing}
                  className={`btn btn--hide-mobile btn-sm btn--toolbar ${isEditing ? "btn-neutral-active" : "btn-secondary"}`}
                  aria-label={isEditing ? "Close editor" : "Edit flow"}
                  title={isEditing ? `Close ${flow.name} editor` : `Edit ${flow.name}`}
                  aria-pressed={isEditing}
                >
                  <Pencil className="artist-icon-sm" />
                  <span className="flow-page__btn-label--md">Manage</span>
                </button>
                <MoreMenu activeButtonClass="btn-neutral-active">
                  <button
                    onClick={onViewTracks}
                    className="artist-menu-item flow-page__menu-item--mobile-only"
                    aria-pressed={isTracksOpen}
                    disabled={!enabled && !isTracksOpen}
                  >
                    <span className="artist-menu-item__main">
                      <ListMusic className="artist-icon-sm" />
                      {isTracksOpen ? "Hide Tracks" : "View Tracks"}
                    </span>
                  </button>
                  <button
                    onClick={onToggleEditing}
                    className="artist-menu-item flow-page__menu-item--mobile-only"
                    aria-pressed={isEditing}
                  >
                    <span className="artist-menu-item__main">
                      <Pencil className="artist-icon-sm" />
                      {isEditing ? "Close Manage View" : "Manage Flow"}
                    </span>
                  </button>
                  {isNameEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={isNameDirty ? onNameApply : onNameCancel}
                        className="artist-menu-item flow-page__menu-item--mobile-only"
                        disabled={isNameApplying}
                      >
                        <span className="artist-menu-item__main">
                          {isNameApplying ? (
                            <Loader2 className="artist-icon-sm animate-spin" />
                          ) : (
                            <Check className="artist-icon-sm" />
                          )}
                          Save Title
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={onNameCancel}
                        className="artist-menu-item flow-page__menu-item--mobile-only"
                        disabled={isNameApplying}
                      >
                        <span className="artist-menu-item__main">
                          <X className="artist-icon-sm" />
                          Cancel Rename
                        </span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={onToggleNameEditing}
                      className="artist-menu-item flow-page__menu-item--mobile-only"
                    >
                      <span className="artist-menu-item__main">
                        <Pencil className="artist-icon-sm" />
                        Rename Title
                      </span>
                    </button>
                  )}
                  <div className="flow-page__menu-divider flow-page__menu-divider--mobile-only" />
                  <button
                    onClick={onRunNow}
                    className="artist-menu-item"
                    disabled={!canRunNow}
                  >
                    <span className="artist-menu-item__main">
                      {isRerunningThisFlow ? (
                        <Loader2 className="artist-icon-sm animate-spin" />
                      ) : (
                        <Play className="artist-icon-sm" />
                      )}
                      Run Now
                    </span>
                  </button>
                  <button
                    onClick={onConvertToStatic}
                    className="artist-menu-item"
                    disabled={!canConvertToStatic || convertingId === flow.id}
                  >
                    <span className="artist-menu-item__main">
                      {convertingId === flow.id ? <Loader2 className="artist-icon-sm animate-spin" /> : <FilePlus2 className="artist-icon-sm" />}
                      Convert to Static
                    </span>
                  </button>
                  <button
                    onClick={onExport}
                    className="artist-menu-item"
                    disabled={!canExport}
                  >
                    <span className="artist-menu-item__main">
                      <Download className="artist-icon-sm" />
                      Download JSON
                    </span>
                  </button>
                  <div className="flow-page__menu-divider" />
                  <button
                    onClick={onDelete}
                    className="artist-menu-item artist-menu-item--danger"
                    disabled={deletingId === flow.id}
                  >
                    <span className="artist-menu-item__main">
                      {deletingId === flow.id ? <Loader2 className="artist-icon-sm animate-spin" /> : <Trash2 className="artist-icon-sm" />}
                      Delete Flow
                    </span>
                  </button>
                </MoreMenu>
                <div className="flow-page__toggle-wrap">
                  {togglingId === flow.id && (
                    <Loader2 className="artist-icon-xs animate-spin flow-page__toggle-spinner" />
                  )}
                  <PillToggle
                    checked={enabled}
                    className={`pill-toggle--flow-compact${enabled ? "" : " is-off"}`}
                    onChange={(event) => onToggleEnabled(event.target.checked)}
                    disabled={togglingId === flow.id}
                  />
                </div>
              </div>
            </div>
            <div className="flow-page__card-title-row">
              <div className={enabled ? "" : "flow-page__card--dimmed"}>
                <div className="flow-page__card-title-row">
                  {isNameEditing ? (
                    <input
                      type="text"
                      className="input input-sm flow-page__card-title-input"
                      value={simpleDraft?.name ?? ""}
                      onChange={(event) =>
                        onDraftChange((prev) => ({
                          ...prev,
                          name: event.target.value,
                        }))
                      }
                      onInput={onClearError}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (isNameDirty) {
                            onNameApply();
                            return;
                          }
                          onNameCancel();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          onNameCancel();
                        }
                      }}
                      aria-label={`Edit ${flow.name} name`}
                    />
                  ) : (
                    <h3 className="flow-page__card-title">
                      {flow.name}
                    </h3>
                  )}
                  <div className="flow-page__card-title-actions">
                    <button
                      type="button"
                      onClick={
                        isNameEditing
                          ? (isNameDirty ? onNameApply : onNameCancel)
                          : onToggleNameEditing
                      }
                      className={`btn ${isNameEditing ? "btn-primary" : "btn-ghost"} btn-xs`}
                      aria-label={isNameEditing ? `Save ${flow.name}` : `Edit ${flow.name}`}
                      title={isNameEditing ? `Save ${flow.name}` : `Edit ${flow.name}`}
                      disabled={isNameApplying}
                    >
                      {isNameApplying ? (
                        <Loader2 className="artist-icon-xs animate-spin" />
                      ) : isNameEditing ? (
                        <Check className="artist-icon-xs" />
                      ) : (
                        <Pencil className="artist-icon-xs" />
                      )}
                    </button>
                    {isNameEditing ? (
                      <button
                        type="button"
                        onClick={onNameCancel}
                        className="btn btn-ghost btn-xs"
                        aria-label={`Cancel editing ${flow.name}`}
                        title={`Cancel editing ${flow.name}`}
                        disabled={isNameApplying}
                      >
                        <X className="artist-icon-xs" />
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="flow-page__card-meta">
                  {statusSummary ? <span>{statusSummary}</span> : null}
                  {statusSummary && metaItems.length > 0 ? (
                    <span className="flow-page__card-meta-dot">•</span>
                  ) : null}
                  {metaItems.length > 0 ? <span>{metaItems.join(" • ")}</span> : null}
                </div>
              </div>
            </div>
              {flowWorkerMessage ? (
              <div className={`flow-page__card-status flow-page__card-hint--desktop${enabled ? "" : " flow-page__card--dimmed"}`}>
                {flowWorkerMessage}
              </div>
            ) : null}
            <div className={`flow-page__card-hint flow-page__card-hint--mobile${enabled ? "" : " flow-page__card--dimmed"}`}>
              {isTracksOpen ? "Tap card to hide tracks" : "Tap card to view tracks"}
            </div>
            {(state === "running" || state === "completed") && total > 0 ? (
              <div className={`flow-page__progress${enabled ? "" : " flow-page__card--dimmed"}`}>
                <div className="flow-page__progress-bar">
                  <div
                    className={`flow-page__progress-fill${state === "completed" ? " flow-page__progress-fill--completed" : ""}`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="flow-page__progress-stats-mobile">{progressPct}% complete</div>
                <div className="flow-page__progress-stats">
                  <span>{progressPct}% complete</span>
                  <span className="flow-page__card-meta-dot">•</span>
                  <span>Pending {pendingCount}</span>
                  <span className="flow-page__card-meta-dot">•</span>
                  <span>Downloading {downloadingCount}</span>
                  <span className="flow-page__card-meta-dot">•</span>
                  <span>Done {processedDisplay}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {isEditing && (
        <div className="flow-page__card-expanded">
          <div className="flow-page__card-expanded-separator" />
          <div className="flow-page__form">
            <FlowFormFields
              draft={simpleDraft}
              remaining={simpleRemaining}
              inputClassName="flow-page__field-control"
              errorMessage={simpleError}
              onDraftChange={onDraftChange}
              onClearError={onClearError}
              normalizeMixPercent={normalizeMixPercent}
              disabledSources={disabledSources}
            />
            <div className="flow-page__card-footer-actions">
              <button onClick={onCancel} className="btn btn-secondary btn-sm">
                Cancel
              </button>
              <FlipSaveButton
                disabled={saveDisabled}
                saving={isApplying}
                onClick={onApply}
                label="Save"
                savedLabel="Saved"
                showSavedState={showSavedState}
              />
            </div>
          </div>
        </div>
      )}

      {isTracksOpen && (
        <div className="flow-page__card-expanded">
          <div className="flow-page__card-expanded-separator" />
          <FlowTracksPanel
            tracks={tracks}
            loading={tracksLoading}
            error={tracksError}
            onAddTrackToPlaylist={onAddTrackToPlaylist}
            onNavigateArtist={onNavigateArtist}
          />
        </div>
      )}
    </div>
  );
}

function FlowTracksSortHeader({
  label,
  sortKey,
  activeSortKey,
  sortDirection,
  onSort,
  className = "",
}) {
  const active = activeSortKey === sortKey;
  const DirectionIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;
  const ariaSort = active
    ? sortDirection === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th className={className} scope="col" aria-sort={ariaSort}>
      <button
        type="button"
        className={`flow-page__tracks-sort-button${active ? " is-active" : ""}`}
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        {active ? (
          <DirectionIcon className="artist-icon-xs" aria-hidden="true" />
        ) : null}
      </button>
    </th>
  );
}

export function FlowTracksPanel({
  tracks,
  loading,
  error,
  activityHint = null,
  emptyMessage = "No tracks generated for this flow yet.",
  headerActions = null,
  deletingTrackId = null,
  reSearchingTrackIds = {},
  useTrackContextMenu = false,
  playlists = [],
  playlistsLoading = false,
  playlistSavingKey = "",
  playlistMenuError = "",
  excludedPlaylistIds = [],
  getDefaultPlaylistName,
  onLoadPlaylists,
  onDeleteTrack,
  onAddTrackToPlaylist,
  onMoveTrackToPlaylist,
  onNavigateArtist,
  onReSearchTrack,
  playbackSource = null,
  showPlaybackControls = true,
  hideAlbumColumn = false,
  hideStatusColumn = false,
}) {
  const [sortKey, setSortKey] = useState("index");
  const [sortDirection, setSortDirection] = useState("asc");
  const trackOrderKey = useMemo(
    () => tracks.map((track) => track.id).join("\n"),
    [tracks],
  );

  useEffect(() => {
    setSortKey("index");
    setSortDirection("asc");
  }, [trackOrderKey]);

  const {
    playQueue,
    playTrack,
    togglePlayPause,
    isShuffleEnabled,
    matchesSource,
    isPlaying,
    currentTrack: activeTrack,
  } = useAudioQueue();

  const sortedTracks = useMemo(
    () => sortFlowTracks(tracks, sortKey, sortDirection),
    [tracks, sortKey, sortDirection],
  );

  const playableTracks = useMemo(
    () =>
      sortedTracks.filter(
        (track) => track.status === "done" && track.streamUrl,
      ),
    [sortedTracks],
  );

  const handleSort = (nextSortKey) => {
    if (sortKey === nextSortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextSortKey);
    setSortDirection("asc");
  };

  const isSourceActive = matchesSource(playbackSource);
  const currentTrackId =
    isSourceActive && activeTrack?.id ? activeTrack.id : null;
  const isCurrentPlaying = isSourceActive && isPlaying;

  const isPlaylistPlaying = isSourceActive && isCurrentPlaying;

  const handlePrimaryPlay = () => {
    if (playableTracks.length === 0) return;
    if (isSourceActive && (isPlaying || currentTrackId)) {
      togglePlayPause();
      return;
    }
    const queueTracks = playableTracks.map((track) => normalizeFlowTrack(track));
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: false,
    });
  };

  const handleShufflePlay = () => {
    if (playableTracks.length === 0) return;
    const queueTracks = playableTracks.map((track) => normalizeFlowTrack(track));
    playQueue(queueTracks, {
      source: playbackSource,
      shuffle: true,
    });
  };

  const handlePlayTrack = (track) => {
    if (!track?.streamUrl) return;
    const normalized = normalizeFlowTrack(track);
    if (currentTrackId === track.id && isSourceActive) {
      togglePlayPause();
      return;
    }
    playTrack(normalized, {
      source: playbackSource,
      queue: playableTracks.map((entry) => normalizeFlowTrack(entry)),
      shuffle: isShuffleEnabled,
    });
  };

  return (
    <div className="flow-page__tracks">
      {showPlaybackControls || headerActions ? (
        <div className="flow-page__tracks-toolbar">
          {showPlaybackControls ? (
            <div className="flow-page__tracks-toolbar-start">
              <button
                type="button"
                onClick={handlePrimaryPlay}
                className="btn btn-primary btn-round-lg"
                disabled={playableTracks.length === 0}
                aria-label={
                  isPlaylistPlaying ? "Pause playback" : "Play all tracks"
                }
              >
                {isPlaylistPlaying ? (
                  <Pause className="artist-icon-md" />
                ) : (
                  <Play className="artist-icon-md" />
                )}
              </button>
              <button
                type="button"
                onClick={handleShufflePlay}
                className={`btn btn-secondary btn-round-lg flow-page__tracks-toolbar-shuffle${isShuffleEnabled ? " is-active" : ""}`}
                disabled={playableTracks.length === 0}
                aria-label="Shuffle and play"
              >
                <Shuffle className="artist-icon-md" />
              </button>
            </div>
          ) : headerActions ? (
            <div className="flow-page__tracks-toolbar-start flow-page__tracks-toolbar-start--full">
              {headerActions}
            </div>
          ) : null}
          {showPlaybackControls && headerActions ? (
            <div className="flow-page__tracks-toolbar-actions">
              {headerActions}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flow-page__tracks-body">
        {loading && (
          <div className="flow-page__tracks-loading">
            <Loader2 className="artist-icon-sm animate-spin" />
            Loading tracks...
          </div>
        )}
        {!loading && error && (
          <div className="flow-page__tracks-error">{error}</div>
        )}
        {!loading && !error && tracks.length === 0 && (
          <div className="flow-page__tracks-empty">
            {activityHint ? (
              <>
                <Loader2 className="artist-icon-sm animate-spin" />
                <span>{activityHint}</span>
              </>
            ) : (
              emptyMessage
            )}
          </div>
        )}
        {!loading && !error && tracks.length > 0 && (
          <table
            className={`flow-page__tracks-table${hideAlbumColumn ? " flow-page__tracks-table--no-album" : ""}`}
          >
            <thead className="flow-page__tracks-table-head">
              <tr>
                <FlowTracksSortHeader
                  label="#"
                  sortKey="index"
                  activeSortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="flow-page__tracks-table-index"
                />
                <FlowTracksSortHeader
                  label="Song"
                  sortKey="song"
                  activeSortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="flow-page__tracks-table-song"
                />
                <FlowTracksSortHeader
                  label="Artist"
                  sortKey="artist"
                  activeSortKey={sortKey}
                  sortDirection={sortDirection}
                  onSort={handleSort}
                  className="flow-page__tracks-table-artist"
                />
                {hideAlbumColumn ? null : (
                  <FlowTracksSortHeader
                    label="Album"
                    sortKey="album"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="flow-page__tracks-table-album"
                  />
                )}
                {hideStatusColumn ? null : (
                  <FlowTracksSortHeader
                    label="Status"
                    sortKey="status"
                    activeSortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className="flow-page__tracks-table-status-head"
                  />
                )}
                <th
                  className="flow-page__tracks-table-actions-head"
                  aria-hidden="true"
                />
              </tr>
            </thead>
            <tbody>
              {sortedTracks.map((track, index) => {
                const trackDisplayNumber = getFlowTrackDisplayNumber(track, {
                  tracks,
                  sortedTracks,
                  sortedIndex: index,
                  sortKey,
                  sortDirection,
                });
                const canPlay =
                  showPlaybackControls &&
                  track.status === "done" &&
                  !!track.streamUrl;
                const canDelete =
                  typeof onDeleteTrack === "function" && !!track.id;
                const canReSearch =
                  typeof onReSearchTrack === "function" &&
                  !!track.id &&
                  (track.status === "done" || track.status === "failed");
                const isReSearching = reSearchingTrackIds[track.id] === true;
                const isDeleting = deletingTrackId === track.id;
                const isCurrent = track.id === currentTrackId && isCurrentPlaying;
                return (
                  <tr
                    key={track.id}
                    className={`flow-page__tracks-table-row${isCurrent ? " is-current" : ""}`}
                  >
                    <td className="flow-page__tracks-table-index">
                      {showPlaybackControls ? (
                        <div className="flow-page__tracks-table-index-inner">
                          <span className="flow-page__tracks-table-index-number">
                            {trackDisplayNumber}
                          </span>
                          <button
                            type="button"
                            onClick={() => handlePlayTrack(track)}
                            className="flow-page__tracks-table-index-play btn btn-secondary btn-icon btn-xs"
                            disabled={!canPlay}
                            aria-label={
                              isCurrent
                                ? `Pause ${track.trackName}`
                                : `Play ${track.trackName}`
                            }
                          >
                            {isCurrent ? (
                              <Pause className="artist-icon-xs" />
                            ) : (
                              <Play className="artist-icon-xs" />
                            )}
                          </button>
                        </div>
                      ) : (
                        trackDisplayNumber
                      )}
                    </td>
                    <td
                      className="flow-page__tracks-table-song"
                      title={track.trackName}
                    >
                      <span className="flow-page__tracks-table-cell-text">
                        {track.trackName}
                      </span>
                    </td>
                    <td
                      className="flow-page__tracks-table-artist"
                      title={track.artistName}
                    >
                      {track.artistMbid ? (
                        <button
                          type="button"
                          onClick={() => onNavigateArtist(track)}
                          className="flow-page__tracks-artist-link"
                        >
                          {track.artistName}
                        </button>
                      ) : (
                        <span className="flow-page__tracks-table-cell-text">
                          {track.artistName}
                        </span>
                      )}
                    </td>
                    {hideAlbumColumn ? null : (
                      <td
                        className="flow-page__tracks-table-album"
                        title={track.albumName || "Unknown Album"}
                      >
                        <span className="flow-page__tracks-table-cell-text">
                          {track.albumName || "Unknown Album"}
                        </span>
                      </td>
                    )}
                    {hideStatusColumn ? null : (
                      <td className="flow-page__tracks-table-status-cell">
                        <TrackStatusDot status={track.status} />
                      </td>
                    )}
                    <td className="flow-page__tracks-table-actions-cell">
                      <div className="flow-page__tracks-actions">
                        <FlowTrackPlaylistMenus
                          track={track}
                          useTrackContextMenu={useTrackContextMenu}
                          playlists={playlists}
                          playlistsLoading={playlistsLoading}
                          playlistSavingKey={playlistSavingKey}
                          playlistMenuError={playlistMenuError}
                          excludedPlaylistIds={excludedPlaylistIds}
                          getDefaultPlaylistName={getDefaultPlaylistName}
                          onLoadPlaylists={onLoadPlaylists}
                          onAddTrackToPlaylist={onAddTrackToPlaylist}
                          onMoveTrackToPlaylist={onMoveTrackToPlaylist}
                        >
                          {(playlistMenuHandlers) =>
                            useTrackContextMenu ? (
                              <FlowTrackKebabMenu
                                track={track}
                                canReSearch={canReSearch}
                                isReSearching={isReSearching}
                                canDelete={canDelete}
                                isDeleting={isDeleting}
                                onReSearch={onReSearchTrack}
                                onDelete={onDeleteTrack}
                                playlistMenuProps={
                                  playlistMenuHandlers?.playlistMenuProps
                                }
                              />
                            ) : (
                              <>
                                {canReSearch ? (
                                  <button
                                    type="button"
                                    onClick={() => onReSearchTrack(track)}
                                    className="btn btn-secondary btn-icon btn-xs"
                                    aria-label={`Re-search ${track.trackName}`}
                                    title={`Re-search ${track.trackName}`}
                                    disabled={isReSearching}
                                  >
                                    {isReSearching ? (
                                      <Loader2 className="artist-icon-xs animate-spin" />
                                    ) : (
                                      <Search className="artist-icon-xs" />
                                    )}
                                  </button>
                                ) : null}
                                {canDelete ? (
                                  <button
                                    type="button"
                                    onClick={() => onDeleteTrack?.(track)}
                                    className="btn btn-ghost-danger btn-icon btn-xs"
                                    aria-label={`Remove ${track.trackName} from playlist`}
                                    title={`Remove ${track.trackName} from playlist`}
                                    disabled={isDeleting}
                                  >
                                    {isDeleting ? (
                                      <Loader2 className="artist-icon-xs animate-spin" />
                                    ) : (
                                      <Trash2 className="artist-icon-xs" />
                                    )}
                                  </button>
                                ) : null}
                              </>
                            )
                          }
                        </FlowTrackPlaylistMenus>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const getFlowEmptyCopy = (libraryFilter, canCreate) => {
  if (libraryFilter === "playlists") {
    return {
      title: "No playlists yet",
      message:
        "Create a playlist to curate tracks, or import one from Aurral Convert or a JSON export.",
      showPlaylistAction: true,
      showFlowAction: false,
      showImportAction: true,
    };
  }
  if (libraryFilter === "flows") {
    if (!canCreate) {
      return {
        title: "Flows need listening history",
        message:
          "Connect Last.fm in Settings to create flows that generate tracks from your taste.",
        showPlaylistAction: false,
        showFlowAction: false,
        showImportAction: false,
        showSettingsAction: true,
      };
    }
    return {
      title: "No flows yet",
      message:
        "Flows are auto-updating playlists built from recipes like Release Radar or your top artists.",
      showPlaylistAction: false,
      showFlowAction: true,
      showImportAction: false,
    };
  }
  return {
    title: "Start your playlist library",
    message:
      "Import a playlist, build your own track list, or create a flow that updates automatically from your taste.",
    showPlaylistAction: true,
    showFlowAction: canCreate,
    showImportAction: true,
  };
};

export function FlowEmptyState({
  canCreate = true,
  libraryFilter = "all",
  variant = "full",
  onImport,
  onNewPlaylist,
  onNewFlow,
  creatingPlaylist = false,
  creatingFlow = false,
}) {
  const copy = getFlowEmptyCopy(libraryFilter, canCreate);
  const isCompact = variant === "compact";

  return (
    <div
      className={`flow-page__collection-empty${isCompact ? " flow-page__collection-empty--compact" : ""}`}
    >
      <div className="flow-page__collection-empty__icon" aria-hidden="true">
        <ListMusic className="artist-icon-lg" />
      </div>
      <h2 className="flow-page__collection-empty__title">{copy.title}</h2>
      <p className="flow-page__collection-empty__message">{copy.message}</p>
      {!isCompact ? (
        <div className="flow-page__collection-empty__actions">
          {copy.showPlaylistAction ? (
            <button
              type="button"
              onClick={onNewPlaylist}
              disabled={creatingPlaylist}
              className="btn btn-primary btn--bold btn-min-h"
            >
              <ListMusic className="artist-icon-sm" />
              {creatingPlaylist ? "Creating..." : "New Playlist"}
            </button>
          ) : null}
          {copy.showFlowAction ? (
            <button
              type="button"
              onClick={onNewFlow}
              disabled={creatingFlow}
              className="btn btn-secondary btn--bold btn-min-h"
            >
              <Sparkles className="artist-icon-sm" />
              {creatingFlow ? "Creating..." : "New Flow"}
            </button>
          ) : null}
          {copy.showImportAction ? (
            <button
              type="button"
              onClick={onImport}
              className="btn btn-secondary btn--bold btn-min-h"
            >
              <Upload className="artist-icon-sm" />
              Import
            </button>
          ) : null}
          {copy.showSettingsAction ? (
            <Link
              to="/settings"
              className="btn btn-primary btn--bold btn-min-h"
            >
              Open Settings
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FlowDetailPlaceholder() {
  return (
    <div className="flow-page__detail-placeholder">
      <div className="flow-page__detail-placeholder__icon" aria-hidden="true">
        <ListMusic className="artist-icon-lg" />
      </div>
      <p className="flow-page__detail-placeholder__message">
        Select a playlist or flow to view tracks and settings.
      </p>
    </div>
  );
}

export function FlowImportReviewModal({
  importReview,
  importing,
  onNameChange,
  onCancel,
  onConfirm,
}) {
  if (!importReview) return null;

  const flows = Array.isArray(importReview.flows) ? importReview.flows : [];

  return (
    <div
      className="artist-modal-backdrop"
      onClick={importing ? undefined : onCancel}
    >
      <div
        className="flow-page__import-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flow-page__import-modal-header">
          <div className="flow-page__import-modal-header-row">
            <div>
              <div className="flow-page__import-modal-eyebrow">
                Import Playlist
              </div>
              <h3 className="flow-page__import-modal-title">
                {importReview.fileName || "Selected playlist file"}
              </h3>
              <p className="flow-page__import-modal-copy">
                {flows.length} {flows.length === 1 ? "playlist" : "playlists"} detected. Imports stay separate from weekly flows and queue their own downloads.
              </p>
            </div>
            <div className="flow-page__import-modal-badge">
              JSON import
            </div>
          </div>
        </div>

        <div className="flow-page__import-modal-body">
          <div className="flow-page__import-list">
            {flows.map((flow, index) => {
              const trackCount = Number(flow?.tracks?.length || flow?.trackCount || 0);
              const previewTracks = Array.isArray(flow?.tracks) ? flow.tracks.slice(0, 3) : [];
              return (
                <div
                  key={`${flow?.name || "flow"}-${index}`}
                  className="flow-page__import-item"
                >
                  <div className="flow-page__import-item-header">
                    <h4 className="flow-page__import-item-title">
                      {flow?.name || `Playlist ${index + 1}`}
                    </h4>
                    <span className="flow-page__badge flow-page__badge--count">
                      {trackCount} tracks
                    </span>
                    {flow?.sourceName ? (
                      <span className="flow-page__badge flow-page__badge--type">
                        From {flow.sourceName}
                      </span>
                    ) : null}
                  </div>
                  <div className="flow-page__field">
                    <label className="flow-page__field-label">
                      Playlist Name
                    </label>
                    <input
                      type="text"
                      value={flow?.importName ?? flow?.name ?? ""}
                      onChange={(event) => onNameChange?.(index, event.target.value)}
                      placeholder={`Playlist ${index + 1}`}
                      disabled={importing}
                      className="input flow-page__field-input"
                    />
                  </div>
                  <div className="flow-page__import-preview">
                    {previewTracks.map((track) => (
                      <span key={`${track.artistName}-${track.trackName}`}>
                        {track.artistName} — {track.trackName}
                      </span>
                    ))}
                    {trackCount > previewTracks.length ? (
                      <span className="flow-page__import-preview-more">
                        +{trackCount - previewTracks.length} more tracks
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flow-page__import-modal-footer">
          <p className="flow-page__import-modal-hint">
            Supports exported playlist files, a single playlist object, or a raw array of tracks. Imported playlists stay separate from weekly flow refreshes.
          </p>
          <div className="flow-page__import-modal-actions">
            <button
              type="button"
              onClick={onCancel}
              className="btn btn-secondary"
              disabled={importing}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="btn btn-primary"
              disabled={importing || flows.length === 0}
            >
              {importing ? (
                <>
                  <Loader2 className="artist-icon-sm animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="artist-icon-sm" />
                  Import Playlists
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDeleteModal({ confirmDelete, deletingId, onCancel, onConfirm }) {
  if (!confirmDelete) return null;
  const isShared = confirmDelete.kind === "shared";

  return (
    <div className="artist-modal-backdrop" onClick={onCancel}>
      <div className="artist-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="artist-modal__title">
          Delete {confirmDelete.title}?
        </h3>
        <p className="artist-modal__subcopy">
          {isShared
            ? "This removes the imported static playlist and any downloaded files tied to it."
            : "This removes the flow and its playlist setup. You can recreate it later."}
        </p>
        <div className="artist-modal__actions">
          <button onClick={onCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn btn-secondary flow-page__btn--destructive"
            disabled={deletingId === confirmDelete.flowId}
          >
            {deletingId === confirmDelete.flowId ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmDisableModal({
  confirmDisable,
  togglingId,
  onCancel,
  onConfirm,
}) {
  if (!confirmDisable) return null;

  return (
    <div className="artist-modal-backdrop" onClick={onCancel}>
      <div className="artist-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="artist-modal__title">
          Turn off {confirmDisable.title}?
        </h3>
        <p className="artist-modal__subcopy">
          This pauses future runs. You can turn it back on anytime.
        </p>
        <div className="artist-modal__actions">
          <button onClick={onCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn btn-secondary flow-page__btn--destructive"
            disabled={togglingId === confirmDisable.flowId}
          >
            {togglingId === confirmDisable.flowId ? "Turning off..." : "Turn Off"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmStopAllModal({
  confirmStopAll,
  bulkActionRunning,
  onCancel,
  onConfirm,
}) {
  if (!confirmStopAll) return null;

  return (
    <div className="artist-modal-backdrop" onClick={onCancel}>
      <div className="artist-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="artist-modal__title">
          Stop all playlists?
        </h3>
        <p className="artist-modal__subcopy">
          This pauses future runs. You can start them again anytime.
        </p>
        <div className="artist-modal__actions">
          <button onClick={onCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn btn-secondary flow-page__btn--destructive"
            disabled={bulkActionRunning}
          >
            {bulkActionRunning ? "Stopping..." : "Stop All"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FlowWorkerSettingsModal({
  isOpen,
  settings,
  hasChanges,
  saving,
  onCancel,
  onChange,
  onSave,
}) {
  if (!isOpen) return null;

  return (
    <div className="artist-modal-backdrop" onClick={onCancel}>
      <div
        className="settings-page__modal settings-page__modal--wide flow-page__worker-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-labelledby="worker-settings-title"
        aria-modal="true"
      >
        <div className="settings-page__modal-header settings-page__modal-header--spaced">
          <h3 id="worker-settings-title" className="settings-page__modal-title">
            Worker Settings
          </h3>
        </div>

        <div className="flow-page__worker-fields">
          <div className="flow-page__worker-fields-split">
            <div className="flow-page__field">
              <label className="flow-page__field-label">
                Download Concurrency
              </label>
              <div
                className="artist-segmented flow-page__worker-segmented"
                role="radiogroup"
                aria-label="Download concurrency"
              >
                {FLOW_WORKER_CONCURRENCY_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={settings.concurrency === value}
                    className={`artist-segmented-button${settings.concurrency === value ? " is-active" : ""}`}
                    onClick={() =>
                      onChange((prev) => ({ ...prev, concurrency: value }))
                    }
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div className="flow-page__field">
              <label className="flow-page__field-label">Retry Cycle</label>
              <div className="artist-modal-field aurral-radius-round">
                <select
                  value={settings.retryCycleMinutes}
                  onChange={(event) =>
                    onChange((prev) => ({
                      ...prev,
                      retryCycleMinutes: Number(event.target.value),
                    }))
                  }
                  className="artist-modal-select"
                >
                  {FLOW_WORKER_RETRY_CYCLE_OPTIONS.map((option) => (
                    <option key={option.minutes} value={option.minutes}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flow-page__field">
            <label className="flow-page__field-label">Existing Files</label>
            <div className="artist-modal-field aurral-radius-round">
              <select
                value={settings.existingFileMode || "reuse"}
                onChange={(event) =>
                  onChange((prev) => ({
                    ...prev,
                    existingFileMode: event.target.value,
                  }))
                }
                className="artist-modal-select"
                title="How generated playlists reuse existing Aurral or Lidarr files"
              >
                {FLOW_WORKER_EXISTING_FILE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="settings-page__modal-actions">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-secondary"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="btn btn-primary"
            disabled={!hasChanges || saving}
          >
            {saving ? (
              <Loader2 className="artist-icon-xs animate-spin" />
            ) : (
              <Save className="artist-icon-xs" />
            )}
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
