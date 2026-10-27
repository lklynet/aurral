import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryKeys } from "../queryClient";
import {
  createPlainShareLink,
  createShareLink,
  getShareAvailability,
} from "../utils/api/endpoints/shareLinks";
import { getApiErrorText } from "../pages/onboardingUtils";
import type {
  ShareAvailabilityResponse,
  ShareLinkResponse,
} from "../../../backend/routes/shareLinks.ts";
import { shareLink, type ShareItem, type ShareKind } from "../utils/shareLink";
import { formatDateTime } from "../utils/dateTime.ts";
import { DotLoader } from "./DotLoader";
import PillToggle from "./PillToggle";
import { ModalShell } from "./PlaylistModals";
import { parseShareManifest } from "../../../lib/shareManifest.ts";

const EXPIRY_OPTIONS = [
  { value: "1d", label: "In 1 day" },
  { value: "7d", label: "In 7 days" },
  { value: "30d", label: "In 30 days" },
  { value: "never", label: "Never" },
];

const KIND_LABELS = { artist: "artist", album: "album", track: "track", playlist: "playlist" };

type ShareRequest = { item: ShareItem; label?: string };

const errorMessage = (error: unknown, fallback: string) =>
  getApiErrorText(error, "message") || getApiErrorText(error, "error") || fallback;

function libraryRefs(item: ShareItem | undefined) {
  return Object.fromEntries(
    [
      "kind",
      "trackMbid",
      "albumMbid",
      "artistMbid",
      "libraryTrackId",
      "libraryAlbumId",
      "libraryArtistId",
      "playlistId",
      "title",
      "artistName",
      "albumTitle",
    ]
      .map((field) => [field, item?.[field] == null ? "" : String(item[field]).trim()])
      .filter(([, value]) => value),
  );
}

const trackCountLabel = (kind: ShareKind, count: number) =>
  kind === "track" ? "this track" : `${count} ${count === 1 ? "track" : "tracks"}`;

function ListenHint({
  kind,
  availability,
  onRetry,
}: {
  kind: ShareKind;
  availability: UseQueryResult<ShareAvailabilityResponse>;
  onRetry: () => void;
}) {
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
      <p className="settings-page__hint">Install cloudflared on your server to share playback.</p>
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
      Anyone with the link can play {trackCountLabel(kind, count)}. Your server address stays
      hidden.
    </p>
  );
}

function describeCreated(
  kind: ShareKind,
  { shareFiles, expiresAt }: Pick<ShareLinkResponse, "shareFiles" | "expiresAt">,
) {
  const files = shareFiles
    ? expiresAt
      ? `File access ends ${formatDateTime(new Date(expiresAt))}.`
      : "File access has no expiry."
    : null;
  if (kind === "playlist")
    return ["Updates daily.", files, "Stop sharing in Profile → Shared links."]
      .filter(Boolean)
      .join(" ");
  return files
    ? `${files} Stop file access in Profile → Shared links. The link keeps working.`
    : "This link does not expire.";
}

export function ShareModal({
  request,
  onClose,
}: {
  request: ShareRequest | null;
  onClose: () => void;
}) {
  const open = Boolean(request);
  const item = request?.item;
  const label = request?.label || "";
  const kind = item?.kind || "track";
  const { user } = useAuth();
  const hasAccount = user?.id != null && Number(user.id) > 0;
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const [listen, setListen] = useState(false);
  const [allowDownload, setAllowDownload] = useState(false);
  const [expiresIn, setExpiresIn] = useState("7d");
  const [created, setCreated] = useState<Pick<
    ShareLinkResponse,
    "url" | "shareFiles" | "expiresAt"
  > | null>(null);
  const ids = { listen: useId(), download: useId(), expires: useId() };
  const refs = libraryRefs(item);
  const manifest = item
    ? parseShareManifest({
        ...item,
        title: item.title || item.name || item.artistName,
        tracks:
          item.kind === "track"
            ? [{ ...item, albumTitle: item.albumTitle || item.albumName }]
            : Array.isArray(item.tracks)
              ? item.tracks
              : [],
      })
    : null;

  const availability = useQuery({
    queryKey: ["share-links", "availability", refs],
    queryFn: ({ signal }) => getShareAvailability(refs, { signal }),
    enabled: open && hasAccount,
    staleTime: 0,
  });
  const canListen =
    hasAccount &&
    (availability.data?.trackCount || 0) > 0 &&
    availability.data?.tunnelAvailable !== false;

  const create = useMutation({
    mutationFn: async () => {
      if (!hasAccount) return createPlainShareLink(manifest);
      return createShareLink({
        ...refs,
        manifest,
        shareFiles: listen && canListen,
        allowDownload: listen && canListen && allowDownload,
        expiresIn,
      });
    },
    onSuccess: (data) => {
      setCreated(data.link);
      if (hasAccount) queryClient.invalidateQueries({ queryKey: queryKeys.shareLinks(user?.id) });
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

  const sendLink = async (url: string, successMessage: string) => {
    try {
      const outcome = await shareLink(url, label);
      if (outcome === "copied") showSuccess(successMessage);
      if (outcome !== "cancelled") onClose();
    } catch {
      showError({
        message: "Could not copy the link. Open it to copy the address.",
        action: { label: "Open link", onClick: () => window.open(url, "_blank", "noopener") },
        duration: 8000,
      });
    }
  };

  const busy = create.isPending;

  const footer = created ? (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
        Done
      </button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() =>
          sendLink(created.url, created.shareFiles ? "Listen link copied" : "Link copied")
        }
      >
        Share link
      </button>
    </>
  ) : (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={() => create.mutate()}
        disabled={
          busy || !manifest || (!hasAccount && kind === "playlist") || (listen && !canListen)
        }
      >
        {busy ? (
          <DotLoader size="sm" label="Creating link" />
        ) : listen ? (
          "Create link"
        ) : (
          "Share link"
        )}
      </button>
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
          <p className="settings-page__hint">{describeCreated(kind, created)}</p>
        </div>
      ) : (
        <div className="playlist-modal__fields">
          {!manifest ? (
            <p className="artist-error-text" role="alert">
              This {KIND_LABELS[kind]} is missing the name needed to share it.
            </p>
          ) : null}
          <div className="share-modal__option">
            <label className="share-modal__label" htmlFor={ids.listen}>
              Share my files
            </label>
            <PillToggle
              id={ids.listen}
              checked={listen && canListen}
              disabled={!canListen || busy}
              onChange={(event) => setListen(event.target.checked)}
              aria-label="Share my files"
            />
            {hasAccount ? (
              <ListenHint
                kind={kind}
                availability={availability}
                onRetry={() => availability.refetch()}
              />
            ) : (
              <p className="settings-page__hint">Sign in to share files or playlists.</p>
            )}
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
                    ? "Anyone with the link can download the original file."
                    : "Anyone with the link can download the original files."}
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
          {kind === "playlist" && hasAccount ? (
            <p className="settings-page__hint">
              Playlist links update daily, so people who import them stay in sync.
            </p>
          ) : null}
          {create.isError ? (
            <p className="artist-error-text" role="alert">
              {errorMessage(create.error, "Could not create the link. Try again.")}
            </p>
          ) : null}
        </div>
      )}
    </ModalShell>,
    document.body,
  );
}
