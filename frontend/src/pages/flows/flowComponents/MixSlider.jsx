import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { getTagSuggestions } from "../../../utils/api/endpoints/discovery.js";
import { searchUnified } from "../../../utils/api/endpoints/search.js";
import { TAG_COLORS } from "../../discoverUtils";
import { getTagColor } from "../../ArtistDetails/utils";
import { useDebouncedTask } from "../../../hooks/useDebouncedTask";

import { Search } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
const SOURCE_MIX_COLORS = {
  discover: TAG_COLORS[10],
  mix: TAG_COLORS[4],
  trending: TAG_COLORS[12],
  focus: TAG_COLORS[2],
};

export const SOURCE_MIX_OPTIONS = [
  { key: "discover", label: "Discover" },
  { key: "mix", label: "Library" },
  { key: "trending", label: "Trending" },
  { key: "focus", label: "Focus" },
];

export const WEEKDAY_OPTIONS = [
  { id: 0, short: "Su", full: "Sunday" },
  { id: 1, short: "M", full: "Monday" },
  { id: 2, short: "T", full: "Tuesday" },
  { id: 3, short: "W", full: "Wednesday" },
  { id: 4, short: "Th", full: "Thursday" },
  { id: 5, short: "F", full: "Friday" },
  { id: 6, short: "S", full: "Saturday" },
];

const FLOW_FOCUS_SUGGESTION_DEBOUNCE_MS = 250;
const FLOW_FOCUS_SUGGESTION_LIMIT = 8;
export const SCHEDULE_HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => {
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

  const updateBoundaryValue = useCallback(
    (handleIndex, percent) => {
      if (activeKeys.length < 2) return;
      const leftKey = activeKeys[handleIndex];
      const rightKey = activeKeys[handleIndex + 1];
      if (!leftKey || !rightKey) return;
      const prefixStart = activeKeys
        .slice(0, handleIndex)
        .reduce((sum, key) => sum + Number(normalized[key] || 0), 0);
      const pairTotal =
        Number(normalized[leftKey] || 0) + Number(normalized[rightKey] || 0);
      const minimumShare = Math.min(1, pairTotal / 2);
      const nextLeft = Math.min(
        Math.max(percent - prefixStart, minimumShare),
        pairTotal - minimumShare,
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

  const updateFromClientX = useCallback(
    (clientX, handleIndex) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clampedX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
      const percent = rect.width > 0 ? (clampedX / rect.width) * 100 : 0;
      updateBoundaryValue(handleIndex, percent);
    },
    [updateBoundaryValue],
  );

  const startDrag = (event, handle) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const handleRect = event.currentTarget.getBoundingClientRect();
    const grabOffset = event.clientX - (handleRect.left + handleRect.width / 2);
    dragRef.current = {
      handle,
      pointerId: event.pointerId,
      target: event.currentTarget,
      grabOffset,
    };
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    updateFromClientX(event.clientX - grabOffset, handle);
  };

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      updateFromClientX(
        event.clientX - dragRef.current.grabOffset,
        dragRef.current.handle,
      );
    };
    const handleUp = (event) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      const { target, pointerId } = dragRef.current;
      dragRef.current = null;
      if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [updateFromClientX]);

  const handleHandleKeyDown = (event, handle) => {
    const step = event.shiftKey ? 5 : 1;
    let nextPosition = handle.position;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") nextPosition -= step;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") nextPosition += step;
    else if (event.key === "PageDown") nextPosition -= 10;
    else if (event.key === "PageUp") nextPosition += 10;
    else if (event.key === "Home") nextPosition = handle.minimum;
    else if (event.key === "End") nextPosition = handle.maximum;
    else return;
    event.preventDefault();
    updateBoundaryValue(handle.handleIndex, nextPosition);
  };

  const labelMinPercent = 6;
  const cumulativePositions = [];
  let runningPosition = 0;
  for (const key of activeKeys) {
    runningPosition += Number(normalized[key] || 0);
    cumulativePositions.push(runningPosition);
  }
  const handles = cumulativePositions
    .slice(0, -1)
    .map((position, index) => {
      const leftKey = activeKeys[index];
      const rightKey = activeKeys[index + 1];
      const leftLabel = SOURCE_MIX_OPTIONS.find((option) => option.key === leftKey)?.label || "source";
      const rightLabel = SOURCE_MIX_OPTIONS.find((option) => option.key === rightKey)?.label || "source";
      const prefixStart = activeKeys
        .slice(0, index)
        .reduce((sum, key) => sum + Number(normalized[key] || 0), 0);
      const pairTotal = Number(normalized[leftKey] || 0) + Number(normalized[rightKey] || 0);
      const minimumShare = Math.min(1, pairTotal / 2);
      return {
        key: `boundary-${index}`,
        position,
        visualPosition: Math.min(Math.max(position, 1.5), 98.5),
        minimum: prefixStart + minimumShare,
        maximum: prefixStart + pairTotal - minimumShare,
        handleIndex: index,
        ariaLabel: `Adjust ${leftLabel} and ${rightLabel} mix`,
        ariaValueText: `${leftLabel} ${Math.round(Number(normalized[leftKey] || 0))}%, ${rightLabel} ${Math.round(Number(normalized[rightKey] || 0))}%`,
      };
    });

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
                  "--flow-mix-color": SOURCE_MIX_COLORS[key],
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
          <div
            key={handle.key}
            onPointerDown={(event) => startDrag(event, handle.handleIndex)}
            onKeyDown={(event) => handleHandleKeyDown(event, handle)}
            className="flow-page__mix-handle"
            style={{ left: `${handle.visualPosition}%` }}
            role="slider"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-valuemin={Math.round(handle.minimum)}
            aria-valuemax={Math.round(handle.maximum)}
            aria-valuenow={Math.round(handle.position)}
            aria-valuetext={handle.ariaValueText}
            aria-label={handle.ariaLabel}
          >
            <span className="flow-page__mix-handle-thumb" />
          </div>
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
  const committedParts = dedupeTokenEntries(parts.slice(0, -1));
  if (endsWithComma || commitAll) {
    return {
      committed: dedupeTokenEntries(parts),
      pending: "",
    };
  }
  const pending = String(parts[parts.length - 1] ?? "").replace(/^\s+/, "");
  return {
    committed: committedParts,
    pending,
  };
}

