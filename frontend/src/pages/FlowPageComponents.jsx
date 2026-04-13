import {
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  Loader2,
  Check,
  CircleDashed,
  Clock,
  Trash2,
  Pencil,
  FilePlus2,
  ListMusic,
  Download,
  Upload,
  Play,
  Pause,
  Shuffle,
  SkipBack,
  SkipForward,
  ExternalLink,
  Volume2,
  VolumeX,
  Plus,
  ChevronDown,
  MoreHorizontal,
  X,
} from "lucide-react";
import PillToggle from "../components/PillToggle";
import FlipSaveButton from "../components/FlipSaveButton";
import { TAG_COLORS } from "./ArtistDetails/constants";

const SOURCE_MIX_COLORS = {
  discover: TAG_COLORS[10],
  mix: TAG_COLORS[4],
  trending: TAG_COLORS[12],
};

const MIX_PRESET_COLORS = {
  balanced: TAG_COLORS[1],
  discover: TAG_COLORS[2],
  library: TAG_COLORS[11],
  trending: TAG_COLORS[7],
  custom: TAG_COLORS[0],
};

const FOCUS_STRENGTH_COLORS = {
  light: "#7e896fff",
  medium: "#667059ff",
  heavy: "#48513eff",
};

const WEEKDAY_OPTIONS = [
  { id: 0, short: "Su", full: "Sunday" },
  { id: 1, short: "M", full: "Monday" },
  { id: 2, short: "T", full: "Tuesday" },
  { id: 3, short: "W", full: "Wednesday" },
  { id: 4, short: "Th", full: "Thursday" },
  { id: 5, short: "F", full: "Friday" },
  { id: 6, short: "S", full: "Saturday" },
];

