import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Search } from "lucide-react";
import { ModalShell } from "../../components/PlaylistModals.jsx";
import { DotLoader } from "../../components/DotLoader.jsx";
import {
  downloadManualMissingSearchResult,
  getManualMissingSearchSources,
  searchMissingTrackManually,
} from "../../utils/api/endpoints/playlists.js";
import { queryKeys } from "../../queryClient.js";

const errorMessage = (error, fallback) =>
  error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback;

export default function ManualMissingSearchModal({
  job,
  mode = "missing",
  playlistId = null,
  onClose,
  onQueued,
}) {
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [actionError, setActionError] = useState("");
  const searchRequestRef = useRef(0);
  const sourcesQuery = useQuery({
    queryKey: queryKeys.manualMissingSearchSources(job?.id, mode, playlistId),
    queryFn: ({ signal }) => getManualMissingSearchSources(job.id, { mode, playlistId, signal }),
    enabled: Boolean(job?.id),
    select: (data) => (Array.isArray(data?.sources) ? data.sources : []),
  });
  const sources = sourcesQuery.data ?? [];
  const loadingSources = sourcesQuery.isLoading;
  const sourceId = sources.some((source) => source.id === selectedSourceId)
    ? selectedSourceId
    : sources[0]?.id || "";
  const error = actionError ||
    (sourcesQuery.error ? errorMessage(sourcesQuery.error, "Could not load download clients") : "");

  useEffect(() => {
    searchRequestRef.current += 1;
    setSearching(false);
    setSearch(null);
    setSelectedId("");
    setActionError("");
    setSelectedSourceId("");
  }, [job?.id, mode, playlistId]);

  const selectedResult = useMemo(
    () => search?.results?.find((result) => result.id === selectedId) || null,
    [search, selectedId],
  );

  const runSearch = async () => {
    if (!job?.id || !sourceId || searching) return;
    const requestId = ++searchRequestRef.current;
    const jobId = job.id;
    setSearching(true);
    setSearch(null);
    setSelectedId("");
    setActionError("");
    try {
      const result = await searchMissingTrackManually(jobId, sourceId, { mode, playlistId });
      if (searchRequestRef.current === requestId) setSearch(result);
    } catch (requestError) {
      if (searchRequestRef.current === requestId) {
        setActionError(errorMessage(requestError, "The selected download client could not be searched"));
      }
    } finally {
      if (searchRequestRef.current === requestId) setSearching(false);
    }
  };

  const queueSelection = async () => {
    if (!job?.id || !search?.sessionId || !selectedResult || submitting) return;
    setSubmitting(true);
    setActionError("");
    try {
      await downloadManualMissingSearchResult(job.id, search.sessionId, selectedResult.id);
      onQueued?.(job);
      onClose?.();
    } catch (requestError) {
      setActionError(errorMessage(requestError, "The selected result could not be queued"));
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
      title={mode === "replacement" ? "Manual replacement" : "Manual search"}
      description={`${job?.artistName || "Unknown artist"} · ${job?.trackName || "Unknown track"}`}
      onClose={onClose}
      disableClose={submitting}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-sm manual-search-modal__action" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm manual-search-modal__action" onClick={queueSelection} disabled={!selectedResult || busy}>
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
              setSelectedSourceId(event.target.value);
              setSearch(null);
              setSelectedId("");
              setActionError("");
            }}
            disabled={busy}
          >
            {sources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
          </select>
          <button type="button" className="btn btn-secondary btn-sm manual-search-modal__action" onClick={runSearch} disabled={!sourceId || busy}>
            {searching ? <DotLoader size="sm" label={null} /> : <Search className="artist-icon-sm" aria-hidden="true" />}
            Search
          </button>
        </div>
      </div>

      {loadingSources ? <div className="manual-search-modal__loading"><DotLoader size="lg" label="Loading clients" /></div> : null}
      {!loadingSources && !error && sources.length === 0 ? <p className="manual-search-modal__empty">Set up a download client in Settings → Download clients.</p> : null}
      {error ? <p className="artist-error-text" role="alert">{error}</p> : null}
      {search && resultCount === 0 ? <p className="manual-search-modal__empty">No results from this client.</p> : null}
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
