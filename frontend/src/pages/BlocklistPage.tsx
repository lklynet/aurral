import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { parseResponse } from "hono/client";
import { Ban, Search } from "../components/icons";
import { DotLoader } from "../components/DotLoader";
import ArtistImage from "../components/ArtistImage";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { useBlockedGenres } from "../hooks/useBlockedGenres";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { discoveryClient } from "../utils/api/clients/discovery.ts";
import { searchLibrary, searchUnified } from "../utils/api/endpoints/search.ts";
import { buildBlocklistArtistSuggestions } from "../utils/blocklistSearch.ts";
import { formatDate } from "../utils/dateTime.ts";

type BlocklistTab = "artists" | "genres";
type ArtistSuggestion = ReturnType<typeof buildBlocklistArtistSuggestions>[number];
type Suggestion =
  | { kind: "artist"; key: string; artist: ArtistSuggestion }
  | { kind: "genre"; key: string; genre: string };

const NO_SUGGESTIONS = { query: "", items: [] };

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TABS = [
  { id: "artists", label: "Artists", placeholder: "Block an artist" },
  { id: "genres", label: "Genres", placeholder: "Block a genre" },
] as const;

const EMPTY_MESSAGES: Record<BlocklistTab, string> = {
  artists:
    "Blocked artists stay out of recommendations, playlists, and flows. You can also block from any artist menu.",
  genres:
    "Blocked genres stay out of recommendations and flows. You can also block from any genre page.",
};

const artistKey = (artist: { id?: string | number | null; name?: string | null }) =>
  String(artist.id || artist.name?.toLowerCase() || "");

const blockedOn = (value: string | number | null | undefined) => {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `Blocked ${formatDate(date, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })}`;
};

async function findSuggestions(tab: BlocklistTab, query: string): Promise<Suggestion[]> {
  if (tab === "genres") {
    const { tags } = await parseResponse(
      discoveryClient.tags.$get({ query: { q: query, limit: "6", genres: "1" } }),
    );
    return tags.map((genre) => ({ kind: "genre", key: genre, genre }));
  }
  const [catalog, library] = await Promise.allSettled([
    searchUnified(query, { mode: "suggest", limit: 6 }),
    searchLibrary(query, { limit: 6 }),
  ]);
  if (catalog.status === "rejected" && library.status === "rejected") throw catalog.reason;
  return buildBlocklistArtistSuggestions({
    ...(catalog.status === "fulfilled" ? catalog.value : {}),
    library: library.status === "fulfilled" ? library.value : null,
  }).map((artist) => ({ kind: "artist", key: artistKey(artist), artist }));
}

