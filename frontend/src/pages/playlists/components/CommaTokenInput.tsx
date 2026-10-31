import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { parseResponse } from "hono/client";
import { discoveryClient } from "../../../utils/api/clients/discovery.ts";
import { searchUnified } from "../../../utils/api/endpoints/search.ts";
import { getTagColor } from "../../ArtistDetails/utils";
import { useDebouncedTask } from "../../../hooks/useDebouncedTask";

import { Search } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";

interface FocusSuggestion {
  label: string;
  meta: string;
}

interface FocusSuggestionObject {
  label?: unknown;
  name?: unknown;
  title?: unknown;
  meta?: unknown;
  sourceLabel?: unknown;
}

type FocusEntry = string | number | FocusSuggestionObject | null | undefined;

const FLOW_FOCUS_SUGGESTION_DEBOUNCE_MS = 250;
const FLOW_FOCUS_SUGGESTION_LIMIT = 8;

function getCommaTokenInputState(
  value: string | null | undefined,
  options: { commitAll?: boolean } = {},
) {
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

function dedupeTokenEntries(entries: string[]) {
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

function buildCommaTokenInputValue(committed: string[], pending: string | null | undefined) {
  const safeCommitted = dedupeTokenEntries(committed);
  const rawPending = String(pending ?? "").replace(/^\s+/, "");
  const normalizedPending = rawPending.trim();
  if (safeCommitted.length === 0) return rawPending.replace(/^\s+/, "");
  if (!normalizedPending) return `${safeCommitted.join(", ")}, `;
  return `${safeCommitted.join(", ")}, ${rawPending}`;
}

function normalizeFocusSuggestion(entry: FocusEntry, fallbackMeta = ""): FocusSuggestion | null {
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

function dedupeFocusSuggestions(
  entries: FocusEntry[] | null | undefined,
  existingEntries: string[] = [],
) {
  const seen = new Set(
    (Array.isArray(existingEntries) ? existingEntries : [])
      .map((entry) =>
        String(entry || "")
          .trim()
          .toLowerCase(),
      )
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

export async function fetchFlowTagSuggestions(query: string, existingEntries: string[] = []) {
  const prefix = query.startsWith("-") ? "-" : "";
  const data = await parseResponse(
    discoveryClient.tags.$get({
      query: {
        q: query.slice(prefix.length).trim() || undefined,
        limit: String(FLOW_FOCUS_SUGGESTION_LIMIT),
      },
    }),
  );
  return dedupeFocusSuggestions(
    data.tags.map((tag) => ({
      label: `${prefix}${tag}`,
      meta: "Tag",
    })),
    existingEntries,
  );
}

export async function fetchFlowArtistSuggestions(query: string, existingEntries: string[] = []) {
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
      label: artist!.name,
      meta: artist!.source === "brainzmash" ? "Metadata" : "Artist",
    })),
    existingEntries,
  );
}

export function CommaTokenInput({
  value,
  placeholder,
  onChange,
  fetchSuggestions,
  suggestionLabel = "suggestions",
  excludable = false,
}: {
  value?: string | null;
  placeholder?: string;
  excludable?: boolean;
  onChange: (value: string) => void;
  fetchSuggestions?: (query: string, existingEntries: string[]) => Promise<FocusSuggestion[]>;
  suggestionLabel?: string;
}) {
  const [isFocused, setIsFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<FocusSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
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
    (suggestion: FocusSuggestion) => {
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

    scheduleSuggest(async (isCurrent: () => boolean) => {
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
  }, [
    closeSuggestions,
    committed,
    fetchSuggestions,
    isFocused,
    pending,
    scheduleSuggest,
    cancelSuggest,
  ]);

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
              setHighlightedIndex((index) => (index < suggestions.length - 1 ? index + 1 : 0));
              return;
            }
            if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((index) => (index > 0 ? index - 1 : suggestions.length - 1));
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
          {committed.map((entry) =>
            excludable && entry.startsWith("-") ? (
              <span
                key={`${placeholder}-${entry}`}
                className="flow-page__token-chip flow-page__token-chip--excluded"
              >
                {entry}
              </span>
            ) : (
              <span
                key={`${placeholder}-${entry}`}
                className="flow-page__token-chip"
                style={{ backgroundColor: getTagColor(entry) }}
              >
                {entry}
              </span>
            ),
          )}
          {committed.length === 0 ? (
            <span className="flow-page__token-placeholder">{placeholder}</span>
          ) : null}
          {pending ? <span className="flow-page__token-pending">{pending}</span> : null}
        </div>
      )}
      {isFocused && (loadingSuggestions || suggestions.length > 0) ? (
        <div className="flow-page__token-suggestions" role="listbox" aria-label={suggestionLabel}>
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
                <span className="flow-page__token-suggestion-label">{suggestion.label}</span>
              </span>
              {suggestion.meta ? (
                <span className="flow-page__token-suggestion-meta">{suggestion.meta}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
