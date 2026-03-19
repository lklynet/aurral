import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import {
  Loader2,
  Clock,
  Trash2,
  Pencil,
  FilePlus2,
  ListMusic,
  Play,
  Pause,
  Shuffle,
  SkipBack,
  SkipForward,
  ExternalLink,
  Volume2,
  VolumeX,
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
  const clauses = [
    schedulePhrase,
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
        <div className="flex gap-4">
          <div className="flex-1 grid gap-1.5">
            <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
              Flow Name
            </label>
            <input
              type="text"
              className={inputClassName}
              value={draft.name}
              onChange={(event) => {
                const value = event.target.value;
                updateDraft((prev) => ({ ...prev, name: value }));
              }}
            />
          </div>
          <div className="w-24 grid gap-1.5">
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
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs uppercase tracking-wider text-[#8b8b90] font-medium">
            Update Days
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {WEEKDAY_OPTIONS.map((day) => {
              const checked = scheduleDays.includes(day.id);
              return (
                <label
                  key={day.id}
                  className={`inline-flex items-center rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
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
  const failed = Number(status?.stats?.failed || 0);
  const total = Number(status?.stats?.total || pending + downloading + done + failed);
  const processed = done + failed;
  const progressPct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const hintPhase = String(status?.hint?.phase || "").trim();
  const hintMessage = String(status?.hint?.message || "").trim();
  const baseSummaryMessage =
    runningCount > 0
      ? `Processing ${runningCount} ${runningCount === 1 ? "playlist" : "playlists"} (${pending} pending, ${done} completed)`
      : done > 0
        ? `No active processing (${done} completed${failed > 0 ? `, ${failed} failed` : ""})`
        : "No active processing";
  const hasCurrentJob =
    status?.worker?.currentJob?.artistName && status?.worker?.currentJob?.trackName;
  const hintLower = hintMessage.toLowerCase();
  const hintIsDownloadLike =
    hintLower.includes("download") || hintLower.includes("downloading");
  const isShuttingDown =
    !workerRunning &&
    !queueProcessing &&
    (hintPhase === "downloading" || hintIsDownloadLike);
  const shouldShowHint =
    hintMessage.length > 0 && !(hasCurrentJob && hintIsDownloadLike) && !isShuttingDown;
  const summaryMessage = isShuttingDown
    ? "Shutting down worker..."
    : hasCurrentJob
    ? "Downloading tracks"
    : shouldShowHint
      ? hintMessage
      : baseSummaryMessage;
  const hasPreparationSignal = queuePending > 0 || queueProcessing || (shouldShowHint && !workerRunning);
  const statusLabel = workerRunning
    ? "Running"
    : isShuttingDown
      ? "Shutting Down"
      : hasPreparationSignal
        ? "Preparing"
        : "Stopped";
  const statusBadgeClass =
    statusLabel === "Running"
      ? "badge-success"
      : statusLabel === "Shutting Down"
        ? "badge-secondary"
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
        {workerRunning || isShuttingDown ? (
          <Loader2 className="w-4 h-4 animate-spin text-[#9aa886]" />
        ) : (
          <Clock className="w-4 h-4 text-[#d0d0d4]" />
        )}
        <span className="text-[#e3e3e7]">{summaryMessage}</span>
        {failed > 0 ? (
          <span className="rounded-full border border-red-400/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-300">
            {failed} failed
          </span>
        ) : null}
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
            {failed > 0 ? (
              <>
                <span className="text-white/25">•</span>
                <span className="text-red-300">Failed <span>{failed}</span></span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FlowCard({
  flow,
  enabled,
  state,
  stats,
  currentJob,
  nextRun,
  isEditing,
  isTracksOpen,
  tracks,
  tracksLoading,
  tracksError,
  simpleDraft,
  simpleRemaining,
  simpleError,
  isApplying,
  hasChanges,
  togglingId,
  deletingId,
  onToggleEditing,
  onToggleEnabled,
  onDelete,
  onViewTracks,
  onNavigateArtist,
  onCancel,
  onApply,
  onDraftChange,
  onClearError,
  mixPresets,
  focusOptions,
  normalizeMixPercent,
}) {
  const processed = Number(stats?.done || 0) + Number(stats?.failed || 0);
  const total = Number(stats?.total || 0);
  const progressPct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const isCurrentJobForFlow =
    currentJob?.playlistType === flow.id &&
    currentJob?.artistName &&
    currentJob?.trackName;

  return (
    <div
      className={`bg-card rounded-lg border border-white/5 overflow-hidden transition-opacity ${
        enabled ? "opacity-100" : "opacity-50"
      }`}
    >
      <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="min-w-0 flex-1 grid gap-2.5">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-medium text-white truncate">
              {flow.name}
            </h3>
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#b5b5bc]">
            <span>{flow.size} tracks</span>
            {flow.deepDive && (
              <>
                <span className="text-white/10">•</span>
                <span>Deep dive</span>
              </>
            )}
            {enabled && nextRun && state === "idle" && (
              <>
                <span className="text-white/10">•</span>
                <span>Next: {nextRun}</span>
              </>
            )}
          </div>
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
                <span className="text-[#b5b5bc]">{processed}/{total} processed</span>
                {stats.failed > 0 ? (
                  <span className="text-red-300">{stats.failed} failed</span>
                ) : null}
              </div>
              {isCurrentJobForFlow ? (
                <div className="truncate text-xs text-[#9aa886]">
                  Downloading: {currentJob.artistName} - {currentJob.trackName}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 p-1">
            {isEditing && (
              <button
                onClick={onDelete}
                className="btn btn-sm btn-ghost px-2 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                aria-label="Delete flow"
                disabled={deletingId === flow.id}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onViewTracks}
              className="btn btn-secondary btn-sm px-2"
              aria-label={isTracksOpen ? `Close ${flow.name} tracks` : `View ${flow.name} tracks`}
            >
              <ListMusic className="w-4 h-4" />
            </button>
            <button
              onClick={onToggleEditing}
              className="btn btn-secondary btn-sm px-2"
              aria-label={isEditing ? "Close editor" : "Edit flow"}
            >
              <Pencil className="w-4 h-4" />
            </button>
          </div>
          
          <div className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
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
    <div className="rounded-lg border border-white/10 bg-[#1f1f24] overflow-hidden">
      <div className="relative px-3 py-2.5 border-b border-white/10 flex items-center">
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
        {!loading && !error && tracks.length === 0 && (
          <div className="p-6 text-[#c1c1c3] text-sm">
            No tracks generated for this flow yet.
          </div>
        )}
        {!loading && !error && tracks.length > 0 && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-20 bg-[#1c1b22]">
              <tr className="text-left text-[#8b8b90] uppercase text-xs tracking-wider">
                <th className="px-3 py-2">Song</th>
                <th className="px-3 py-2">Artist</th>
                <th className="px-3 py-2">Album</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((track, index) => {
                const canPlay = track.status === "done" && !!track.streamUrl;
                const isCurrent = track.id === currentTrackId;
                const progressWidth = `${Math.round(playbackProgress * 100)}%`;
                return (
                  <tr
                    key={track.id}
                    className={`border-t border-white/5 text-[#d6d6d8] relative overflow-hidden ${
                      index % 2 === 0 ? "bg-[#202027]/35" : "bg-[#181820]/75"
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
                    <td className="px-3 py-2">{track.trackName}</td>
                    <td className="px-3 py-2">{track.artistName}</td>
                    <td className="px-3 py-2">{track.albumName || "Unknown Album"}</td>
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
                        <button
                          onClick={() => onNavigateArtist(track)}
                          className="btn btn-secondary btn-xs px-2"
                          aria-label={`Open artist details for ${track.artistName}`}
                          disabled={!track.artistMbid}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
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

export function ConfirmDeleteModal({ confirmDelete, deletingId, onCancel, onConfirm }) {
  if (!confirmDelete) return null;

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
          This removes the flow and its playlist setup. You can recreate it later.
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
