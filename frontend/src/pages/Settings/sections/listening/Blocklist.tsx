import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";
import { parseResponse } from "hono/client";
import { Search } from "../../../../components/icons";
import { DotLoader } from "../../../../components/DotLoader";
import ArtistImage from "../../../../components/ArtistImage";
import { useArtistTasteFeedback } from "../../../../hooks/useArtistTasteFeedback";
import { useBlockedGenres } from "../../../../hooks/useBlockedGenres";
import { discoveryClient } from "../../../../utils/api/clients/discovery.ts";
import { searchLibrary, searchUnified } from "../../../../utils/api/endpoints/search.ts";
import { buildBlocklistArtistSuggestions } from "../../../../utils/blocklistSearch.ts";
import { formatDate } from "../../../../utils/dateTime.ts";
import { plural } from "../../../../utils/monitoringRules.ts";
import { SettingsGroup, SettingsPage, type ServiceStatus } from "../../SettingsLayout";

type BlocklistKind = "artists" | "genres";
type ArtistSuggestion = ReturnType<typeof buildBlocklistArtistSuggestions>[number];
type Suggestion =
  | { kind: "artist"; key: string; artist: ArtistSuggestion }
  | { kind: "genre"; key: string; genre: string };

const NO_SUGGESTIONS = { query: "", items: [] };

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const artistKey = (artist: { id?: string | number | null; name?: string | null }) =>
  String(artist.id || artist.name?.toLowerCase() || "");

const blockedOn = (value: string | number | null | undefined) => {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `Blocked ${formatDate(date, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })}`;
};

const typedSuggestion = (kind: BlocklistKind, typed: string): Suggestion =>
  kind === "genres"
    ? { kind: "genre", key: typed, genre: typed }
    : { kind: "artist", key: typed.toLowerCase(), artist: { id: null, name: typed } };

async function findSuggestions(kind: BlocklistKind, query: string): Promise<Suggestion[]> {
  if (kind === "genres") {
    const { tags } = await parseResponse(
      discoveryClient.tags.$get({ query: { q: query, limit: "6", genres: "1" } }),
    );
    return tags.map((genre) => ({ kind: "genre", key: genre, genre }));
  }
  const [catalog, library] = await Promise.allSettled([
    searchUnified(query, { limit: 6 }),
    searchLibrary(query, { limit: 6 }),
  ]);
  if (catalog.status === "rejected" && library.status === "rejected") throw catalog.reason;
  return buildBlocklistArtistSuggestions({
    catalog: catalog.status === "fulfilled" ? catalog.value : null,
    library: library.status === "fulfilled" ? library.value : null,
  }).map((artist) => ({ kind: "artist", key: artistKey(artist), artist }));
}

function useBlockedArtists() {
  const { feedbackList, submitFeedback, isLoading } = useArtistTasteFeedback();
  const blockedArtists = useMemo(
    () =>
      feedbackList
        .filter((entry) => entry?.action === "block_artist")
        .sort((a, b) => Number(new Date(b.createdAt ?? 0)) - Number(new Date(a.createdAt ?? 0))),
    [feedbackList],
  );
  return { blockedArtists, submitFeedback, isLoading };
}

export function useBlocklistStatus(): ServiceStatus | null {
  const artists = useBlockedArtists();
  const genres = useBlockedGenres();
  if (artists.isLoading || genres.isLoading) return null;
  const parts = [
    artists.blockedArtists.length ? plural(artists.blockedArtists.length, "artist") : null,
    genres.blockedGenres.length ? plural(genres.blockedGenres.length, "genre") : null,
  ].filter((part) => part !== null);
  return parts.length ? { label: parts.join(", ") } : { label: "Nothing blocked", tone: "muted" };
}

