import { useState } from "react";
import { RenamePlaylistModal } from "../../components/PlaylistModals";
import { useToast } from "../../contexts/ToastContext";
import {
  deletePlaylistArtwork,
  generatePlaylistArtwork,
  uploadPlaylistArtwork,
} from "../../utils/api/endpoints/playlists.js";
import { usePlaylistArtwork } from "./playlistPageUtils";

export function PlaylistEditModal({ entry, title, open, saving, error, onClose, onRename }) {
  const { showSuccess, showError } = useToast();
  const { artworkUrlFor, bumpArtwork } = usePlaylistArtwork();
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");

  const runCoverAction = async (action, successMessage, fallbackMessage) => {
    setCoverBusy(true);
    setCoverError("");
    try {
      await action(entry.id);
      bumpArtwork(entry.id);
      showSuccess(successMessage);
    } catch (err) {
      const message = err.response?.data?.message || err.message || fallbackMessage;
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
        runCoverAction(generatePlaylistArtwork, "Cover generated", "Failed to generate cover")
      }
    />
  );
}
