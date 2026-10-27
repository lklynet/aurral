import { usePlaylistArtwork } from "../../hooks/usePlaylistArtwork.ts";
import { useState } from "react";
import { RenamePlaylistModal } from "../../components/PlaylistModals";
import { useToast } from "../../contexts/ToastContext";
import {
  deletePlaylistArtwork,
  generatePlaylistArtwork,
  uploadPlaylistArtwork,
  restorePlaylistArtwork,
  type PlaylistArtworkStyle,
} from "../../utils/api/endpoints/playlists.ts";
import { asApiError } from "../../utils/api/core.ts";
import { getApiErrorText } from "../onboardingUtils.tsx";

type PlaylistEditModalProps = {
  entry: { id: string; name: string; importSource?: { artworkUrl?: string | null } | null };
  title: string;
  open: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onRename: (name: string) => void | Promise<void>;
};

export function PlaylistEditModal({
  entry,
  title,
  open,
  saving,
  error,
  onClose,
  onRename,
}: PlaylistEditModalProps) {
  const { showSuccess, showError } = useToast();
  const { artworkUrlFor, bumpArtwork } = usePlaylistArtwork();
  const [coverStyle, setCoverStyle] = useState<PlaylistArtworkStyle>("artist");
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");

  const runCoverAction = async (
    action: (playlistId: string) => Promise<{ fallback?: boolean }>,
    successMessage: string,
    fallbackMessage: string,
  ) => {
    setCoverBusy(true);
    setCoverError("");
    try {
      const result = await action(entry.id);
      bumpArtwork(entry.id);
      showSuccess(
        result.fallback ? "No artist photo available. Created a simple cover." : successMessage,
      );
    } catch (err) {
      const message =
        getApiErrorText(err, "message") || asApiError(err)?.message || fallbackMessage;
      setCoverError(message);
      showError(message);
    } finally {
      setCoverBusy(false);
    }
  };

  return (
    <RenamePlaylistModal
      open={open}
      title={title}
      defaultName={entry.name || ""}
      displayName={entry.name || ""}
      artworkUrl={artworkUrlFor(entry.id)}
      saving={saving}
      coverBusy={coverBusy}
      coverStyle={coverStyle}
      onCoverStyleChange={setCoverStyle}
      onRestoreCover={
        entry.importSource?.artworkUrl
          ? () =>
              runCoverAction(
                restorePlaylistArtwork,
                "Original cover restored",
                "Failed to restore original cover",
              )
          : undefined
      }
      error={error}
      coverError={coverError}
      onClose={() => {
        if (saving || coverBusy) return;
        setCoverError("");
        onClose();
      }}
      onSubmit={onRename}
      onUpload={(file) =>
        file &&
        runCoverAction(
          (id) => uploadPlaylistArtwork(id, file),
          "Cover updated",
          "Failed to upload cover",
        )
      }
      onRemoveCover={() =>
        runCoverAction(deletePlaylistArtwork, "Cover removed", "Failed to remove cover")
      }
      onGenerateCover={() =>
        runCoverAction(
          (id) => generatePlaylistArtwork(id, coverStyle),
          "Cover generated",
          "Failed to generate cover",
        )
      }
    />
  );
}