export default function BlocklistPage() {
  useDocumentTitle("Blocklist");
  const [searchParams] = useSearchParams();
  const tab: BlocklistTab = searchParams.get("tab") === "genres" ? "genres" : "artists";
  const { feedbackList, submitFeedback, isLoading: artistsLoading } = useArtistTasteFeedback();
  const {
    blockedGenres,
    isGenreBlocked,
    setGenreBlocked,
    pendingGenre,
    isLoading: genresLoading,
  } = useBlockedGenres();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<{ query: string; items: Suggestion[] }>(
    NO_SUGGESTIONS,
  );
  const [searching, setSearching] = useState(false);
  const [pendingArtist, setPendingArtist] = useState("");

  const blockedArtists = useMemo(
    () =>
      feedbackList
        .filter((entry) => entry?.action === "block_artist")
        .sort((a, b) => Number(new Date(b.createdAt ?? 0)) - Number(new Date(a.createdAt ?? 0))),
    [feedbackList],
  );

  useEffect(() => {
    const trimmed = query.trim().replace(/^#/, "");
    if (trimmed.length < 2) {
      setSuggestions(NO_SUGGESTIONS);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const next = await findSuggestions(tab, trimmed);
        if (!cancelled) setSuggestions({ query: trimmed, items: next });
      } catch {
        if (!cancelled) setSuggestions(NO_SUGGESTIONS);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tab]);

  const typed = query.trim().replace(/^#/, "");
  const visibleSuggestions = suggestions.items.filter(
    (suggestion) => suggestion.kind === "artist" || !isGenreBlocked(suggestion.genre),
  );
  const enterTarget =
    tab === "artists" && suggestions.query === typed ? visibleSuggestions[0] : undefined;

  const clearSearch = () => {
    setQuery("");
    setSuggestions(NO_SUGGESTIONS);
  };

  const blockArtist = async (artist: ArtistSuggestion) => {
    if (!artist.name && !artist.id) return;
    setPendingArtist(artistKey(artist));
    const saved = await submitFeedback(artist, "block_artist", { sourceContext: "blocklist" });
    setPendingArtist("");
    if (saved) clearSearch();
  };

  const blockGenre = async (genre: string) => {
    if (await setGenreBlocked(genre, true)) clearSearch();
  };

  const block = (suggestion: Suggestion) =>
    suggestion.kind === "artist" ? blockArtist(suggestion.artist) : blockGenre(suggestion.genre);

  const submitTyped = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!typed) return;
    if (tab === "genres") void blockGenre(typed);
    else if (enterTarget) void block(enterTarget);
    else void blockArtist({ id: null, name: typed });
  };

  const counts: Record<BlocklistTab, number> = {
    artists: blockedArtists.length,
    genres: blockedGenres.length,
  };
  const loading = tab === "artists" ? artistsLoading : genresLoading;
  const activeTab = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  return (
    <div className="blocklist-page">
      <header className="blocklist-page__header">
        <h1 className="page-title">Blocklist</h1>
        <form
          className="blocklist-page__search"
          role="search"
          onSubmit={submitTyped}
          aria-busy={searching}
        >
          <label className="blocklist-page__field">
            <Search className="artist-icon-sm" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") clearSearch();
              }}
              placeholder={activeTab.placeholder}
              aria-label={activeTab.placeholder}
              autoComplete="off"
            />
            {searching ? <DotLoader size="sm" label="Searching" /> : null}
          </label>
          {visibleSuggestions.length > 0 ? (
            <div
              className="blocklist-page__suggestions"
              onMouseDown={(event) => event.preventDefault()}
            >
              {visibleSuggestions.map((suggestion) => {
                const pending =
                  suggestion.kind === "artist"
                    ? pendingArtist === suggestion.key
                    : pendingGenre === suggestion.genre;
                const label =
                  suggestion.kind === "artist" ? suggestion.artist.name : `#${suggestion.genre}`;
                return (
                  <button
                    type="button"
                    key={suggestion.key}
                    className={`artist-menu-item${suggestion === enterTarget ? " is-active" : ""}`}
                    onClick={() => void block(suggestion)}
                    disabled={pending}
                    aria-label={`Block ${label}`}
                  >
                    <span className="artist-menu-item__main">
                      {suggestion.kind === "artist" ? (
                        <span className="blocklist-page__thumb blocklist-page__thumb--sm">
                          <ArtistImage
                            mbid={
                              MBID_PATTERN.test(String(suggestion.artist.id))
                                ? suggestion.artist.id
                                : null
                            }
                            artistName={suggestion.artist.name}
                            alt=""
                            className="blocklist-page__image"
                            showLoading={false}
                            sizes="1.75rem"
                          />
                        </span>
                      ) : (
                        <span
                          className="blocklist-page__thumb blocklist-page__thumb--sm blocklist-page__thumb--genre"
                          aria-hidden="true"
                        >
                          #
                        </span>
                      )}
                      {suggestion.kind === "artist" ? suggestion.artist.name : suggestion.genre}
                    </span>
                    <span className="blocklist-page__hint">Block</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </form>
      </header>

      <nav className="blocklist-page__tabs" aria-label="Blocklist">
        {TABS.map((entry) => (
          <Link
            key={entry.id}
            to={{ search: entry.id === "genres" ? "?tab=genres" : "" }}
            replace
            onClick={clearSearch}
            aria-current={tab === entry.id ? "page" : undefined}
            className={`blocklist-page__tab${tab === entry.id ? " is-active" : ""}`}
          >
            {entry.label}
            <span className="blocklist-page__count">{counts[entry.id]}</span>
          </Link>
        ))}
      </nav>

      <div>
        {loading ? null : counts[tab] === 0 ? (
          <div className="search-empty-panel">
            <div className="search-empty-panel__icon" aria-hidden="true">
              <Ban />
            </div>
            <h2 className="search-empty-panel__title">Nothing blocked</h2>
            <p className="search-empty-panel__message">{EMPTY_MESSAGES[tab]}</p>
          </div>
        ) : tab === "artists" ? (
          <ul className="blocklist-page__list">
            {blockedArtists.map((entry) => {
              const key = entry.id || entry.artistId || entry.artistName || "";
              const name = entry.artistName || String(entry.artistId);
              const mbid = MBID_PATTERN.test(String(entry.artistId)) ? entry.artistId : null;
              const meta = blockedOn(entry.createdAt);
              return (
                <li className="blocklist-page__row" key={key}>
                  <span className="blocklist-page__thumb">
                    <ArtistImage
                      mbid={mbid}
                      artistName={name}
                      alt=""
                      className="blocklist-page__image"
                      showLoading={false}
                      sizes="2.5rem"
                    />
                  </span>
                  <div className="blocklist-page__details">
                    {mbid ? (
                      <Link
                        to={`/artist/${mbid}`}
                        state={{ artistName: name }}
                        className="blocklist-page__name"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="blocklist-page__name">{name}</span>
                    )}
                    {meta ? <span className="blocklist-page__meta">{meta}</span> : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      setPendingArtist(String(key));
                      await submitFeedback(
                        { id: entry.artistId, name: entry.artistName },
                        "block_artist",
                        { isSelected: true, sourceContext: "blocklist" },
                      );
                      setPendingArtist("");
                    }}
                    disabled={pendingArtist === String(key)}
                    aria-label={`Unblock ${name}`}
                  >
                    Unblock
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="blocklist-page__list">
            {blockedGenres.map((genre) => (
              <li className="blocklist-page__row" key={genre}>
                <span
                  className="blocklist-page__thumb blocklist-page__thumb--genre"
                  aria-hidden="true"
                >
                  #
                </span>
                <span className="blocklist-page__name">{genre}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void setGenreBlocked(genre, false)}
                  disabled={pendingGenre === genre}
                  aria-label={`Unblock #${genre}`}
                >
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