const SCHEDULE_COUNT_LABELS = {
  3: "three times",
  4: "four times",
  5: "five times",
  6: "six times",
};
const FLOW_WORKER_CONCURRENCY_OPTIONS = [1, 2, 3];
const FLOW_WORKER_FORMAT_OPTIONS = [
  { id: "flac", label: "FLAC" },
  { id: "mp3", label: "MP3" },
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

export function MixSlider({ mix, onChange, normalizeMixPercent }) {
  const normalized = normalizeMixPercent(mix);
  const barRef = useRef(null);
  const dragRef = useRef(null);

  const updateFromClientX = useCallback(
    (clientX, handle) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clampedX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      const percent = rect.width > 0 ? (clampedX / rect.width) * 100 : 0;
      if (handle === "left") {
        const totalLeft = 100 - normalized.trending;
        const nextDiscover = Math.min(Math.max(percent, 0), totalLeft);
        const nextMix = Math.max(0, totalLeft - nextDiscover);
        onChange(
          normalizeMixPercent({
            discover: nextDiscover,
            mix: nextMix,
            trending: normalized.trending,
          })
        );
        return;
      }
      const totalRight = 100 - normalized.discover;
      const nextMix = Math.min(
        Math.max(percent - normalized.discover, 0),
        totalRight
      );
      const nextTrending = Math.max(0, totalRight - nextMix);
      onChange(
        normalizeMixPercent({
          discover: normalized.discover,
          mix: nextMix,
          trending: nextTrending,
        })
      );
    },
    [normalized, onChange, normalizeMixPercent]
  );

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

  const leftPosition = normalized.discover;
  const rightPosition = normalized.discover + normalized.mix;
  const minHandleInset = 1.5;
  const minHandleGap = 2.5;
  const labelMinPercent = 6;
  const showDiscoverLabel = normalized.discover >= labelMinPercent;
  const showMixLabel = normalized.mix >= labelMinPercent;
  const showTrendingLabel = normalized.trending >= labelMinPercent;
  const clampToInset = (value) =>
    Math.min(Math.max(value, minHandleInset), 100 - minHandleInset);
  let displayLeft = clampToInset(leftPosition);
  let displayRight = clampToInset(rightPosition);
  if (displayRight - displayLeft < minHandleGap) {
    const midpoint = (displayLeft + displayRight) / 2;
    displayLeft = clampToInset(midpoint - minHandleGap / 2);
    displayRight = clampToInset(displayLeft + minHandleGap);
    if (displayRight - displayLeft < minHandleGap) {
      displayLeft = clampToInset(displayRight - minHandleGap);
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between text-xs text-[#8b8b90]">
        <span>Discover {normalized.discover}%</span>
        <span>Library {normalized.mix}%</span>
        <span>Trending {normalized.trending}%</span>
      </div>
      <div
        ref={barRef}
        className="relative h-9 rounded-full border border-white/10 bg-white/5 select-none"
      >
        <div className="absolute inset-0 flex overflow-hidden rounded-full">
          <div
            className="h-full text-[10px] font-semibold text-black/70 flex items-center justify-center"
            style={{
              width: `${normalized.discover}%`,
              backgroundColor: SOURCE_MIX_COLORS.discover,
            }}
          >
            {showDiscoverLabel ? "Discover" : ""}
          </div>
          <div
            className="h-full text-[10px] font-semibold text-black/70 flex items-center justify-center"
            style={{
              width: `${normalized.mix}%`,
              backgroundColor: SOURCE_MIX_COLORS.mix,
            }}
          >
            {showMixLabel ? "Library" : ""}
          </div>
          <div
            className="h-full text-[10px] font-semibold text-black/70 flex items-center justify-center"
            style={{
              width: `${normalized.trending}%`,
              backgroundColor: SOURCE_MIX_COLORS.trending,
            }}
          >
            {showTrendingLabel ? "Trending" : ""}
          </div>
        </div>
        <button
          type="button"
          onPointerDown={(event) => {
            dragRef.current = { handle: "left" };
            updateFromClientX(event.clientX, "left");
          }}
          className="absolute top-0 h-full w-4 -ml-2 cursor-ew-resize z-10"
          style={{ left: `${displayLeft}%` }}
          aria-label="Adjust discover and library mix"
        >
          <span className="absolute left-1/2 top-1 bottom-1 w-2 -translate-x-1/2 rounded-full bg-white/80" />
        </button>
        <button
          type="button"
          onPointerDown={(event) => {
            dragRef.current = { handle: "right" };
            updateFromClientX(event.clientX, "right");
          }}
          className="absolute top-0 h-full w-4 -ml-2 cursor-ew-resize z-10"
          style={{ left: `${displayRight}%` }}
          aria-label="Adjust library and trending mix"
        >
          <span className="absolute left-1/2 top-1 bottom-1 w-2 -translate-x-1/2 rounded-full bg-white/80" />
        </button>
      </div>
    </div>
  );
}

export function FlowFormFields({
  draft,
  remaining,
  inputClassName = "input",
  errorMessage,
  onDraftChange,
  onClearError,
  mixPresets,
  focusOptions,
  normalizeMixPercent,
}) {
  const updateDraft = (updater) => {
    onDraftChange((prev) => updater(prev));
    if (onClearError) onClearError();
  };
  const parseList = (value) =>
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  const sizeValue = Number(draft?.size);
  const trackCount =
    Number.isFinite(sizeValue) && sizeValue > 0 ? Math.round(sizeValue) : "some";
  const tags = parseList(draft?.includeTags);
  const relatedArtists = parseList(draft?.includeRelatedArtists);
  const tagStrengthId = draft?.tagStrength ?? "medium";
  const relatedStrengthId = draft?.relatedStrength ?? "medium";
  const tagIntensityPhrase =
    {
      light: "sprinkle in tags like",
      medium: "feature tags like",
      heavy: "focus heavily on tags like",
    }[tagStrengthId] ?? "feature tags like";
  const relatedIntensityPhrase =
    {
      light: "a few related artists like",
      medium: "artists related to",
      heavy: "lots of artists related to",
    }[relatedStrengthId] ?? "artists related to";
  const tagPhrase = tags.length ? `${tagIntensityPhrase} ${tags.join(", ")}` : "";
  const relatedPhrase = relatedArtists.length
    ? `${relatedIntensityPhrase} ${relatedArtists.join(", ")}`
    : "";
  const mix = normalizeMixPercent(draft?.mix);
  const mixPreset = draft?.mixPreset ?? "custom";
  const mixPhrase =
    {
      balanced: "Keep it balanced across Discover, Mix, and Trending",
      discover: "Lean into discovery",
      library: "Let the library do most of the work",
      trending: "Give it a trending lift",
    }[mixPreset] ??
    `A custom blend of ${mix.discover}% Discover, ${mix.mix}% Mix, ${mix.trending}% Trending`;
  const deepDivePhrase = draft?.deepDive
    ? "dig into deep cuts"
    : "stick with the most popular picks";
  const normalizedMix = normalizeMixPercent(draft?.mix);
  const totalSize = Number.isFinite(Number(remaining)) && Number(remaining) > 0 ? Math.round(Number(remaining)) : 0;
  const scheduleDays = Array.isArray(draft?.scheduleDays)
    ? [...new Set(draft.scheduleDays.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6))].sort(
        (a, b) => a - b
      )
    : [];
  const scheduleTime = String(draft?.scheduleTime || "00:00");
  const scheduleTimeLabel =
    SCHEDULE_HOUR_OPTIONS.find((option) => option.value === scheduleTime)?.label ||
    scheduleTime;
  const schedulePhrase =
    scheduleDays.length === 7
      ? "Update daily"
      : scheduleDays.length === 1
        ? `Update every ${WEEKDAY_OPTIONS.find((day) => day.id === scheduleDays[0])?.full.toLowerCase() || "week"}`
        : scheduleDays.length === 2
          ? `Update twice a week on ${WEEKDAY_OPTIONS.filter((day) => scheduleDays.includes(day.id))
              .map((day) => day.full.toLowerCase())
              .join(" and ")}`
          : scheduleDays.length >= 3 && scheduleDays.length <= 6
            ? `Update ${SCHEDULE_COUNT_LABELS[scheduleDays.length]} a week`
            : "Update weekly";
  const scheduleTimePhrase = `at ${scheduleTimeLabel}`;
  const clauses = [
    schedulePhrase,
    scheduleTimePhrase,
    mixPhrase,
    tagPhrase,
    relatedPhrase,
    deepDivePhrase,
  ].filter(Boolean);
  const madlibsText = `${clauses.join(", ")}. No more than ${trackCount} tracks.`;
  
  const mixScaled = (() => {
    const entries = [
      { key: "discover", value: normalizedMix.discover },
      { key: "mix", value: normalizedMix.mix },
      { key: "trending", value: normalizedMix.trending },
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
    <div className="grid gap-6">
      <div className="grid gap-4 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex flex-wrap items-start gap-6">
          <div className="grid gap-1.5 w-24 shrink-0">
            <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
              Tracks
            </label>
            <input
              type="number"
              min="1"
              max="100"
              className={inputClassName}
              value={draft.size}
              onChange={(event) => {
                const value = event.target.value;
                updateDraft((prev) => ({ ...prev, size: value }));
              }}
            />
          </div>
          <div className="grid gap-1.5 shrink-0">
            <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
              Update Days
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {WEEKDAY_OPTIONS.map((day) => {
                const checked = scheduleDays.includes(day.id);
                return (
                  <label
                    key={day.id}
                    className={`inline-flex items-center justify-center rounded w-10 h-10 text-xs font-semibold transition-colors cursor-pointer ${
                      checked
                        ? "bg-[#718062] text-[#f4f1eb]"
                        : "bg-[#15161a] text-[#a7aab5] hover:bg-[#202229] hover:text-[#dde1ea]"
                    }`}
                    title={day.full}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
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
          <div className="grid gap-1.5 w-36 shrink-0">
              <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
              Update Hour
              </label>
              <select
                className={inputClassName}
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
            </div>
        </div>
      </div>

      <div className="grid gap-3 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs uppercase tracking-[0.3em] text-[#8b8b90] font-semibold">
            Source Mix
          </div>
          <div className="flex flex-wrap gap-1.5">
            {mixPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  updateDraft((prev) => ({
                    ...prev,
                    mix: preset.mix ?? prev.mix,
                    mixPreset: preset.id,
                  }))
                }
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  draft.mixPreset === preset.id
                    ? "text-[#f4f1eb]"
                    : "bg-white/10 text-[#c1c1c3] hover:bg-white/20"
                }`}
                style={
                  draft.mixPreset === preset.id
                    ? { backgroundColor: MIX_PRESET_COLORS[preset.id] }
                    : undefined
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        
        <div className="pt-1">
          <MixSlider
            mix={draft.mix}
            onChange={(nextMix) =>
              updateDraft((prev) => ({
                ...prev,
                mix: nextMix,
                mixPreset: "custom",
              }))
            }
            normalizeMixPercent={normalizeMixPercent}
          />
          <div className="mt-2 text-[10px] text-[#8b8b90] flex justify-between px-1">
            <span>{mixScaled.discover} tracks</span>
            <span>{mixScaled.mix} tracks</span>
            <span>{mixScaled.trending} tracks</span>
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-[0.3em] text-[#8b8b90] font-semibold">
            Focus Filters
          </div>
          <div className="flex items-center gap-2">
             <span className="text-xs text-[#c1c1c3]">Deep Dive</span>
             <PillToggle
                checked={draft.deepDive === true}
                onChange={(event) =>
                  updateDraft((prev) => ({
                    ...prev,
                    deepDive: event.target.checked,
                  }))
                }
              />
          </div>
        </div>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
              Genre Tags
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                className={`${inputClassName} flex-1`}
                placeholder="lofi, indie"
                value={draft.includeTags}
                onChange={(event) =>
                  updateDraft((prev) => ({
                    ...prev,
                    includeTags: event.target.value,
                  }))
                }
              />
              <div className="flex bg-black/20 rounded p-1 gap-1 shrink-0">
                {focusOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() =>
                      updateDraft((prev) => ({
                        ...prev,
                        tagStrength: option.id,
                      }))
                    }
                    className={`px-3 py-1 rounded text-xs transition-colors ${
                      (draft.tagStrength ?? "medium") === option.id
                        ? "text-white font-medium"
                        : "text-[#8b8b90] hover:text-white"
                    }`}
                    style={
                      (draft.tagStrength ?? "medium") === option.id
                        ? { backgroundColor: FOCUS_STRENGTH_COLORS[option.id] }
                        : undefined
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
              Related Artists
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                className={`${inputClassName} flex-1`}
                placeholder="Artist A, Artist B"
                value={draft.includeRelatedArtists}
                onChange={(event) =>
                  updateDraft((prev) => ({
                    ...prev,
                    includeRelatedArtists: event.target.value,
                  }))
                }
              />
              <div className="flex bg-black/20 rounded p-1 gap-1 shrink-0">
                {focusOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() =>
                      updateDraft((prev) => ({
                        ...prev,
                        relatedStrength: option.id,
                      }))
                    }
                    className={`px-3 py-1 rounded text-xs transition-colors ${
                      (draft.relatedStrength ?? "medium") === option.id
                        ? "text-white font-medium"
                        : "text-[#8b8b90] hover:text-white"
                    }`}
                    style={
                      (draft.relatedStrength ?? "medium") === option.id
                        ? { backgroundColor: FOCUS_STRENGTH_COLORS[option.id] }
                        : undefined
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-white/5 bg-white/5 p-4">
        <div className="text-xs uppercase tracking-[0.3em] text-[#8b8b90] mb-2 font-semibold">
          Summary
        </div>
        <div className="text-sm text-[#c1c1c3] leading-relaxed italic">
          &quot;{madlibsText}&quot;
        </div>
      </div>
      
      {errorMessage && <div className="text-xs text-red-400 font-medium">{errorMessage}</div>}
    </div>
  );
}

export function FlowPageHeader({ onNewFlow }) {
  return (
    <div className="flex flex-col gap-4 mb-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-start gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white">Flow</h1>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onNewFlow}
          className="btn btn-primary btn-sm flex items-center gap-2"
        >
          <FilePlus2 className="w-4 h-4" />
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
    <div className="mb-6 rounded-lg border border-white/5 bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-white">Worker Overview</h2>
        <span className={`badge ${statusBadgeClass}`}>
          {statusLabel}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        {workerRunning ? (
          <Loader2 className="w-4 h-4 animate-spin text-[#9aa886]" />
        ) : (
          <Clock className="w-4 h-4 text-[#d0d0d4]" />
        )}
        <span className="text-[#e3e3e7]">{summaryMessage}</span>
      </div>
      {total > 0 ? (
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-[#9aa886] transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      ) : null}
      <div className="mt-3 overflow-x-auto rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs">
        <div className="flex min-w-max items-center gap-3 text-[#c1c1c3]">
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#d0d0d4]">
              Flows
            </span>
            <span>On <span className="text-white">{enabledCount}/{flowCount}</span></span>
            <span className="text-white/25">•</span>
            <span>Running <span className="text-white">{runningCount}</span></span>
            <span className="text-white/25">•</span>
            <span>Completed <span className="text-white">{completedCount}</span></span>
            <span className="text-white/25">•</span>
            <span>Idle <span className="text-white">{idleCount}</span></span>
          </div>
          <div className="h-4 w-px shrink-0 bg-white/15" />
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#d0d0d4]">
              Tracks
            </span>
            <span>Pending <span className="text-white">{pending}</span></span>
            <span className="text-white/25">•</span>
            <span>Downloading <span className="text-white">{downloading}</span></span>
            <span className="text-white/25">•</span>
            <span>Done <span className="text-white">{done}</span></span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MoreMenu({ children }) {
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
    <div className={`relative ${isOpen ? "z-[300]" : "z-30"}`} ref={menuRef}>
      <button 
        type="button" 
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }} 
        className={`btn btn-sm gap-2 ${isOpen ? "btn-primary" : "btn-secondary"}`}
        aria-label="More options"
      >
        <MoreHorizontal className="w-4 h-4" />
        <span className="hidden sm:inline">More</span>
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-48 rounded-md border border-[#3a3a44] bg-[#2d2d36] py-1 z-[320] flex flex-col"
             onClick={() => setIsOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

function buildEditableTrackRows(tracks) {
  return (Array.isArray(tracks) ? tracks : []).map((track, index) => ({
    rowId:
      track?.id ||
      `track-${index}-${Math.random().toString(36).slice(2, 10)}`,
    persistedTrackId: track?.id || null,
    artistName: String(track?.artistName || ""),
    trackName: String(track?.trackName || ""),
    albumName: String(track?.albumName || ""),
    artistMbid: String(track?.artistMbid || ""),
    reason: String(track?.reason || ""),
    status: String(track?.status || "draft"),
    error: String(track?.error || ""),
    isMarkedForDeletion: false,
  }));
}

function TrackStatusBadge({ status, pendingDelete = false }) {
  const isDownloaded = status === "done";
  const label = pendingDelete
    ? "Pending Delete"
    : isDownloaded
      ? "Downloaded"
      : "Not Downloaded";
  return (
    <span
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border ${
        pendingDelete
          ? "border-[#6f5941] bg-[#3a3025] text-[#ddb98b]"
          : isDownloaded
          ? "border-[#35533a] bg-[#223124] text-[#7ee081]"
          : "border-[#4b4231] bg-[#30281d] text-[#d8b16f]"
      }`}
      title={label}
      aria-label={label}
    >
      {pendingDelete ? (
        <X className="w-3.5 h-3.5" />
      ) : isDownloaded ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <CircleDashed className="w-3.5 h-3.5" />
      )}
    </span>
  );
}

function buildTrackSavePayload(tracks) {
  const nextTracks = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (track?.isMarkedForDeletion) {
      continue;
    }
    const artistName = String(track?.artistName || "").trim();
    const trackName = String(track?.trackName || "").trim();
    const albumName = String(track?.albumName || "").trim();
    const artistMbid = String(track?.artistMbid || "").trim();
    const reason = String(track?.reason || "").trim();
    if (!artistName && !trackName && !albumName && !artistMbid && !reason) {
      continue;
    }
    if (!artistName || !trackName) {
      throw new Error("Each edited track needs both an artist and song name");
    }
    nextTracks.push({
      artistName,
      trackName,
      albumName: albumName || null,
      artistMbid: artistMbid || null,
      reason: reason || null,
    });
  }
  if (nextTracks.length === 0) {
    throw new Error("Playlist must include at least one track");
  }
  return nextTracks;
}

export const SharedPlaylistTrackEditor = forwardRef(function SharedPlaylistTrackEditor({
  tracks,
  loading,
  error,
  saving,
  headerActions = null,
  onSave,
}, ref) {
  const [draftTracks, setDraftTracks] = useState(() => buildEditableTrackRows(tracks));
  const [editorError, setEditorError] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);

  useEffect(() => {
    setDraftTracks(buildEditableTrackRows(tracks));
    setEditorError("");
    setMissingOnly(false);
  }, [tracks]);

  const missingCount = draftTracks.filter(
    (track) => track.status === "failed" && !track.isMarkedForDeletion,
  ).length;
  const pendingDeletionCount = draftTracks.filter(
    (track) => track.isMarkedForDeletion,
  ).length;
  const visibleTracks = missingOnly
    ? draftTracks.filter(
        (track) => track.isMarkedForDeletion || track.status === "failed",
      )
    : draftTracks;
  const utilityButtonClass =
    "inline-flex h-8 items-center gap-1.5 rounded-md border border-white/12 bg-[#4a4a52] px-3 text-xs font-medium text-[#ededf0] transition hover:border-white/20 hover:bg-[#575762] disabled:cursor-not-allowed disabled:opacity-50";
  const activeUtilityButtonClass =
    "border-white/20 bg-[#5a5a64] text-white hover:bg-[#676773]";
  const initialPayload = useMemo(() => {
    try {
      return JSON.stringify(buildTrackSavePayload(buildEditableTrackRows(tracks)));
    } catch {
      return "";
    }
  }, [tracks]);

  const updateTrack = (rowId, key, value) => {
    setDraftTracks((prev) =>
      prev.map((track) =>
        track.rowId === rowId ? { ...track, [key]: value } : track,
      ),
    );
    if (editorError) {
      setEditorError("");
    }
  };

  const toggleTrackDeletion = (rowId) => {
    setDraftTracks((prev) => {
      const target = prev.find((track) => track.rowId === rowId);
      if (!target) return prev;
      if (!target.persistedTrackId && target.status === "draft") {
        return prev.filter((track) => track.rowId !== rowId);
      }
      return prev.map((track) =>
        track.rowId === rowId
          ? { ...track, isMarkedForDeletion: !track.isMarkedForDeletion }
          : track,
      );
    });
    if (editorError) {
      setEditorError("");
    }
  };

  const handleAddTrack = () => {
    setDraftTracks((prev) => [
      ...prev,
      {
        rowId: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        persistedTrackId: null,
        artistName: "",
        trackName: "",
        albumName: "",
        artistMbid: "",
        reason: "",
        status: "draft",
        error: "",
        isMarkedForDeletion: false,
      },
    ]);
    setMissingOnly(false);
  };

  const buildPayload = () => {
    return buildTrackSavePayload(draftTracks);
  };

  const handleSave = async () => {
    try {
      const payload = buildPayload();
      const currentPayload = JSON.stringify(payload);
      if (currentPayload === initialPayload) {
        setEditorError("");
        return "unchanged";
      }
      setEditorError("");
      await onSave?.(payload);
      return "saved";
    } catch (saveError) {
      setEditorError(saveError?.message || "Failed to save tracklist");
      return "error";
    }
  };

  useImperativeHandle(ref, () => ({
    save: handleSave,
  }));

  if (loading) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#1f1f24] p-6 flex items-center gap-2 text-[#c1c1c3]">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading tracks...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#1f1f24] p-6 text-red-400 text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-[#211f27] overflow-hidden">
      <div className="border-b border-white/10 px-3 py-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#b7bbc7]">
          <span>{draftTracks.length} tracks</span>
          {missingCount > 0 ? (
            <>
              <span className="text-white/25">•</span>
              <span>{missingCount} missing</span>
            </>
          ) : null}
          {pendingDeletionCount > 0 ? (
            <>
              <span className="text-white/25">•</span>
              <span className="text-[#d7b58a]">
                {pendingDeletionCount} marked for deletion
              </span>
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {headerActions}
          {missingCount > 0 ? (
            <button
              type="button"
              onClick={() => setMissingOnly((prev) => !prev)}
              className={`${utilityButtonClass} ${missingOnly ? activeUtilityButtonClass : ""}`}
            >
              {missingOnly ? "Show All" : "Missing Only"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleAddTrack}
            className={utilityButtonClass}
            disabled={saving}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Track
          </button>
        </div>
      </div>
      <div className="overflow-auto max-h-[60vh]">
        {visibleTracks.length === 0 ? (
          <div className="p-6 text-sm text-[#c1c1c3]">
            {missingOnly ? "No missing tracks right now." : "No tracks in this playlist yet."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-20 bg-[#1c1b22]">
              <tr className="text-left text-[#8b8b90] uppercase text-xs tracking-wider">
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Song</th>
                <th className="px-3 py-2">Artist</th>
                <th className="px-3 py-2">Album</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleTracks.map((track, index) => {
                const isLocked = track.status === "done";
                const isMarkedForDeletion = track.isMarkedForDeletion === true;
                const showStaticValues = isLocked || isMarkedForDeletion;
                return (
                  <tr
                    key={track.rowId}
                    className={`border-t border-white/5 text-[#d6d6d8] ${
                      index % 2 === 0 ? "bg-[#211f27]" : "bg-[#1c1b22]"
                    } ${isMarkedForDeletion ? "opacity-50" : ""}`}
                  >
                    <td className="px-3 py-2 align-top">
                      <TrackStatusBadge
                        status={track.status}
                        pendingDelete={isMarkedForDeletion}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      {showStaticValues ? (
                        <div className={`min-w-[180px] ${isMarkedForDeletion ? "line-through" : ""}`}>
                          {track.trackName || "Untitled Song"}
                        </div>
                      ) : (
                        <div className="grid gap-1 min-w-[180px]">
                          <input
                            type="text"
                            className="input input-xs bg-[#141419]"
                            value={track.trackName}
                            onChange={(event) =>
                              updateTrack(track.rowId, "trackName", event.target.value)
                            }
                            placeholder="Song name"
                          />
                          {track.error ? (
                            <span className="text-[11px] text-[#d49c9c]">
                              {track.error}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {showStaticValues ? (
                        <div className={`min-w-[180px] ${isMarkedForDeletion ? "line-through" : ""}`}>
                          {track.artistName || "Unknown Artist"}
                        </div>
                      ) : (
                        <input
                          type="text"
                          className="input input-xs min-w-[180px] bg-[#141419]"
                          value={track.artistName}
                          onChange={(event) =>
                            updateTrack(track.rowId, "artistName", event.target.value)
                          }
                          placeholder="Artist name"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {showStaticValues ? (
                        <div className={`min-w-[180px] ${isMarkedForDeletion ? "line-through" : ""}`}>
                          {track.albumName || "Unknown Album"}
                        </div>
                      ) : (
                        <input
                          type="text"
                          className="input input-xs min-w-[180px] bg-[#141419]"
                          value={track.albumName}
                          onChange={(event) =>
                            updateTrack(track.rowId, "albumName", event.target.value)
                          }
                          placeholder="Album name"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {isMarkedForDeletion ? (
                        <button
                          type="button"
                          onClick={() => toggleTrackDeletion(track.rowId)}
                          className="btn btn-secondary btn-xs px-2"
                        >
                          Undo
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleTrackDeletion(track.rowId)}
                          className="btn btn-ghost btn-xs px-2 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {editorError ? (
        <div className="border-t border-white/10 px-3 py-2 text-xs text-red-400">
          {editorError}
        </div>
      ) : null}
    </div>
  );
});

function PlaylistArtworkThumb({ artworkUrl, name }) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [artworkUrl]);

  const fallbackLabel = String(name || "?").trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="h-20 w-20 shrink-0 overflow-hidden rounded-[1.25rem] border border-white/10 bg-[#1c1b22]">
      {!imageFailed && artworkUrl ? (
        <img
          src={artworkUrl}
          alt={`${name} cover`}
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-white/5 text-lg font-semibold text-[#d2dac9]">
          {fallbackLabel}
        </div>
      )}
    </div>
  );
}

export function FlowCard({
  flow,
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
  deletingId,
  onExport,
  onConvertToStatic,
  onToggleNameEditing,
  onToggleEditing,
  onToggleEnabled,
  onDelete,
  onViewTracks,
  onNavigateArtist,
  onNameCancel,
  onNameApply,
  onCancel,
  onApply,
  onDraftChange,
  onClearError,
  mixPresets,
  focusOptions,
  normalizeMixPercent,
}) {
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
  if (enabled && nextRun && state !== "running" && !isGeneratingThisFlow) {
    metaItems.push(
      nextRun === "soon" ? "Next update soon" : `Next update in ${nextRun}`,
    );
  }
  const typeLabel = enabled ? "Flow" : "Flow Draft";
  const statusSummary = enabled
    ? "Flow refreshed weekly"
    : "Flow ready when enabled";

  return (
    <div className="bg-card rounded-lg border border-white/5 overflow-visible">
      <div className="p-4 flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className={`min-w-0 flex-1 flex gap-4 ${enabled ? "" : "opacity-50"}`}>
          <PlaylistArtworkThumb artworkUrl={artworkUrl} name={flow.name} />
          <div className="min-w-0 flex-1 grid gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-black/25 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-[#d2dac9]">
                {typeLabel}
              </span>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-[#c6c6cb]">
                {flow.size} tracks
              </span>
              {state === "running" && (
                <span className="badge badge-success badge-sm gap-1.5 pl-1.5 pr-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Running
                </span>
              )}
              {togglingId === flow.id && (
                <span className="badge badge-secondary badge-sm gap-1.5 pl-1.5 pr-2">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Updating
                </span>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 min-w-0">
                {isNameEditing ? (
                  <input
                    type="text"
                    className="input input-sm h-9 w-full max-w-md bg-[#1c1b22] text-base font-medium text-white"
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
                  <h3 className="text-base font-medium text-white truncate">
                    {flow.name}
                  </h3>
                )}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={
                      isNameEditing
                        ? (isNameDirty ? onNameApply : onNameCancel)
                        : onToggleNameEditing
                    }
                    className={`btn ${isNameEditing ? "btn-primary" : "btn-ghost"} btn-xs px-2`}
                    aria-label={isNameEditing ? `Save ${flow.name}` : `Edit ${flow.name}`}
                    title={isNameEditing ? `Save ${flow.name}` : `Edit ${flow.name}`}
                    disabled={isNameApplying}
                  >
                    {isNameApplying ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isNameEditing ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Pencil className="w-3.5 h-3.5" />
                    )}
                  </button>
                  {isNameEditing ? (
                    <button
                      type="button"
                      onClick={onNameCancel}
                      className="btn btn-ghost btn-xs px-2"
                      aria-label={`Cancel editing ${flow.name}`}
                      title={`Cancel editing ${flow.name}`}
                      disabled={isNameApplying}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#b5b5bc]">
                <span>{statusSummary}</span>
                {metaItems.length > 0 ? (
                  <>
                    <span className="text-white/25">•</span>
                    <span>{metaItems.join(" • ")}</span>
                  </>
                ) : null}
              </div>
            </div>
            {flowWorkerMessage ? (
              <div className="truncate text-xs text-[#9aa886]">
                {flowWorkerMessage}
              </div>
            ) : null}
            {(state === "running" || state === "completed") && total > 0 ? (
              <div className="grid gap-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      state === "completed" ? "bg-[#7aa2f7]" : "bg-[#9aa886]"
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#d3d3d8]">
                  <span>{progressPct}% complete</span>
                  <span className="text-white/25">•</span>
                  <span>Pending {pendingCount}</span>
                  <span className="text-white/25">•</span>
                  <span>Downloading {downloadingCount}</span>
                  <span className="text-white/25">•</span>
                  <span>Done {processedDisplay}</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              onClick={onViewTracks}
              className={`btn ${isTracksOpen ? "btn-primary" : "btn-secondary"} btn-sm gap-2`}
              aria-label={isTracksOpen ? `Close ${flow.name} tracks` : `View ${flow.name} tracks`}
              title={isTracksOpen ? `Close ${flow.name} tracks` : `View ${flow.name} tracks`}
              aria-pressed={isTracksOpen}
              disabled={!enabled && !isTracksOpen}
            >
              <ListMusic className="w-4 h-4" />
              <span className="hidden sm:inline">Tracks</span>
            </button>
            <button
              onClick={onToggleEditing}
              className={`btn ${isEditing ? "btn-primary" : "btn-secondary"} btn-sm gap-2`}
              aria-label={isEditing ? "Close editor" : "Edit flow"}
              title={isEditing ? `Close ${flow.name} editor` : `Edit ${flow.name}`}
              aria-pressed={isEditing}
            >
              <Pencil className="w-4 h-4" />
              <span className="hidden sm:inline">Manage</span>
            </button>
            <MoreMenu>
              <button
                onClick={onConvertToStatic}
                className="w-full text-left px-3 py-2.5 text-sm text-[#d6d6d8] hover:bg-white/10 hover:text-white flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!canConvertToStatic || convertingId === flow.id}
              >
                {convertingId === flow.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <FilePlus2 className="w-4 h-4" />}
                Convert to Static
              </button>
              <button
                onClick={onExport}
                className="w-full text-left px-3 py-2.5 text-sm text-[#d6d6d8] hover:bg-white/10 hover:text-white flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!canExport}
              >
                <Download className="w-4 h-4" />
                Download JSON
              </button>
              <div className="my-1 border-t border-white/10" />
              <button
                onClick={onDelete}
                className="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={deletingId === flow.id}
              >
                {deletingId === flow.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete Flow
              </button>
            </MoreMenu>
          </div>
          
          <div className="hidden sm:block w-px h-6 bg-white/10" />
          
          <div className="flex items-center gap-1.5 rounded-md bg-black/20 px-2 py-1.5">
            {togglingId === flow.id && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-white/50" />
            )}
            <PillToggle
              checked={enabled}
              className={enabled ? "" : "is-off"}
              onChange={(event) => onToggleEnabled(event.target.checked)}
              disabled={togglingId === flow.id}
            />
          </div>
        </div>
      </div>

      {isEditing && (
        <div className="px-4 pb-4">
          <div className="card-separator mb-4" />
          <div className="grid gap-3">
            <FlowFormFields
              draft={simpleDraft}
              remaining={simpleRemaining}
              inputClassName="input bg-[#1f1f24]"
              errorMessage={simpleError}
              onDraftChange={onDraftChange}
              onClearError={onClearError}
              mixPresets={mixPresets}
              focusOptions={focusOptions}
              normalizeMixPercent={normalizeMixPercent}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button onClick={onCancel} className="btn btn-secondary btn-sm">
                Cancel
              </button>
              <FlipSaveButton
                disabled={!hasChanges}
                saving={isApplying}
                onClick={onApply}
                label="Save"
                savedLabel="Saved"
              />
            </div>
          </div>
        </div>
      )}

      {isTracksOpen && (
        <div className="px-4 pb-4">
          <div className="card-separator mb-4" />
          <FlowTracksPanel
            tracks={tracks}
            loading={tracksLoading}
            error={tracksError}
            onNavigateArtist={onNavigateArtist}
          />
        </div>
      )}
    </div>
  );
}

export function FlowTracksPanel({
  tracks,
  loading,
  error,
  emptyMessage = "No tracks generated for this flow yet.",
  editable = false,
  showStatus = false,
  hideFailedTracks = false,
  showFailedDetails = true,
  headerActions = null,
  deletingTrackId = null,
  onDeleteTrack,
  onNavigateArtist,
}) {
  const [queue, setQueue] = useState([]);
  const [currentTrackId, setCurrentTrackId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isShuffleEnabled, setIsShuffleEnabled] = useState(false);
  const [volume, setVolume] = useState(80);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [progressSnappingBack, setProgressSnappingBack] = useState(false);
  const lastVolumeRef = useRef(80);
  const progressResetTimeoutRef = useRef(null);
  const audioRef = useRef(null);

  const playableTracks = useMemo(
    () => tracks.filter((track) => track.status === "done" && track.streamUrl),
    [tracks],
  );

  const currentTrack = useMemo(
    () => playableTracks.find((track) => track.id === currentTrackId) || null,
    [playableTracks, currentTrackId],
  );
  const visibleTracks = useMemo(
    () =>
      hideFailedTracks
        ? tracks.filter((track) => track.status !== "failed")
        : tracks,
    [hideFailedTracks, tracks],
  );

  const startQueue = (trackIds) => {
    if (!trackIds.length) return;
    setQueue(trackIds);
    setCurrentTrackId(trackIds[0]);
  };

  const getOrderedIds = () => playableTracks.map((track) => track.id);

  const getShuffledIds = () => {
    const ids = getOrderedIds();
    const shuffled = [...ids];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

  const getPlaybackIds = () =>
    isShuffleEnabled ? getShuffledIds() : getOrderedIds();

  const resetProgress = (snap = false) => {
    if (progressResetTimeoutRef.current) {
      window.clearTimeout(progressResetTimeoutRef.current);
      progressResetTimeoutRef.current = null;
    }
    if (snap) {
      setProgressSnappingBack(true);
      setPlaybackProgress(0);
      progressResetTimeoutRef.current = window.setTimeout(() => {
        setProgressSnappingBack(false);
      }, 280);
      return;
    }
    setProgressSnappingBack(false);
    setPlaybackProgress(0);
  };

  const handlePrimaryPlay = () => {
    if (playableTracks.length === 0) return;
    const audio = audioRef.current;
    const hasCurrentPlayable = playableTracks.some((track) => track.id === currentTrackId);
    if (currentTrackId && hasCurrentPlayable) {
      if (isPlaying) {
        audio?.pause();
        return;
      }
      audio
        ?.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
      return;
    }
    const ids = getPlaybackIds();
    if (ids.length === 0) return;
    resetProgress();
    startQueue(ids);
  };

  const handlePrevious = () => {
    if (playableTracks.length === 0) return;
    if (!queue.length || !currentTrackId) {
      const ids = getPlaybackIds();
      if (ids.length === 0) return;
      resetProgress();
      startQueue(ids);
      return;
    }
    const currentIndex = queue.findIndex((id) => id === currentTrackId);
    if (currentIndex > 0) {
      resetProgress(true);
      setCurrentTrackId(queue[currentIndex - 1]);
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = 0;
    }
    resetProgress(true);
  };

  const handleNext = () => {
    if (playableTracks.length === 0) return;
    if (!queue.length || !currentTrackId) {
      const ids = getPlaybackIds();
      if (ids.length === 0) return;
      resetProgress();
      startQueue(ids);
      return;
    }
    const currentIndex = queue.findIndex((id) => id === currentTrackId);
    const nextId = currentIndex >= 0 ? queue[currentIndex + 1] : null;
    if (nextId) {
      resetProgress(true);
      setCurrentTrackId(nextId);
      return;
    }
    resetProgress(true);
    setIsPlaying(false);
    setCurrentTrackId(null);
    setQueue([]);
  };

  const handlePlayTrack = (track) => {
    if (!track?.streamUrl) return;
    if (currentTrackId === track.id && isPlaying) {
      audioRef.current?.pause();
      return;
    }
    setQueue([track.id]);
    resetProgress();
    setCurrentTrackId(track.id);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack?.streamUrl) return;
    audio.src = currentTrack.streamUrl;
    audio
      .play()
      .then(() => setIsPlaying(true))
      .catch(() => setIsPlaying(false));
  }, [currentTrack?.id, currentTrack?.streamUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = isMuted || volume <= 0;
    audio.volume = Math.min(Math.max(volume / 100, 0), 1);
  }, [volume, isMuted]);

  const handleVolumeChange = (nextValue) => {
    const nextVolume = Math.min(Math.max(Number(nextValue) || 0, 0), 100);
    setVolume(nextVolume);
    if (nextVolume > 0) {
      lastVolumeRef.current = nextVolume;
      setIsMuted(false);
      return;
    }
    setIsMuted(true);
  };

  const handleToggleMute = () => {
    if (isMuted || volume <= 0) {
      const restoredVolume = lastVolumeRef.current > 0 ? lastVolumeRef.current : 80;
      setVolume(restoredVolume);
      setIsMuted(false);
      return;
    }
    if (volume > 0) {
      lastVolumeRef.current = volume;
    }
    setIsMuted(true);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => {
      const duration = Number(audio.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        setPlaybackProgress(0);
        return;
      }
      setProgressSnappingBack(false);
      setPlaybackProgress(Math.min(Math.max(audio.currentTime / duration, 0), 1));
    };
    const handleEnded = () => {
      resetProgress(true);
      const currentIndex = queue.findIndex((id) => id === currentTrackId);
      const nextId = currentIndex >= 0 ? queue[currentIndex + 1] : null;
      if (nextId) {
        setCurrentTrackId(nextId);
        return;
      }
      setIsPlaying(false);
      setCurrentTrackId(null);
      setQueue([]);
    };
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);
    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
    };
  }, [queue, currentTrackId]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (progressResetTimeoutRef.current) {
        window.clearTimeout(progressResetTimeoutRef.current);
      }
      if (audio) {
        audio.pause();
        audio.src = "";
      }
    };
  }, []);

  return (
    <div className="rounded-lg border border-white/10 bg-[#211f27] overflow-hidden">
      <div className="relative bg-[#211f27] px-3 py-2.5 border-b border-white/10 flex items-center">
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center justify-center gap-2">
          <button
            onClick={handlePrevious}
            className="btn btn-secondary btn-sm px-2"
            disabled={playableTracks.length === 0}
            aria-label="Previous track"
          >
            <SkipBack className="w-4 h-4" />
          </button>
          <button
            onClick={handlePrimaryPlay}
            className="btn btn-primary btn-sm px-2"
            disabled={playableTracks.length === 0}
            aria-label={isPlaying ? "Pause playback" : "Start playback"}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={handleNext}
            className="btn btn-secondary btn-sm px-2"
            disabled={playableTracks.length === 0}
            aria-label="Next track"
          >
            <SkipForward className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsShuffleEnabled((prev) => !prev)}
            className="btn btn-secondary btn-sm px-2"
            aria-label={isShuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
            style={
              isShuffleEnabled
                ? { backgroundColor: "rgba(154, 168, 134, 0.3)", borderColor: "rgba(154, 168, 134, 0.65)" }
                : undefined
            }
          >
            <Shuffle className="w-4 h-4" />
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2 relative z-10">
          {headerActions}
          <button
            onClick={handleToggleMute}
            className="btn btn-ghost btn-xs px-1.5"
            aria-label={isMuted || volume <= 0 ? "Unmute" : "Mute"}
          >
            {isMuted || volume <= 0 ? (
              <VolumeX className="w-4 h-4 text-[#8b8b90]" />
            ) : (
              <Volume2 className="w-4 h-4 text-[#8b8b90]" />
            )}
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(event) => handleVolumeChange(event.target.value)}
            className="w-24 accent-[#9aa886]"
            aria-label="Track volume"
          />
        </div>
      </div>

      <div className="overflow-auto max-h-[55vh]">
        {loading && (
          <div className="p-6 flex items-center gap-2 text-[#c1c1c3]">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading tracks...
          </div>
        )}
        {!loading && error && (
          <div className="p-6 text-red-400 text-sm">{error}</div>
        )}
        {!loading && !error && visibleTracks.length === 0 && (
          <div className="p-6 text-[#c1c1c3] text-sm">
            {emptyMessage}
          </div>
        )}
        {!loading && !error && visibleTracks.length > 0 && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-20 bg-[#1c1b22]">
              <tr className="text-left text-[#8b8b90] uppercase text-xs tracking-wider">
                {showStatus ? <th className="px-3 py-2">Status</th> : null}
                <th className="px-3 py-2">Song</th>
                <th className="px-3 py-2">Artist</th>
                <th className="px-3 py-2">Album</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleTracks.map((track, index) => {
                const canPlay = track.status === "done" && !!track.streamUrl;
                const canDelete = editable && track.status === "done" && !!track.id;
                const isCurrent = track.id === currentTrackId;
                const progressWidth = `${Math.round(playbackProgress * 100)}%`;
                return (
                  <tr
                    key={track.id}
                    className={`border-t border-white/5 text-[#d6d6d8] relative overflow-hidden ${
                      index % 2 === 0 ? "bg-[#211f27]" : "bg-[#1c1b22]"
                    }`}
                    style={
                      isCurrent
                        ? {
                            backgroundImage: "linear-gradient(rgba(112, 126, 97, 0.55), rgba(112, 126, 97, 0.55))",
                            backgroundSize: `${progressWidth} 100%`,
                            backgroundRepeat: "no-repeat",
                            transition: progressSnappingBack
                              ? "background-size 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)"
                              : "background-size 0.1s linear",
                          }
                        : undefined
                    }
                  >
                    {showStatus ? (
                      <td className="px-3 py-2 align-top">
                        <TrackStatusBadge status={track.status} />
                      </td>
                    ) : null}
                    <td className="px-3 py-2">{track.trackName}</td>
                    <td className="px-3 py-2">{track.artistName}</td>
                    <td className="px-3 py-2">
                      <div className="grid gap-1">
                        <span>{track.albumName || "Unknown Album"}</span>
                        {showFailedDetails && track.status === "failed" && track.error ? (
                          <span className="text-[11px] text-[#d49c9c]">
                            {track.error}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handlePlayTrack(track)}
                          className="btn btn-secondary btn-xs px-2"
                          disabled={!canPlay}
                        >
                          {isCurrent && isPlaying ? (
                            <Pause className="w-3.5 h-3.5" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                        </button>
                        {track.artistMbid ? (
                          <button
                            onClick={() => onNavigateArtist(track)}
                            className="btn btn-secondary btn-xs px-2"
                            aria-label={`Open artist details for ${track.artistName}`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                        {canDelete ? (
                          <button
                            onClick={() => onDeleteTrack?.(track)}
                            className="btn btn-ghost btn-xs px-2 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                            aria-label={`Remove ${track.trackName} from playlist`}
                            title={`Remove ${track.trackName} from playlist`}
                            disabled={deletingTrackId === track.id}
                          >
                            {deletingTrackId === track.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <audio ref={audioRef} preload="metadata" />
    </div>
  );
}

export function FlowEmptyState({ onCreate, creating }) {
  return (
    <div className="p-4 bg-card rounded-lg border border-white/5 text-sm text-[#c1c1c3]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>No flows yet. Start with your first flow.</span>
        <button
          onClick={onCreate}
          className="btn btn-primary btn-sm flex items-center gap-2"
          disabled={creating}
        >
          <FilePlus2 className="w-4 h-4" />
          {creating ? "Creating..." : "Create First Flow"}
        </button>
      </div>
    </div>
  );
}

export function SharedPlaylistCard({
  playlist,
  stats,
  currentJob,
  artworkUrl,
  isEditing,
  isTrackEditing,
  isTracksOpen,
  tracks,
  tracksLoading,
  tracksError,
  nameDraft,
  nameError,
  isApplyingName,
  isApplyingTracks,
  deletingId,
  onToggleEditing,
  onNameChange,
  onCancelEdit,
  onApplyEdit,
  onToggleTrackEditing,
  onSaveTracks,
  onDelete,
  onExport,
  onViewTracks,
  onNavigateArtist,
  retryCyclePaused,
  retryCycleScheduled,
  retryActionInFlight,
  onSetRetryCyclePaused,
}) {
  const trackEditorRef = useRef(null);
  const pending = Number(stats?.pending || 0);
  const downloading = Number(stats?.downloading || 0);
  const done = Number(stats?.done || 0);
  const failed = Number(stats?.failed || 0);
  const total = Math.max(Number(playlist?.trackCount || 0), pending + downloading + done);
  const progressPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const waitingForRetryCycle =
    retryCycleScheduled === true &&
    pending === 0 &&
    downloading === 0 &&
    done < Number(playlist?.trackCount || 0);
  const isCurrentJob =
    currentJob?.playlistType === playlist.id &&
    currentJob?.artistName &&
    currentJob?.trackName;

  return (
    <div className="overflow-visible rounded-lg border border-white/5 bg-card">
      <div className="flex flex-col gap-4 px-4 py-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1 flex gap-4">
          <PlaylistArtworkThumb artworkUrl={artworkUrl} name={playlist.name} />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-black/25 px-3.5 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-[#d6e5c8]">
                Playlist
              </span>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-[#c6c6cb]">
                {playlist.trackCount} tracks
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 min-w-0">
                {isEditing ? (
                  <input
                    type="text"
                    className="input input-sm h-9 w-full max-w-md bg-[#1c1b22] text-base font-medium text-white"
                    value={nameDraft ?? ""}
                    onChange={(event) => onNameChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onApplyEdit();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        onCancelEdit();
                      }
                    }}
                    aria-label={`Edit ${playlist.name} name`}
                  />
                ) : (
                  <h3 className="truncate text-base font-medium text-white">
                    {playlist.name}
                  </h3>
                )}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={isEditing ? onApplyEdit : onToggleEditing}
                    className={`btn ${isEditing ? "btn-primary" : "btn-ghost"} btn-xs px-2`}
                    aria-label={isEditing ? `Save ${playlist.name}` : `Edit ${playlist.name}`}
                    title={isEditing ? `Save ${playlist.name}` : `Edit ${playlist.name}`}
                    disabled={isApplyingName}
                  >
                    {isApplyingName ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isEditing ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Pencil className="w-3.5 h-3.5" />
                    )}
                  </button>
                  {isEditing ? (
                    <button
                      type="button"
                      onClick={onCancelEdit}
                      className="btn btn-ghost btn-xs px-2"
                      aria-label={`Cancel editing ${playlist.name}`}
                      title={`Cancel editing ${playlist.name}`}
                      disabled={isApplyingName}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
              {nameError ? (
                <p className="text-xs text-red-400">
                  {nameError}
                </p>
              ) : null}
              {isCurrentJob ? (
                <p className="truncate text-xs text-[#9ed3a1]">
                  Downloading {currentJob.trackName}
                </p>
              ) : null}
              {waitingForRetryCycle ? (
                <p className="text-xs text-[#d8c78e]">
                  Waiting for next retry cycle
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[#707e61] transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#c7ccc7]">
                <span>{progressPct}% complete</span>
                <span className="text-white/25">•</span>
                <span>Pending {pending}</span>
                <span className="text-white/25">•</span>
                <span>Downloading {downloading}</span>
                <span className="text-white/25">•</span>
                <span>Done {done}</span>
                <span className="text-white/25">•</span>
                <span>Stalled {failed}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onViewTracks}
              className={`btn ${isTracksOpen ? "btn-primary" : "btn-secondary"} btn-sm gap-2`}
              aria-label={isTracksOpen ? `Close ${playlist.name} tracks` : `View ${playlist.name} tracks`}
              title={isTracksOpen ? `Close ${playlist.name} tracks` : `View ${playlist.name} tracks`}
              aria-pressed={isTracksOpen}
            >
              <ListMusic className="w-4 h-4" />
              <span className="hidden sm:inline">Tracks</span>
            </button>
            <MoreMenu>
              <button
                type="button"
                onClick={onExport}
                className="w-full text-left px-3 py-2.5 text-sm text-[#d6d6d8] hover:bg-white/10 hover:text-white flex items-center gap-2.5"
              >
                <Download className="w-4 h-4" />
                Download JSON
              </button>
              <div className="my-1 border-t border-white/10" />
              <button
                type="button"
                onClick={() => onSetRetryCyclePaused?.(!retryCyclePaused)}
                className="w-full text-left px-3 py-2.5 text-sm text-[#d6d6d8] hover:bg-white/10 hover:text-white flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={retryActionInFlight}
              >
                {retryActionInFlight ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : retryCyclePaused ? (
                  <Play className="w-4 h-4" />
                ) : (
                  <Pause className="w-4 h-4" />
                )}
                {retryCyclePaused ? "Resume Retry Cycle" : "Pause Retry Cycle"}
              </button>
              <div className="my-1 border-t border-white/10" />
              <button
                type="button"
                onClick={onDelete}
                className="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 flex items-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={deletingId === playlist.id}
              >
                {deletingId === playlist.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete Playlist
              </button>
            </MoreMenu>
          </div>
        </div>
      </div>

      {isTracksOpen && (
        <div className="px-4 pb-4">
          <div className="card-separator mb-4" />
          {isTrackEditing ? (
            <SharedPlaylistTrackEditor
              ref={trackEditorRef}
              tracks={tracks}
              loading={tracksLoading}
              error={tracksError}
              saving={isApplyingTracks}
              headerActions={
                <>
                  <button
                    type="button"
                    onClick={onToggleTrackEditing}
                    className="btn btn-ghost btn-xs p-2"
                    aria-label={`Cancel editing ${playlist.name} tracklist`}
                    title={`Cancel editing ${playlist.name} tracklist`}
                    disabled={isApplyingTracks}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const result = await trackEditorRef.current?.save?.();
                      if (result === "unchanged") {
                        onToggleTrackEditing();
                      }
                    }}
                    className="btn btn-primary btn-xs p-2"
                    aria-label={`Save ${playlist.name} tracklist`}
                    title={`Save ${playlist.name} tracklist`}
                    disabled={isApplyingTracks}
                  >
                    {isApplyingTracks ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                  </button>
                </>
              }
              onSave={onSaveTracks}
            />
          ) : (
            <FlowTracksPanel
              tracks={tracks}
              loading={tracksLoading}
              error={tracksError}
              emptyMessage="No tracks in this static playlist yet."
              editable={false}
              showStatus={true}
              hideFailedTracks={true}
              showFailedDetails={false}
              headerActions={
                <button
                  type="button"
                  onClick={async () => {
                    if (isTrackEditing) {
                      const result = await trackEditorRef.current?.save?.();
                      if (result === "unchanged") {
                        onToggleTrackEditing();
                      }
                      return;
                    }
                    onToggleTrackEditing();
                  }}
                  className={`btn ${isTrackEditing ? "btn-primary" : "btn-secondary"} btn-xs p-2`}
                  aria-label={isTrackEditing ? `Save ${playlist.name} tracklist` : `Edit ${playlist.name} tracklist`}
                  title={isTrackEditing ? `Save ${playlist.name} tracklist` : `Edit ${playlist.name} tracklist`}
                  disabled={isApplyingTracks}
                >
                  {isApplyingTracks ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : isTrackEditing ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Pencil className="w-3.5 h-3.5" />
                  )}
                </button>
              }
              onNavigateArtist={onNavigateArtist}
            />
          )}
        </div>
      )}
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
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.78)" }}
      onClick={importing ? undefined : onCancel}
    >
      <div
        className="mx-4 w-full max-w-3xl overflow-hidden rounded-lg border border-white/5 bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-white/10 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-[0.2em] text-[#dbe6cf]">
                Import Playlist
              </div>
              <h3 className="text-lg font-semibold text-white">
                {importReview.fileName || "Selected playlist file"}
              </h3>
              <p className="text-sm text-[#bcc4b4]">
                {flows.length} {flows.length === 1 ? "playlist" : "playlists"} detected. Imports stay separate from weekly flows and queue their own downloads.
              </p>
            </div>
            <div className="rounded-full bg-black/25 px-3 py-1 text-sm text-[#dbe6cf]">
              JSON import
            </div>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-auto px-5 py-4">
          <div className="grid gap-3">
            {flows.map((flow, index) => {
              const trackCount = Number(flow?.tracks?.length || flow?.trackCount || 0);
              const previewTracks = Array.isArray(flow?.tracks) ? flow.tracks.slice(0, 3) : [];
              return (
                <div
                  key={`${flow?.name || "flow"}-${index}`}
                  className="rounded-lg border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-medium text-white">
                      {flow?.name || `Playlist ${index + 1}`}
                    </h4>
                    <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-[#c6c6cb]">
                      {trackCount} tracks
                    </span>
                    {flow?.sourceName ? (
                      <span className="rounded-full bg-black/25 px-2 py-0.5 text-[11px] text-[#dce8d0]">
                        From {flow.sourceName}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3">
                    <label className="mb-1 block text-[11px] uppercase tracking-[0.16em] text-[#90988b]">
                      Playlist Name
                    </label>
                    <input
                      type="text"
                      value={flow?.importName ?? flow?.name ?? ""}
                      onChange={(event) => onNameChange?.(index, event.target.value)}
                      placeholder={`Playlist ${index + 1}`}
                      disabled={importing}
                      className="w-full rounded-md border border-white/10 bg-black/35 px-3 py-2 text-sm text-white outline-none transition focus:border-[#90a07d] focus:ring-1 focus:ring-[#90a07d]"
                    />
                  </div>
                  <div className="mt-2 grid gap-1 text-xs text-[#aeb0b6]">
                    {previewTracks.map((track) => (
                      <span key={`${track.artistName}-${track.trackName}`}>
                        {track.artistName} — {track.trackName}
                      </span>
                    ))}
                    {trackCount > previewTracks.length ? (
                      <span className="text-[#89938a]">
                        +{trackCount - previewTracks.length} more tracks
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
          <p className="max-w-xl text-xs leading-5 text-[#9ca09f]">
            Supports exported playlist files, a single playlist object, or a raw array of tracks. Imported playlists stay separate from weekly flow refreshes.
          </p>
          <div className="flex items-center gap-2">
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
              className="btn btn-primary gap-2"
              disabled={importing || flows.length === 0}
            >
              {importing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.75)" }}
      onClick={onCancel}
    >
      <div className="card max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xl font-bold mb-2 text-white">
          Delete {confirmDelete.title}?
        </h3>
        <p className="text-[#c1c1c3] mb-6">
          {isShared
            ? "This removes the imported static playlist and any downloaded files tied to it."
            : "This removes the flow and its playlist setup. You can recreate it later."}
        </p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn btn-primary"
            style={{ backgroundColor: "#ef4444" }}
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.75)" }}
      onClick={onCancel}
    >
      <div className="card max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xl font-bold mb-2 text-white">
          Turn off {confirmDisable.title}?
        </h3>
        <p className="text-[#c1c1c3] mb-6">
          This pauses future runs. You can turn it back on anytime.
        </p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn btn-primary"
            style={{ backgroundColor: "#ef4444" }}
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.75)" }}
      onClick={onCancel}
    >
      <div className="card max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-xl font-bold mb-2 text-white">
          Stop all playlists?
        </h3>
        <p className="text-[#c1c1c3] mb-6">
          This pauses future runs. You can start them again anytime.
        </p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="btn btn-secondary">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn btn-primary"
            style={{ backgroundColor: "#ef4444" }}
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
  const [hoveredConcurrencyIndex, setHoveredConcurrencyIndex] = useState(null);
  const [hoveredFormatIndex, setHoveredFormatIndex] = useState(null);
  const concurrencyTabsRef = useRef(null);
  const concurrencyActiveBubbleRef = useRef(null);
  const concurrencyHoverBubbleRef = useRef(null);
  const concurrencyOptionRefs = useRef({});
  const formatTabsRef = useRef(null);
  const formatActiveBubbleRef = useRef(null);
  const formatHoverBubbleRef = useRef(null);
  const formatOptionRefs = useRef({});

  useEffect(() => {
    if (!isOpen) return;
    const updateConcurrencyActiveBubble = () => {
      if (!concurrencyTabsRef.current || !concurrencyActiveBubbleRef.current) {
        return;
      }
      const activeIndex = FLOW_WORKER_CONCURRENCY_OPTIONS.findIndex(
        (value) => value === settings.concurrency,
      );
      if (activeIndex === -1) {
        concurrencyActiveBubbleRef.current.style.opacity = "0";
        return;
      }
      const activeOptionEl = concurrencyOptionRefs.current[activeIndex];
      if (!activeOptionEl) {
        setTimeout(updateConcurrencyActiveBubble, 50);
        return;
      }
      const tabsRect = concurrencyTabsRef.current.getBoundingClientRect();
      const tabRect = activeOptionEl.getBoundingClientRect();
      concurrencyActiveBubbleRef.current.style.left = `${tabRect.left - tabsRect.left}px`;
      concurrencyActiveBubbleRef.current.style.top = `${tabRect.top - tabsRect.top}px`;
      concurrencyActiveBubbleRef.current.style.width = `${tabRect.width}px`;
      concurrencyActiveBubbleRef.current.style.height = `${tabRect.height}px`;
      concurrencyActiveBubbleRef.current.style.opacity = "1";
    };
    const timeoutId = setTimeout(updateConcurrencyActiveBubble, 10);
    window.addEventListener("resize", updateConcurrencyActiveBubble);
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("resize", updateConcurrencyActiveBubble);
    };
  }, [isOpen, settings.concurrency]);

  useEffect(() => {
    if (!isOpen) return;
    const updateConcurrencyHoverBubble = () => {
      if (!concurrencyTabsRef.current || !concurrencyHoverBubbleRef.current) {
        return;
      }
      if (hoveredConcurrencyIndex === null) {
        concurrencyHoverBubbleRef.current.style.left = "0px";
        concurrencyHoverBubbleRef.current.style.top = "0px";
        concurrencyHoverBubbleRef.current.style.width = "100%";
        concurrencyHoverBubbleRef.current.style.height = "100%";
        concurrencyHoverBubbleRef.current.style.opacity = "0.6";
        return;
      }
      const hoveredOptionEl = concurrencyOptionRefs.current[hoveredConcurrencyIndex];
      if (!hoveredOptionEl) return;
      const tabsRect = concurrencyTabsRef.current.getBoundingClientRect();
      const tabRect = hoveredOptionEl.getBoundingClientRect();
      concurrencyHoverBubbleRef.current.style.left = `${tabRect.left - tabsRect.left}px`;
      concurrencyHoverBubbleRef.current.style.top = `${tabRect.top - tabsRect.top}px`;
      concurrencyHoverBubbleRef.current.style.width = `${tabRect.width}px`;
      concurrencyHoverBubbleRef.current.style.height = `${tabRect.height}px`;
      concurrencyHoverBubbleRef.current.style.opacity = "1";
    };
    updateConcurrencyHoverBubble();
  }, [isOpen, hoveredConcurrencyIndex]);

  useEffect(() => {
    if (!isOpen) return;
    const updateFormatActiveBubble = () => {
      if (!formatTabsRef.current || !formatActiveBubbleRef.current) {
        return;
      }
      const activeIndex = FLOW_WORKER_FORMAT_OPTIONS.findIndex(
        (option) => option.id === settings.preferredFormat,
      );
      if (activeIndex === -1) {
        formatActiveBubbleRef.current.style.opacity = "0";
        return;
      }
      const activeOptionEl = formatOptionRefs.current[activeIndex];
      if (!activeOptionEl) {
        setTimeout(updateFormatActiveBubble, 50);
        return;
      }
      const tabsRect = formatTabsRef.current.getBoundingClientRect();
      const tabRect = activeOptionEl.getBoundingClientRect();
      formatActiveBubbleRef.current.style.left = `${tabRect.left - tabsRect.left}px`;
      formatActiveBubbleRef.current.style.top = `${tabRect.top - tabsRect.top}px`;
      formatActiveBubbleRef.current.style.width = `${tabRect.width}px`;
      formatActiveBubbleRef.current.style.height = `${tabRect.height}px`;
      formatActiveBubbleRef.current.style.opacity = "1";
    };
    const timeoutId = setTimeout(updateFormatActiveBubble, 10);
    window.addEventListener("resize", updateFormatActiveBubble);
    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("resize", updateFormatActiveBubble);
    };
  }, [isOpen, settings.preferredFormat]);

  useEffect(() => {
    if (!isOpen) return;
    const updateFormatHoverBubble = () => {
      if (!formatTabsRef.current || !formatHoverBubbleRef.current) {
        return;
      }
      if (hoveredFormatIndex === null) {
        formatHoverBubbleRef.current.style.left = "0px";
        formatHoverBubbleRef.current.style.top = "0px";
        formatHoverBubbleRef.current.style.width = "100%";
        formatHoverBubbleRef.current.style.height = "100%";
        formatHoverBubbleRef.current.style.opacity = "0.6";
        return;
      }
      const hoveredOptionEl = formatOptionRefs.current[hoveredFormatIndex];
      if (!hoveredOptionEl) return;
      const tabsRect = formatTabsRef.current.getBoundingClientRect();
      const tabRect = hoveredOptionEl.getBoundingClientRect();
      formatHoverBubbleRef.current.style.left = `${tabRect.left - tabsRect.left}px`;
      formatHoverBubbleRef.current.style.top = `${tabRect.top - tabsRect.top}px`;
      formatHoverBubbleRef.current.style.width = `${tabRect.width}px`;
      formatHoverBubbleRef.current.style.height = `${tabRect.height}px`;
      formatHoverBubbleRef.current.style.opacity = "1";
    };
    updateFormatHoverBubble();
  }, [isOpen, hoveredFormatIndex]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.75)" }}
      onClick={onCancel}
    >
      <div className="card max-w-lg w-full mx-4 grid gap-5" onClick={(e) => e.stopPropagation()}>
        <div className="grid gap-1">
          <h3 className="text-xl font-bold text-white">Worker Settings</h3>
        </div>
        <div className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px] md:items-end">
            <div className="grid gap-1.5">
              <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
                Download Concurrency
              </label>
              <div
                ref={concurrencyTabsRef}
                className="relative p-1.5 inline-flex"
                style={{ backgroundColor: "#0f0f12" }}
                role="radiogroup"
                aria-label="Download concurrency"
              >
                <div
                  ref={concurrencyActiveBubbleRef}
                  className="absolute transition-all duration-300 ease-out z-10 opacity-0"
                  style={{ backgroundColor: "#211f27" }}
                />
                <div
                  ref={concurrencyHoverBubbleRef}
                  className="absolute transition-all duration-200 ease-out z-0"
                  style={{ backgroundColor: "#1a1a1e" }}
                />
                <div
                  className="relative flex gap-1"
                  onMouseLeave={() => setHoveredConcurrencyIndex(null)}
                >
                  {FLOW_WORKER_CONCURRENCY_OPTIONS.map((value, index) => (
                    <button
                      key={value}
                      ref={(el) => {
                        if (el) concurrencyOptionRefs.current[index] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={settings.concurrency === value}
                      onMouseEnter={() => setHoveredConcurrencyIndex(index)}
                      onClick={() =>
                        onChange((prev) => ({ ...prev, concurrency: value }))
                      }
                      className="relative z-20 flex items-center justify-center px-4 py-2.5 font-medium transition-all duration-200 text-sm"
                      style={{ color: "#fff" }}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
                Retry Cycle
              </label>
              <div className="relative">
                <select
                  value={settings.retryCycleMinutes}
                  onChange={(event) =>
                    onChange((prev) => ({
                      ...prev,
                      retryCycleMinutes: Number(event.target.value),
                    }))
                  }
                  className="h-[52px] w-full appearance-none rounded-md border border-white/10 bg-black/20 pl-3 pr-12 text-sm text-white outline-none transition focus:border-[#90a07d] focus:ring-1 focus:ring-[#90a07d]"
                >
                  {FLOW_WORKER_RETRY_CYCLE_OPTIONS.map((option) => (
                    <option
                      key={option.minutes}
                      value={option.minutes}
                      className="bg-[#131419] text-white"
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white" />
              </div>
            </div>
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
              Preferred Format
            </label>
            <div className="flex items-stretch gap-2">
              <div
                ref={formatTabsRef}
                className="relative p-1.5 flex-1 min-w-0"
                style={{ backgroundColor: "#0f0f12" }}
              >
                <div
                  ref={formatActiveBubbleRef}
                  className="absolute transition-all duration-300 ease-out z-10 opacity-0"
                  style={{ backgroundColor: "#211f27" }}
                />
                <div
                  ref={formatHoverBubbleRef}
                  className="absolute transition-all duration-200 ease-out z-0"
                  style={{ backgroundColor: "#1a1a1e" }}
                />
                <div
                  className="relative flex gap-1"
                  onMouseLeave={() => setHoveredFormatIndex(null)}
                >
                  {FLOW_WORKER_FORMAT_OPTIONS.map((option, index) => (
                    <button
                      key={option.id}
                      ref={(el) => {
                        if (el) formatOptionRefs.current[index] = el;
                      }}
                      type="button"
                      onMouseEnter={() => setHoveredFormatIndex(index)}
                      onClick={() =>
                        onChange((prev) => ({
                          ...prev,
                          preferredFormat: option.id,
                        }))
                      }
                      className="relative z-20 flex items-center justify-center px-4 py-2.5 font-medium transition-all duration-200 text-sm"
                      style={{ color: "#fff" }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex min-w-[100px] items-center justify-end rounded-md border border-white/10 bg-black/20 px-3 py-2">
                <div className="grid gap-0.5 pr-3">
                  <span className="text-sm font-medium text-white">Strict</span>
                </div>
                <PillToggle
                  checked={settings.preferredFormatStrict === true}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    onChange((prev) => ({
                      ...prev,
                      preferredFormatStrict: checked,
                    }));
                  }}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="btn btn-secondary" disabled={saving}>
            Cancel
          </button>
          <FlipSaveButton
            disabled={!hasChanges}
            saving={saving}
            onClick={onSave}
            label="Save"
            savedLabel="Saved"
          />
        </div>
      </div>
    </div>
  );
}
