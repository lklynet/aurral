import { useEffect, useMemo, useState } from "react";
import { Ban, Search, X } from "lucide-react";
import { DotLoader } from "../components/DotLoader";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { searchUnified } from "../utils/api/endpoints/search.js";
import { buildBlocklistArtistSuggestions } from "../utils/blocklistSearch.js";

const normalizeArtist = (artist) => ({
  id: artist?.id || artist?.mbid || artist?.foreignArtistId || null,
  name: String(artist?.name || artist?.artistName || "").trim(),
});

export default function BlocklistPage() {
  useDocumentTitle("Blocked Artists");
  const { feedbackList, submitFeedback } = useArtistTasteFeedback();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [pendingKey, setPendingKey] = useState("");

  const blockedArtists = useMemo(
    () => feedbackList.filter((entry) => entry?.action === "block_artist"),
    [feedbackList],
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await searchUnified(trimmed, { mode: "suggest", limit: 6 });
        if (cancelled) return;
        setSuggestions(buildBlocklistArtistSuggestions(response));
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

  const blockArtist = async (artist) => {
    const normalized = normalizeArtist(artist);
    if (!normalized.name && !normalized.id) return;
    const key = normalized.id || normalized.name.toLowerCase();
    setPendingKey(key);
    const saved = await submitFeedback(normalized, "block_artist", {
      sourceContext: "blocklist",
    });
    setPendingKey("");
    if (saved) {
      setQuery("");
      setSuggestions([]);
    }
  };

  const unblockArtist = async (entry) => {
    const artist = { id: entry.artistId, name: entry.artistName };
    const key = entry.id || entry.artistId || entry.artistName;
    setPendingKey(key);
    await submitFeedback(artist, "block_artist", {
      isSelected: true,
      sourceContext: "blocklist",
    });
    setPendingKey("");
  };

  const submitTypedArtist = async (event) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    await blockArtist(suggestions[0] || { name: trimmed });
  };

  return (
    <div className="blocklist-page">
      <header className="blocklist-page__header">
        <div>
          <h1 className="page-title">Blocked Artists</h1>
          <p className="page-subtitle">
            These artists will not be recommended or downloaded into your playlists and flows.
          </p>
        </div>
      </header>

      <section className="blocklist-page__panel">
        <div className="blocklist-page__panel-title">
          <Ban className="artist-icon-sm" aria-hidden="true" />
          <h2>Block an artist</h2>
        </div>
        <form className="blocklist-page__search" onSubmit={submitTypedArtist}>
          <Search className="artist-icon-sm" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for an artist"
            aria-label="Search for an artist to block"
          />
          {searching ? <DotLoader size="sm" label={null} /> : null}
        </form>
        {suggestions.length > 0 ? (
          <div className="blocklist-page__suggestions">
            {suggestions.map((artist) => {
              const key = artist.id || artist.name.toLowerCase();
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => blockArtist(artist)}
                  disabled={pendingKey === key}
                  className="blocklist-page__suggestion"
                >
                  <span>{artist.name}</span>
                  {pendingKey === key ? (
                    <DotLoader size="xs" label={null} />
                  ) : (
                    <Ban className="artist-icon-xs" />
                  )}
                </button>
              );
            })}
          </div>
        ) : null}
      </section>

      <section className="blocklist-page__panel">
        <div className="blocklist-page__panel-title">
          <h2>Blocked ({blockedArtists.length})</h2>
        </div>
        {blockedArtists.length > 0 ? (
          <div className="blocklist-page__list">
            {blockedArtists.map((entry) => {
              const key = entry.id || entry.artistId || entry.artistName;
              return (
                <div className="blocklist-page__item" key={key}>
                  <span>{entry.artistName || entry.artistId}</span>
                  <button
                    type="button"
                    onClick={() => unblockArtist(entry)}
                    disabled={pendingKey === key}
                    className="btn btn-icon-square"
                    aria-label={`Unblock ${entry.artistName || entry.artistId}`}
                    title="Unblock artist"
                  >
                    {pendingKey === key ? (
                      <DotLoader size="xs" label={null} />
                    ) : (
                      <X className="artist-icon-xs" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="blocklist-page__empty">You have not blocked any artists.</p>
        )}
      </section>
    </div>
  );
}