function dedupeTokenEntries(entries) {
  const seen = new Set();
  return entries
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildCommaTokenInputValue(committed, pending) {
  const safeCommitted = dedupeTokenEntries(committed);
  const rawPending = String(pending ?? "").replace(/^\s+/, "");
  const normalizedPending = rawPending.trim();
  if (safeCommitted.length === 0) return rawPending.replace(/^\s+/, "");
  if (!normalizedPending) return `${safeCommitted.join(", ")}, `;
  return `${safeCommitted.join(", ")}, ${rawPending}`;
}

function normalizeFocusSuggestion(entry, fallbackMeta = "") {
  if (typeof entry === "string" || typeof entry === "number") {
    const label = String(entry).trim();
    return label ? { label, meta: fallbackMeta } : null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const label = String(entry.label || entry.name || entry.title || "").trim();
  if (!label) return null;
  return {
    label,
    meta: String(entry.meta || entry.sourceLabel || fallbackMeta || "").trim(),
  };
}

function dedupeFocusSuggestions(entries, existingEntries = []) {
  const seen = new Set(
    (Array.isArray(existingEntries) ? existingEntries : [])
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeFocusSuggestion(entry);
    const key = normalized?.label.toLowerCase();
    if (!normalized || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export async function fetchFlowTagSuggestions(query, existingEntries = []) {
  const data = await getTagSuggestions(query, FLOW_FOCUS_SUGGESTION_LIMIT);
  return dedupeFocusSuggestions(
    (Array.isArray(data?.tags) ? data.tags : []).map((tag) => ({
      label: tag,
      meta: "Tag",
    })),
    existingEntries,
  );
}

export async function fetchFlowArtistSuggestions(query, existingEntries = []) {
  const data = await searchUnified(query, {
    mode: "suggest",
    limit: FLOW_FOCUS_SUGGESTION_LIMIT,
  });
  const artistCandidates = [
    data?.top?.type === "artist" ? data.top : null,
    ...(Array.isArray(data?.catalog?.artists) ? data.catalog.artists : []),
  ].filter(Boolean);
  return dedupeFocusSuggestions(
    artistCandidates.map((artist) => ({
      label: artist.name,
      meta: artist.source === "brainzmash" ? "Metadata" : "Artist",
    })),
    existingEntries,
  );
}

export function getFocusDraftValidation(draft, normalizeMixPercent) {
  const normalizedMix = normalizeMixPercent(draft?.mix);
  const focusEnabled = Number(normalizedMix.focus || 0) > 0;
  const hasFocusFilters =
    getCommaTokenInputState(draft?.includeTags, { commitAll: true }).committed.length > 0 ||
    getCommaTokenInputState(draft?.includeRelatedArtists, { commitAll: true }).committed.length > 0;
  return {
    focusEnabled,
    focusValidationError:
      focusEnabled && !hasFocusFilters
        ? "Focus needs at least one genre tag or related artist."
        : "",
  };
}

export function CommaTokenInput({
  value,
  placeholder,
  onChange,
  fetchSuggestions,
  suggestionLabel = "suggestions",
}) {
  const [isFocused, setIsFocused] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef(null);
  const { schedule: scheduleSuggest, cancel: cancelSuggest } = useDebouncedTask();
  const { committed, pending } = useMemo(
    () =>
      getCommaTokenInputState(value, {
        commitAll: !isFocused,
      }),
    [isFocused, value],
  );
  const rawValue = String(value ?? "");

  const commitNormalizedValue = useCallback(() => {
    const nextCommitted = getCommaTokenInputState(rawValue, {
      commitAll: true,
    }).committed;
    onChange(buildCommaTokenInputValue(nextCommitted, ""));
  }, [onChange, rawValue]);

  const closeSuggestions = useCallback(() => {
    setSuggestions([]);
    setLoadingSuggestions(false);
    setHighlightedIndex(-1);
  }, []);

  const selectSuggestion = useCallback(
    (suggestion) => {
      const normalized = normalizeFocusSuggestion(suggestion);
      if (!normalized) return;
      const nextCommitted = [...committed, normalized.label];
      onChange(buildCommaTokenInputValue(nextCommitted, ""));
      closeSuggestions();
      window.setTimeout(() => inputRef.current?.focus(), 0);
    },
    [closeSuggestions, committed, onChange],
  );

  useEffect(() => {
    if (!isFocused) return;
    inputRef.current?.focus();
  }, [isFocused]);

  useEffect(() => {
    if (!isFocused || typeof fetchSuggestions !== "function") {
      cancelSuggest();
      closeSuggestions();
      return;
    }

    const query = pending.trim();
    if (query.length < 2) {
      cancelSuggest();
      closeSuggestions();
      return;
    }

    scheduleSuggest(async (isCurrent) => {
      setLoadingSuggestions(true);
      try {
        const nextSuggestions = await fetchSuggestions(query, committed);
        if (!isCurrent()) return;
        setSuggestions(dedupeFocusSuggestions(nextSuggestions, committed));
        setHighlightedIndex(-1);
      } catch {
        if (isCurrent()) {
          setSuggestions([]);
          setHighlightedIndex(-1);
        }
      } finally {
        if (isCurrent()) {
          setLoadingSuggestions(false);
        }
      }
    }, FLOW_FOCUS_SUGGESTION_DEBOUNCE_MS);

    return cancelSuggest;
  }, [closeSuggestions, committed, fetchSuggestions, isFocused, pending, scheduleSuggest, cancelSuggest]);

  return (
    <div
      className={`flow-page__token-input${isFocused ? " is-focused" : ""}`}
      onClick={() => setIsFocused(true)}
    >
      {isFocused ? (
        <input
          ref={inputRef}
          type="text"
          className="flow-page__token-input-field"
          placeholder={placeholder}
          value={rawValue}
          aria-label={suggestionLabel}
          aria-expanded={suggestions.length > 0 || loadingSuggestions}
          aria-haspopup="listbox"
          onFocus={() => setIsFocused(true)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((index) =>
                index < suggestions.length - 1 ? index + 1 : 0,
              );
              return;
            }
            if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((index) =>
                index > 0 ? index - 1 : suggestions.length - 1,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              closeSuggestions();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (highlightedIndex >= 0 && suggestions[highlightedIndex]) {
                selectSuggestion(suggestions[highlightedIndex]);
                return;
              }
              commitNormalizedValue();
              inputRef.current?.blur();
            }
          }}
          onBlur={() => {
            setIsFocused(false);
            closeSuggestions();
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
      {isFocused && (loadingSuggestions || suggestions.length > 0) ? (
        <div
          className="flow-page__token-suggestions"
          role="listbox"
          aria-label={suggestionLabel}
        >
          {loadingSuggestions && suggestions.length === 0 ? (
            <div className="flow-page__token-suggestion flow-page__token-suggestion--loading">
              <DotLoader size="sm" label={null} />
              Searching
            </div>
          ) : null}
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.label}-${index}`}
              type="button"
              role="option"
              aria-selected={highlightedIndex === index}
              className={`flow-page__token-suggestion${highlightedIndex === index ? " is-highlighted" : ""}`}
              onMouseEnter={() => setHighlightedIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                selectSuggestion(suggestion);
              }}
            >
              <span className="flow-page__token-suggestion-main">
                <Search className="artist-icon-sm" />
                <span className="flow-page__token-suggestion-label">
                  {suggestion.label}
                </span>
              </span>
              {suggestion.meta ? (
                <span className="flow-page__token-suggestion-meta">
                  {suggestion.meta}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
