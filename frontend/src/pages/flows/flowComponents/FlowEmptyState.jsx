import { ListMusic, Sparkles, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { DotLoader } from "../../../components/DotLoader";

function getFlowEmptyCopy(libraryFilter, canCreate) {
  if (libraryFilter === "playlists") {
    return {
      title: "No playlists yet",
      showPlaylistAction: true,
      showFlowAction: false,
      showImportAction: true,
    };
  }
  if (libraryFilter === "flows") {
    if (!canCreate) {
      return {
        title: "Flows need listening history",
        showPlaylistAction: false,
        showFlowAction: false,
        showImportAction: false,
        showSettingsAction: true,
      };
    }
    return {
      title: "No flows yet",
      showPlaylistAction: false,
      showFlowAction: true,
      showImportAction: false,
    };
  }
  return {
    title: "No playlists or flows yet",
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
      {!isCompact ? (
        <div className="flow-page__collection-empty__actions">
          {copy.showPlaylistAction ? (
            <button
              type="button"
              onClick={onNewPlaylist}
              disabled={creatingPlaylist}
              className="btn btn-primary btn--bold btn-min-h"
            >
              {creatingPlaylist ? <DotLoader size="sm" label={null} /> : <ListMusic className="artist-icon-sm" />}
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
              {creatingFlow ? <DotLoader size="sm" label={null} /> : <Sparkles className="artist-icon-sm" />}
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
