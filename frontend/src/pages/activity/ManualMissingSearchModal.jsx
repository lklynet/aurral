import { useEffect, useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import { ModalShell } from "../../components/PlaylistModals.jsx";
import { DotLoader } from "../../components/DotLoader.jsx";
import {
  downloadManualMissingSearchResult,
  getManualMissingSearchSources,
  searchMissingTrackManually,
} from "../../utils/api/endpoints/playlists.js";

const errorMessage = (error, fallback) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback;

export default function ManualMissingSearchModal({ job, onClose, onQueued }) {
  const [sources, setSources] = useState([]);
  const [sourceId, setSourceId] = useState("");
  const [loadingSources, setLoadingSources] = useState(false);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!job?.id) return;
    let active = true;
    setSources([]);
    setSourceId("");
    setSearch(null);
    setSelectedId("");
    setError("");
    setLoadingSources(true);
    getManualMissingSearchSources(job.id)
      .then((data) => {
        if (!active) return;
        const available = Array.isArray(data?.sources) ? data.sources : [];
        setSources(available);
        setSourceId(available[0]?.id || "");
      })
      .catch((requestError) => {
        if (active) setError(errorMessage(requestError, "Could not load download clients"));
      })
      .finally(() => {
        if (active) setLoadingSources(false);
      });
    return () => { active = false; };
  }, [job?.id]);

  const selectedResult = useMemo(
    () => search?.results?.find((result) => result.id === selectedId) || null,
    [search, selectedId],
  );

  const runSearch = async () => {
    if (!job?.id || !sourceId || searching) return;
    setSearching(true);
    setSearch(null);
    setSelectedId("");
    setError("");
    try {
      const result = await searchMissingTrackManually(job.id, sourceId);
      setSearch(result);
    } catch (requestError) {
      setError(errorMessage(requestError, "The selected download client could not be searched"));
    } finally {
      setSearching(false);
    }
  };

  const queueSelection = async () => {
    if (!job?.id || !search?.sessionId || !selectedResult || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await downloadManualMissingSearchResult(job.id, search.sessionId, selectedResult.id);
      onQueued?.(job);
      onClose?.();
    } catch (requestError) {
      setError(errorMessage(requestError, "The selected result could not be queued"));
    } finally {
      setSubmitting(false);
    }
  };

  const busy = loadingSources || searching || submitting;
  const resultCount = Array.isArray(search?.results) ? search.results.length : 0;

  return (
    <ModalShell
      open={Boolean(job)}
      className="manual-search-modal"
      title="Manual search"
      description={`${job?.artistName || "Unknown artist"} · ${job?.trackName || "Unknown track"}`}
      onClose={onClose}
      disableClose={submitting}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={queueSelection} disabled={!selectedResult || busy}>
            {submitting ? <DotLoader size="sm" label={null} /> : <Download className="artist-icon-sm" aria-hidden="true" />}
            Download selected
          </button>
        </>
      }
    >
      <div className="manual-search-modal__controls">
        <label className="artist-field-label" htmlFor="manual-search-source">Download client</label>
        <div className="manual-search-modal__source-row">
          <select
            id="manual-search-source"
            className="input input--tall"
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setSearch(null);
              setSelectedId("");
              setError("");
            }}
            disabled={busy}
          >
            {sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
          </select>
          <button type="button" className="btn btn-secondary btn-sm" onClick={runSearch} disabled={!sourceId || busy}>
            {searching ? <DotLoader size="sm" label={null} /> : <Search className="artist-icon-sm" aria-hidden="true" />}
            Search
          </button>
        </div>
      </div>

      {loadingSources ? <div className="manual-search-modal__loading"><DotLoader size="lg" label="Loading clients" /></div> : null}
      {!loadingSources && sources.length === 0 ? <p className="manual-search-modal__empty">No download clients are currently configured and enabled.</p> : null}
      {error ? <p className="artist-error-text" role="alert">{error}</p> : null}
      {search && resultCount === 0 ? <p className="manual-search-modal__empty">No results were returned by this client.</p> : null}
      {resultCount > 0 ? (
        <fieldset className="manual-search-results">
          <legend>{resultCount} result{resultCount === 1 ? "" : "s"}</legend>
          <div className="manual-search-results__list">
            {search.results.map((result) => (
              <label className={`manual-search-result${selectedId === result.id ? " is-selected" : ""}`} key={result.id}>
                <input type="radio" name="manual-search-result" value={result.id} checked={selectedId === result.id} onChange={() => setSelectedId(result.id)} />
                <span className="manual-search-result__content">
                  <strong>{result.title}</strong>
                  {result.subtitle ? <span>{result.subtitle}</span> : null}
                  {result.details?.length ? <small>{result.details.join(" · ")}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
    </ModalShell>
  );
}
