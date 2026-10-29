import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { parseResponse } from "hono/client";
import { Ban, Search, X } from "../components/icons";
import { DotLoader } from "../components/DotLoader";
import TooltipButton from "../components/TooltipButton";
import { useBlockedGenres } from "../hooks/useBlockedGenres";
import { discoveryClient } from "../utils/api/clients/discovery.ts";

export function BlocklistGenres() {
  const { blockedGenres, isGenreBlocked, setGenreBlocked, pendingGenre } = useBlockedGenres();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const trimmed = query.trim().replace(/^#/, "");
    if (trimmed.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const { tags } = await parseResponse(
          discoveryClient.tags.$get({ query: { q: trimmed, limit: "6", genres: "1" } }),
        );
        if (!cancelled) setSuggestions(tags);
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const blockGenre = async (genre: string) => {
    if (await setGenreBlocked(genre, true)) {
      setQuery("");
      setSuggestions([]);
    }
  };

  const submitTypedGenre = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim().replace(/^#/, "");
    if (trimmed) void blockGenre(trimmed);
  };

  const visibleSuggestions = suggestions.filter((genre) => !isGenreBlocked(genre));

  return (
    <>
      <section className="blocklist-page__panel">
        <div className="blocklist-page__panel-title">
          <h2>Block a genre</h2>
        </div>
        <form
          className="blocklist-page__search-form"
          onSubmit={submitTypedGenre}
          aria-busy={searching}
        >
          <label className="blocklist-page__search-label" htmlFor="blocklist-genre-search">
            Genre
          </label>
          <div className="blocklist-page__search">
            <Search className="artist-icon-sm" aria-hidden="true" />
            <input
              id="blocklist-genre-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search genres"
              aria-label="Search for a genre to block"
            />
            {searching ? <DotLoader size="sm" label="Searching" /> : null}
          </div>
        </form>
        {visibleSuggestions.length > 0 ? (
          <div className="blocklist-page__suggestions">
            {visibleSuggestions.map((genre) => (
              <button
                type="button"
                key={genre}
                onClick={() => blockGenre(genre)}
                disabled={pendingGenre === genre}
                className="blocklist-page__suggestion"
                aria-label={`Block #${genre}`}
              >
                <span>#{genre}</span>
                {pendingGenre === genre ? (
                  <DotLoader size="xs" label={null} />
                ) : (
                  <Ban className="artist-icon-xs" />
                )}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="blocklist-page__panel">
        <div className="blocklist-page__panel-title">
          <h2>Blocked genres ({blockedGenres.length})</h2>
        </div>
        {blockedGenres.length > 0 ? (
          <div className="blocklist-page__list">
            {blockedGenres.map((genre) => (
              <div className="blocklist-page__item" key={genre}>
                <span>#{genre}</span>
                <TooltipButton
                  type="button"
                  onClick={() => setGenreBlocked(genre, false)}
                  disabled={pendingGenre === genre}
                  className="btn btn-icon-square"
                  aria-label={`Unblock #${genre}`}
                  title="Unblock genre"
                >
                  {pendingGenre === genre ? (
                    <DotLoader size="xs" label={null} />
                  ) : (
                    <X className="artist-icon-xs" />
                  )}
                </TooltipButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="blocklist-page__empty">No blocked genres.</p>
        )}
      </section>
    </>
  );
}
