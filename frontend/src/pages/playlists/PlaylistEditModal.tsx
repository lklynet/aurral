import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { ModalShell } from "../../components/PlaylistModals";
import { DotLoader } from "../../components/DotLoader";
import TooltipButton from "../../components/TooltipButton";
import { Check, Shuffle, Trash2, Upload } from "../../components/icons";
import { useToast } from "../../contexts/ToastContext";
import {
  deletePlaylistArtwork,
  generatePlaylistArtwork,
  getPlaylistArtworkPick,
  getPlaylistArtworkPreviewUrl,
  restorePlaylistArtwork,
  shufflePlaylistArtwork,
  uploadPlaylistArtwork,
  type PlaylistArtworkStyle,
  type PlaylistCoverPick,
} from "../../utils/api/endpoints/playlists.ts";
import { asApiError } from "../../utils/api/core.ts";
import { getApiErrorText } from "../onboardingUtils.tsx";

type CoverDraft =
  | { kind: "generated"; pick: PlaylistCoverPick }
  | { kind: "upload"; file: File; url: string }
  | { kind: "original" }
  | { kind: "removed" };

type PlaylistEditModalProps = {
  entry: { id: string; name: string; importSource?: { artworkUrl?: string | null } | null };
  title: string;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
};

const PREVIEW_DELAY_MS = 300;

const commitCover = (playlistId: string, cover: CoverDraft) => {
  switch (cover.kind) {
    case "generated":
      return generatePlaylistArtwork(playlistId, cover.pick.style, cover.pick);
    case "upload":
      return uploadPlaylistArtwork(playlistId, cover.file);
    case "original":
      return restorePlaylistArtwork(playlistId);
    case "removed":
      return deletePlaylistArtwork(playlistId);
  }
};

const errorText = (err: unknown, fallback: string) =>
  getApiErrorText(err, "message") || asApiError(err)?.message || fallback;

export function PlaylistEditModal({ entry, title, onClose, onRename }: PlaylistEditModalProps) {
  const { showSuccess, showError, showInfo } = useToast();
  const { artworkUrlFor, bumpArtwork } = usePlaylistArtwork();
  const [name, setName] = useState(entry.name);
  const [previewTitle, setPreviewTitle] = useState(entry.name);
  const [draft, setDraft] = useState<CoverDraft | null>(null);
  const [busy, setBusy] = useState<"shuffle" | "save" | null>(null);
  const [error, setError] = useState("");
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { data: savedPick = null } = useQuery({
    queryKey: ["playlists", "artwork-pick", entry.id],
    queryFn: () => getPlaylistArtworkPick(entry.id).then((response) => response.pick),
    staleTime: 0,
  });

  useEffect(() => {
    const timer = setTimeout(() => setPreviewTitle(name.trim()), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [name]);

  useEffect(() => {
    if (draft?.kind !== "upload") return;
    const { url } = draft;
    return () => URL.revokeObjectURL(url);
  }, [draft]);

  const originalUrl = entry.importSource?.artworkUrl || null;
  const generated = draft?.kind === "generated" ? draft.pick : draft ? null : savedPick;
  const src = (() => {
    if (draft?.kind === "upload") return draft.url;
    if (draft?.kind === "original") return originalUrl;
    if (draft?.kind === "removed") return null;
    if (generated && (draft || previewTitle !== entry.name))
      return getPlaylistArtworkPreviewUrl(entry.id, previewTitle, generated);
    return artworkUrlFor(entry.id);
  })();
  const visibleSrc = src && src !== failedSrc ? src : null;
  const disabled = busy !== null;

  const shuffle = async (style: PlaylistArtworkStyle) => {
    setBusy("shuffle");
    setError("");
    try {
      const { pick } = await shufflePlaylistArtwork(entry.id, { style, previous: generated });
      if (!pick) return;
      setDraft({ kind: "generated", pick });
      if (style === "artist" && !pick.artistKey)
        showInfo("No artist photo available. Using a simple cover.");
    } catch (err) {
      setError(errorText(err, "Failed to shuffle cover"));
    } finally {
      setBusy(null);
    }
  };

  const toggleStyle = () => {
    if (generated?.style === "artist")
      return setDraft({ kind: "generated", pick: { ...generated, style: "simple" } });
    if (generated?.artistKey)
      return setDraft({ kind: "generated", pick: { ...generated, style: "artist" } });
    return shuffle(generated ? "artist" : "simple");
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError("Choose an image file");
    setError("");
    setDraft({ kind: "upload", file, url: URL.createObjectURL(file) });
  };

  const save = async () => {
    if (busy) return;
    const nextName = name.trim();
    if (!nextName) return setError("Name is required");
    const renamed = nextName !== entry.name;
    const cover: CoverDraft | null =
      draft ?? (renamed && savedPick ? { kind: "generated", pick: savedPick } : null);
    if (!renamed && !cover) return onClose();
    setBusy("save");
    setError("");
    try {
      if (renamed) await onRename(nextName);
      if (cover) {
        const result = await commitCover(entry.id, cover);
        bumpArtwork(entry.id);
        if (result.fallback) showInfo("No artist photo available. Created a simple cover.");
      }
      showSuccess("Changes saved");
      onClose();
    } catch (err) {
      const message = errorText(err, "Failed to save changes");
      setError(message);
      showError(message);
      setBusy(null);
    }
  };

  return (
    <ModalShell
      open
      title={title}
      className="playlist-modal--edit"
      onClose={onClose}
      disableClose={busy === "save"}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary btn-sm"
            disabled={busy === "save"}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="btn btn-primary btn-sm"
            disabled={disabled}
          >
            {busy === "save" ? (
              <DotLoader size="sm" label={null} />
            ) : (
              <Check className="artist-icon-sm" />
            )}
            Save
          </button>
        </>
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="flow-page__hidden-input"
        onChange={handleFileChange}
      />
      <div className="playlist-edit">
        <div className={`playlist-edit__cover${busy === "shuffle" ? " is-busy" : ""}`}>
          {visibleSrc ? (
            <img src={visibleSrc} alt="" onError={() => setFailedSrc(visibleSrc)} />
          ) : (
            <span>{(previewTitle || "?").charAt(0).toUpperCase()}</span>
          )}
        </div>
        <div className="playlist-edit__tools">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            onClick={() => shuffle(generated?.style ?? "artist")}
          >
            <Shuffle className="artist-icon-sm" />
            Shuffle
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            onClick={toggleStyle}
          >
            {generated?.style === "simple" ? "Artist" : "Simple"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="artist-icon-sm" />
            Upload
          </button>
          {originalUrl ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled || draft?.kind === "original"}
              onClick={() => setDraft({ kind: "original" })}
            >
              Original
            </button>
          ) : null}
          <TooltipButton
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Remove cover"
            title="Remove cover"
            disabled={disabled || !visibleSrc}
            onClick={() => setDraft({ kind: "removed" })}
          >
            <Trash2 className="artist-icon-sm" />
          </TooltipButton>
        </div>
        <input
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (error) setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
          className="input input--tall"
          aria-label="Name"
          autoFocus
        />
        {error ? <p className="artist-error-text">{error}</p> : null}
      </div>
    </ModalShell>
  );
}
