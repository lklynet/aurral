import { ListMusic, Sparkles, Upload } from "lucide-react";
import { Link } from "react-router-dom";

function getFlowEmptyCopy(libraryFilter, canCreate) {
  if (libraryFilter === "playlists") {
    return {
      title: "No playlists yet",
      message:
        "Create a playlist to curate tracks, or import one from Aurral Convert or a JSON export.",
      showPlaylistAction: true,
      showFlowAction: false,
      showImportAction: true,
    };
  }
  if (libraryFilter === "flows") {
    if (!canCreate) {
      return {
        title: "Flows need listening history",
        message:
          "Connect Last.fm in Settings to create flows that generate tracks from your taste.",
        showPlaylistAction: false,
        showFlowAction: false,
        showImportAction: false,
        showSettingsAction: true,
      };
    }
    return {
      title: "No flows yet",
      message:
        "Flows are auto-updating playlists built from recipes like Release Radar or your top artists.",
      showPlaylistAction: false,
      showFlowAction: true,
      showImportAction: false,
    };
  }
  return {
    title: "Start your playlist library",
    message:
      "Import a playlist, build your own track list, or create a flow that updates automatically from your taste.",
    showPlaylistAction: true,
    showFlowAction: canCreate,
    showImportAction: true,
  };
}

export function FlowEmptyState({
  canCreate = true,
  libraryFilter = "all",
  variant = "full",
  onImport,
  onNewPlaylist,
  onNewFlow,
  creatingPlaylist = false,
  creatingFlow = false,
}) {
  const copy = getFlowEmptyCopy(libraryFilter, canCreate);
  const isCompact = variant === "compact";

  return (
    <div
      className={`flow-page__collection-empty${isCompact ? " flow-page__collection-empty--compact" : ""}`}
    >
      <div className="flow-page__collection-empty__icon" aria-hidden="true">
        <ListMusic className="artist-icon-lg" />
      </div>
      <h2 className="flow-page__collection-empty__title">{copy.title}</h2>
      <p className="flow-page__collection-empty__message">{copy.message}</p>
      {!isCompact ? (
        <div className="flow-page__collection-empty__actions">
          {copy.showPlaylistAction ? (
            <button
              type="button"
              onClick={onNewPlaylist}
              disabled={creatingPlaylist}
              className="btn btn-primary btn--bold btn-min-h"
            >
              <ListMusic className="artist-icon-sm" />
              {creatingPlaylist ? "Creating…" : "New playlist"}
            </button>
          ) : null}
          {copy.showFlowAction ? (
            <button
              type="button"
              onClick={onNewFlow}
              disabled={creatingFlow}
              className="btn btn-secondary btn--bold btn-min-h"
            >
              <Sparkles className="artist-icon-sm" />
              {creatingFlow ? "Creating…" : "New flow"}
            </button>
          ) : null}
          {copy.showImportAction ? (
            <button
              type="button"
              onClick={onImport}
              className="btn btn-secondary btn--bold btn-min-h"
            >
              <Upload className="artist-icon-sm" />
              Import
            </button>
          ) : null}
          {copy.showSettingsAction ? (
            <Link
              to="/settings"
              className="btn btn-primary btn--bold btn-min-h"
            >
              Open settings
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