function BlockSearch({
  kind,
  placeholder,
  pending,
  hide,
  onBlock,
}: {
  kind: BlocklistKind;
  placeholder: string;
  pending: string | null;
  hide?: (suggestion: Suggestion) => boolean;
  onBlock: (suggestion: Suggestion) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<{ query: string; items: Suggestion[] }>(
    NO_SUGGESTIONS,
  );
  const [searching, setSearching] = useState(false);

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
        const next = await findSuggestions(kind, trimmed);
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
  }, [query, kind]);

  const typed = query.trim().replace(/^#/, "");
  const visible = hide ? suggestions.items.filter((item) => !hide(item)) : suggestions.items;
  const enterTarget = kind === "artists" && suggestions.query === typed ? visible[0] : undefined;

  const clear = () => {
    setQuery("");
    setSuggestions(NO_SUGGESTIONS);
  };

  const block = async (suggestion: Suggestion) => {
    if (await onBlock(suggestion)) clear();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (typed) void block(enterTarget ?? typedSuggestion(kind, typed));
  };

  return (
    <div>
      <form className="blocklist__search" role="search" onSubmit={submit} aria-busy={searching}>
        <label className="blocklist__field">
          <Search className="artist-icon-sm" aria-hidden="true" />
          <input
            type="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") clear();
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            autoComplete="off"
          />
          {searching ? <DotLoader size="sm" label="Searching" /> : null}
        </label>
        {visible.length > 0 ? (
          <div className="blocklist__suggestions" onMouseDown={(event) => event.preventDefault()}>
            {visible.map((suggestion) => {
              const label =
                suggestion.kind === "artist" ? suggestion.artist.name : `#${suggestion.genre}`;
              return (
                <button
                  type="button"
                  key={suggestion.key}
                  className={`artist-menu-item${suggestion === enterTarget ? " is-active" : ""}`}
                  onClick={() => void block(suggestion)}
                  disabled={pending === suggestion.key}
                  aria-label={`Block ${label}`}
                >
                  <span className="artist-menu-item__main">
                    {suggestion.kind === "artist" ? (
                      <span className="blocklist__thumb blocklist__thumb--sm">
                        <ArtistImage
                          mbid={
                            MBID_PATTERN.test(String(suggestion.artist.id))
                              ? suggestion.artist.id
                              : null
                          }
                          artistName={suggestion.artist.name}
                          alt=""
                          className="blocklist__image"
                          showLoading={false}
                          sizes="1.75rem"
                        />
                      </span>
                    ) : (
                      <span
                        className="blocklist__thumb blocklist__thumb--sm blocklist__thumb--genre"
                        aria-hidden="true"
                      >
                        #
                      </span>
                    )}
                    {suggestion.kind === "artist" ? suggestion.artist.name : suggestion.genre}
                  </span>
                  <span className="blocklist__hint">Block</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </form>
    </div>
  );
}

export function BlocklistDetail() {
  const { blockedArtists, submitFeedback, isLoading: artistsLoading } = useBlockedArtists();
  const {
    blockedGenres,
    isGenreBlocked,
    setGenreBlocked,
    pendingGenre,
    isLoading: genresLoading,
  } = useBlockedGenres();
  const [pendingArtist, setPendingArtist] = useState<string | null>(null);

  const blockArtist = async (artist: { id?: string | number | null; name?: string | null }) => {
    if (!artist.name && !artist.id) return false;
    setPendingArtist(artistKey(artist));
    const saved = await submitFeedback(artist, "block_artist", { sourceContext: "blocklist" });
    setPendingArtist(null);
    return saved;
  };

  const block = (suggestion: Suggestion) =>
    suggestion.kind === "artist"
      ? blockArtist(suggestion.artist)
      : setGenreBlocked(suggestion.genre, true);

  const unblockArtist = async (entry: (typeof blockedArtists)[number]) => {
    setPendingArtist(artistKey({ id: entry.artistId, name: entry.artistName }));
    await submitFeedback({ id: entry.artistId, name: entry.artistName }, "block_artist", {
      isSelected: true,
      sourceContext: "blocklist",
    });
    setPendingArtist(null);
  };

  return (
    <SettingsPage title="Blocklist" back="Listening">
      <SettingsGroup
        title="Artists"
        actions={<span className="settings-group__meta">{blockedArtists.length}</span>}
      >
        <BlockSearch
          kind="artists"
          placeholder="Block an artist"
          pending={pendingArtist}
          onBlock={block}
        />
        {artistsLoading ? null : blockedArtists.length === 0 ? (
          <p className="settings-group__note">
            Blocked artists stay out of recommendations, radio, playlists, and flows. You can also
            block from any artist menu.
          </p>
        ) : (
          <ul className="blocklist__list">
            {blockedArtists.map((entry) => {
              const key = artistKey({ id: entry.artistId, name: entry.artistName });
              const name = entry.artistName || String(entry.artistId);
              const mbid = MBID_PATTERN.test(String(entry.artistId)) ? entry.artistId : null;
              const meta = blockedOn(entry.createdAt);
              return (
                <li className="blocklist__row" key={entry.id || key}>
                  <span className="blocklist__thumb">
                    <ArtistImage
                      mbid={mbid}
                      artistName={name}
                      alt=""
                      className="blocklist__image"
                      showLoading={false}
                      sizes="2rem"
                    />
                  </span>
                  <div className="blocklist__details">
                    {mbid ? (
                      <Link
                        to={`/artist/${mbid}`}
                        state={{ artistName: name }}
                        className="blocklist__name"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="blocklist__name">{name}</span>
                    )}
                    {meta ? <span className="blocklist__meta">{meta}</span> : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void unblockArtist(entry)}
                    disabled={pendingArtist === key}
                    aria-label={`Unblock ${name}`}
                  >
                    Unblock
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>
      <SettingsGroup
        title="Genres"
        actions={<span className="settings-group__meta">{blockedGenres.length}</span>}
      >
        <BlockSearch
          kind="genres"
          placeholder="Block a genre"
          pending={pendingGenre}
          hide={(suggestion) => suggestion.kind === "genre" && isGenreBlocked(suggestion.genre)}
          onBlock={block}
        />
        {genresLoading ? null : blockedGenres.length === 0 ? (
          <p className="settings-group__note">
            Blocked genres stay out of recommendations and flows. Artists in your Library are never
            hidden.
          </p>
        ) : (
          <ul className="blocklist__list">
            {blockedGenres.map((genre) => (
              <li className="blocklist__row" key={genre}>
                <span className="blocklist__thumb blocklist__thumb--genre" aria-hidden="true">
                  #
                </span>
                <span className="blocklist__name">{genre}</span>
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
      </SettingsGroup>
    </SettingsPage>
  );
}
