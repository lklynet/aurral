import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryKeys } from "../queryClient";
import { createShareLink, getShareAvailability } from "../utils/api/endpoints/shareLinks";
import { buildSharePayload, buildShareUrl, shareLink } from "../utils/shareLink";
import { DotLoader } from "./DotLoader";
import PillToggle from "./PillToggle";
import { ModalShell } from "./PlaylistModals";

const EXPIRY_OPTIONS = [
  { value: "1d", label: "In 1 day" },
  { value: "7d", label: "In 7 days" },
  { value: "30d", label: "In 30 days" },
  { value: "never", label: "Never" },
];

const KIND_LABELS = { artist: "artist", album: "album", track: "track" };

const errorMessage = (error, fallback) =>
  error?.response?.data?.message || error?.response?.data?.error || fallback;

function libraryRefs(item) {
  return Object.fromEntries(
    ["kind", "trackMbid", "albumMbid", "artistMbid", "libraryTrackId", "libraryAlbumId", "libraryArtistId"]
      .map((field) => [field, item?.[field] == null ? "" : String(item[field]).trim()])
      .filter(([, value]) => value),
  );
}

const trackCountLabel = (kind, count) =>
  kind === "track" ? "this track" : `${count} ${count === 1 ? "track" : "tracks"}`;

function ListenHint({ kind, availability, onRetry }) {
  if (availability.isPending) {
    return <p className="settings-page__hint">Checking your Library…</p>;
  }
  if (availability.isError) {
    return (
      <p className="settings-page__hint settings-page__hint--warning">
        Could not check your Library.{" "}
        <button type="button" className="settings-page__link" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  const count = availability.data?.trackCount || 0;
  if (count && availability.data?.tunnelAvailable === false) {
    return (
      <p className="settings-page__hint">
        Your server doesn&apos;t have cloudflared, so friends couldn&apos;t reach a listen link.
      </p>
    );
  }
  if (!count) {
    return (
      <p className="settings-page__hint">
        Nothing from this {KIND_LABELS[kind]} is in your Library yet.
      </p>
    );
  }
  return (
    <p className="settings-page__hint">
      Anyone with the link can play {trackCountLabel(kind, count)} from your Aurral until it
      expires. Your server&apos;s address stays hidden.
    </p>
  );
}

export function ShareModal({ request, onClose }) {
  const open = Boolean(request);
  const item = request?.item;
  const label = request?.label || "";
  const kind = item?.kind || "track";
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const [listen, setListen] = useState(false);
  const [allowDownload, setAllowDownload] = useState(false);
  const [expiresIn, setExpiresIn] = useState("7d");
  const [created, setCreated] = useState(null);
  const ids = { listen: useId(), download: useId(), expires: useId() };
  const refs = libraryRefs(item);


  const availability = useQuery({
    queryKey: ["share-links", "availability", refs],
    queryFn: ({ signal }) => getShareAvailability(refs, { signal }),
    enabled: open,
    staleTime: 0,
  });
  const canListen =
    (availability.data?.trackCount || 0) > 0 && availability.data?.tunnelAvailable !== false;

  const create = useMutation({
    mutationFn: () =>
      createShareLink({
        ...refs,
        payload: buildSharePayload(item),
        allowDownload,
        expiresIn,
      }),
    onSuccess: (data) => {
      setCreated(data.link);
      queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(user?.id) });
    },
  });

  const { reset: resetCreate } = create;
  useEffect(() => {
    if (!open) return;
    setListen(false);
    setAllowDownload(false);
    setExpiresIn("7d");
    setCreated(null);
    resetCreate();
  }, [open, request, resetCreate]);

  const sendLink = async (url, successMessage) => {
    try {
      const outcome = await shareLink(url, label);
      if (outcome === "copied") showSuccess(successMessage);
      if (outcome !== "cancelled") onClose();
    } catch {
      showError({
        message: "Could not copy the share link. Open it and copy the address instead.",
        action: { label: "Open link", onClick: () => window.open(url, "_blank", "noopener") },
        duration: 8000,
      });
    }
  };

  const plainUrl = item ? buildShareUrl(item) : null;
  const busy = create.isPending;

  const footer = created ? (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
        Done
      </button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => sendLink(created.url, `Copied a listen link for ${label}`)}
      >
        Share link
      </button>
    </>
  ) : (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      {listen ? (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => create.mutate()}
          disabled={busy || !canListen}
        >
          {busy ? <DotLoader size="sm" label="Creating link" /> : "Create link"}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => sendLink(plainUrl, `Copied a share link for ${label}`)}
          disabled={!plainUrl}
        >
          Share link
        </button>
      )}
    </>
  );

  if (!open) return null;

  return createPortal(
    <ModalShell
      open
      title={`Share ${KIND_LABELS[kind]}`}
      description={label}
      onClose={onClose}
      disableClose={busy}
      footer={footer}
      className="playlist-modal--create share-modal"
    >
      {created ? (
        <div className="playlist-modal__fields">
          <input
            className="artist-input"
            value={created.url}
            readOnly
            aria-label="Listen link"
            onFocus={(event) => event.target.select()}
          />
          <p className="settings-page__hint">
            {created.expiresAt
              ? "The link stops working when it expires."
              : "The link works until you stop sharing it."}{" "}
            Stop sharing any time from Profile → Shared links.
          </p>
        </div>
      ) : (
        <div className="playlist-modal__fields">
          {!plainUrl ? (
            <p className="artist-error-text" role="alert">
              This {KIND_LABELS[kind]} is missing the name needed to share it.
            </p>
          ) : null}
          <div className="share-modal__option">
            <label className="share-modal__label" htmlFor={ids.listen}>
              Play from my Aurral
            </label>
            <PillToggle
              id={ids.listen}
              checked={listen && canListen}
              disabled={!canListen || busy}
              onChange={(event) => setListen(event.target.checked)}
              aria-label="Play from my Aurral"
            />
            <ListenHint kind={kind} availability={availability} onRetry={() => availability.refetch()} />
          </div>
          {listen && canListen ? (
            <>
              <div className="share-modal__option">
                <label className="share-modal__label" htmlFor={ids.download}>
                  Allow downloads
                </label>
                <PillToggle
                  id={ids.download}
                  checked={allowDownload}
                  disabled={busy}
                  onChange={(event) => setAllowDownload(event.target.checked)}
                  aria-label="Allow downloads"
                />
                <p className="settings-page__hint">
                  {kind === "track"
                    ? "They can save the original file."
                    : "They can save the original files, one at a time or with Download all."}
                </p>
              </div>
              <div className="share-modal__option">
                <label className="share-modal__label" htmlFor={ids.expires}>
                  Expires
                </label>
                <div className="artist-modal-field aurral-radius-round share-modal__select">
                  <select
                    id={ids.expires}
                    className="artist-modal-select"
                    value={expiresIn}
                    disabled={busy}
                    onChange={(event) => setExpiresIn(event.target.value)}
                  >
                    {EXPIRY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          ) : null}
          {create.isError ? (
            <p className="artist-error-text" role="alert">
              {errorMessage(create.error, "Could not create the link. Nothing was shared. Try again.")}
            </p>
          ) : null}
        </div>
      )}
    </ModalShell>,
    document.body,
  );
}
