import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  importShareLink,
  openShareLink,
  previewShareImport,
} from "../utils/api/endpoints/shareLinks.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { getApiErrorMessage } from "./onboardingUtils.tsx";
import { DotLoader } from "../components/DotLoader.tsx";
import { queryKeys } from "../queryClient.ts";
import "./ShareImportPage.css";

export default function ShareImportPage() {
  const [params, setParams] = useSearchParams();
  const sharedUrl = params.get("url") || "";
  const opening = params.get("action") === "open";
  useDocumentTitle(opening ? "Open share" : "Import share");
  const navigate = useNavigate();
  const [url, setUrl] = useState(sharedUrl);
  const queryClient = useQueryClient();
  const destination = useQuery({
    queryKey: ["share-open", sharedUrl],
    queryFn: () => openShareLink(sharedUrl),
    enabled: opening && Boolean(sharedUrl),
    retry: false,
  });
  useEffect(() => {
    if (opening && destination.data) navigate(destination.data.to, { replace: true });
  }, [opening, destination.data, navigate]);
  const preview = useQuery({
    queryKey: ["share-import", sharedUrl],
    queryFn: () => previewShareImport(sharedUrl),
    enabled: Boolean(sharedUrl) && !opening,
    retry: false,
    staleTime: 0,
  });
  const includeFiles = params.get("action") === "files" && preview.data?.canDownload === true;
  const submit = useMutation({
    mutationFn: () =>
      importShareLink(sharedUrl, includeFiles && preview.data?.canDownload === true),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.libraryPrefix }),
        queryClient.invalidateQueries({ queryKey: queryKeys.playlistStatus }),
      ]),
  });
  const data = url.trim() === sharedUrl ? preview.data : undefined;
  if (opening) {
    return (
      <div className="library-page native-library-page">
        <header className="native-library-header">
          <h1 className="page-title">Open share</h1>
        </header>
        <div className="native-library-content">
          <div className="native-library-state" role={destination.isError ? "alert" : "status"}>
            {destination.isError ? (
              <>
                <strong>Could not open the share</strong>
                <span>{getApiErrorMessage(destination.error, "Try opening the share again.")}</span>
                <button className="btn btn-secondary" onClick={() => destination.refetch()}>
                  Try again
                </button>
                <Link className="btn btn-secondary" to="/library">
                  Open Library
                </Link>
              </>
            ) : (
              <DotLoader size="sm" label="Opening share" />
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="library-page native-library-page">
      <header className="native-library-header">
        <h1 className="page-title">Import share</h1>
      </header>
      <div className="native-library-content">
        <div className="share-import">
          {submit.data ? (
            <div className="native-library-state" role="status">
              <strong>Import queued</strong>
              <span>
                {includeFiles
                  ? "Shared file transfers will appear in Activity."
                  : "Saving the shared details without starting downloads."}
              </span>
              <Link className="btn btn-primary" to={submit.data.to} state={{ created: true }}>
                Open in Library
              </Link>
              <Link className="btn btn-secondary" to="/activity">
                View Activity
              </Link>
            </div>
          ) : (
            <>
              <form
                className="share-import__url"
                onSubmit={(event) => {
                  event.preventDefault();
                  setParams({ url: url.trim() });
                  submit.reset();
                }}
              >
                <label htmlFor="share-import-url">Aurral share link</label>
                <input
                  id="share-import-url"
                  className="artist-input"
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                  placeholder="https://aurral.org/s/…"
                  disabled={submit.isPending}
                />
                <button
                  type="submit"
                  className="btn btn-secondary"
                  disabled={!url.trim() || preview.isFetching || submit.isPending}
                >
                  Review share
                </button>
              </form>
              {sharedUrl && preview.isPending ? (
                <p role="status">
                  <DotLoader size="sm" label="Loading share" />
                </p>
              ) : null}
              {preview.isError ? (
                <div className="native-library-state" role="alert">
                  <strong>Share unavailable</strong>
                  <span>{getApiErrorMessage(preview.error, "Could not load the share.")}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => preview.refetch()}
                  >
                    Try again
                  </button>
                </div>
              ) : null}
              {data ? (
                <section className="share-import__review" aria-label="Import review">
                  <h2>{data.manifest.title}</h2>
                  <p className="settings-page__hint">
                    {data.manifest.kind === "artist"
                      ? "Artist"
                      : data.manifest.artistName || "Playlist"}
                    {data.tracks.length ? ` · ${data.tracks.length} tracks` : ""}
                  </p>
                  <label className="share-import__choice">
                    <input
                      type="radio"
                      name="share-import-mode"
                      checked={!includeFiles}
                      onChange={() =>
                        setParams({ url: sharedUrl, action: "details" }, { replace: true })
                      }
                      disabled={submit.isPending}
                    />
                    <span>
                      <strong>Details only</strong>
                      <span>Save the names and track list. Start no downloads.</span>
                    </span>
                  </label>
                  {data.canDownload ? (
                    <label className="share-import__choice">
                      <input
                        type="radio"
                        name="share-import-mode"
                        checked={includeFiles}
                        onChange={() =>
                          setParams({ url: sharedUrl, action: "files" }, { replace: true })
                        }
                        disabled={submit.isPending}
                      />
                      <span>
                        <strong>Include shared files</strong>
                        <span>
                          {data.downloads} to download · {data.ready} already in your Library ·{" "}
                          {data.detailsOnly} details only
                        </span>
                        {data.downloadBytes ? (
                          <span>
                            {(data.downloadBytes / 1024 / 1024).toLocaleString(undefined, {
                              maximumFractionDigits: 0,
                            })}{" "}
                            MB to download
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ) : (
                    <p className="settings-page__hint">
                      The sender&apos;s files are unavailable or downloads are not allowed. Details
                      can still be imported.
                    </p>
                  )}
                  {data.tracks.length ? (
                    <ol className="share-import__tracks">
                      {data.tracks.map((track, index) => (
                        <li key={index}>
                          <span>
                            {track.title}
                            <span className="settings-page__hint">
                              {track.artistName}
                              {data.manifest.kind === "artist" && track.albumTitle
                                ? ` · ${track.albumTitle}`
                                : ""}
                            </span>
                          </span>
                          <span className="settings-page__hint">
                            {track.inLibrary
                              ? "In Library"
                              : includeFiles && track.available
                                ? "Download"
                                : "Details only"}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {submit.isError ? (
                    <p className="artist-error-text" role="alert">
                      {getApiErrorMessage(submit.error, "Could not import this share.")}
                    </p>
                  ) : null}
                  <div className="share-import__actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={submit.isPending || preview.isFetching}
                      onClick={() => submit.mutate()}
                    >
                      {submit.isPending ? (
                        <DotLoader size="sm" label="Queueing import" />
                      ) : includeFiles ? (
                        "Import with files"
                      ) : (
                        "Import details"
                      )}
                    </button>
                    <Link className="btn btn-secondary" to="/library">
                      Cancel
                    </Link>
                  </div>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
