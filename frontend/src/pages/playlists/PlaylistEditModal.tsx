import { useState } from "react";
import { RenamePlaylistModal } from "../../components/PlaylistModals";
import { useToast } from "../../contexts/ToastContext";
import { parseResponse } from "hono/client";
import { playlistArtworkClient } from "../../utils/api/clients/playlistArtwork.ts";
import { usePlaylistArtwork } from "./playlistPageUtils";
import { asApiError } from "../../utils/api/core.ts";
import { getApiErrorText } from "../onboardingUtils.tsx";

type PlaylistEditModalProps = {
  entry: { id: string; name: string };
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
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverError, setCoverError] = useState("");

  const artwork = playlistArtworkClient.artwork[":playlistId"];
  const param = { playlistId: encodeURIComponent(entry.id) };

  const runCoverAction = async (
    action: () => Promise<unknown>,
    successMessage: string,
    fallbackMessage: string,
  ) => {
    setCoverBusy(true);
    setCoverError("");
    try {
      await action();
      bumpArtwork(entry.id);
      showSuccess(successMessage);
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
          () =>
            parseResponse(
              artwork.$put(
                { param },
                {
                  headers: { "Content-Type": file.type || "application/octet-stream" },
                  init: { body: file },
                },
              ),
            ),
          "Cover updated",
          "Failed to upload cover",
        )
      }
      onRemoveCover={() =>
        runCoverAction(
          () => parseResponse(artwork.$delete({ param })),
          "Cover removed",
          "Failed to remove cover",
        )
      }
      onGenerateCover={() =>
        runCoverAction(
          () => parseResponse(artwork.generate.$post({ param })),
          "Cover generated",
          "Failed to generate cover",
        )
      }
    />
  );
}
