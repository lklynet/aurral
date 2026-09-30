import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ListMusic, MoreVertical, Plus, Upload } from "lucide-react";
import { DotLoader } from "../../components/DotLoader";
import Tooltip from "../../components/Tooltip";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import { CreatePlaylistModal } from "../../components/PlaylistModals";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { createSharedPlaylist } from "../../utils/api/endpoints/playlists.js";
import { PlaylistArtworkThumb } from "./flowComponents/PlaylistArtworkThumb.jsx";
import { getSharedPlaylistTrackCount } from "./flowStats";
import { normalizeNameKey, reserveUniqueFlowName } from "./flowPageUtils";
import {
  formatTrackTotal,
  getImportedProviderLabel,
  getImportedProviderLogo,
  usePlaylistArtwork,
} from "./playlistShared";
import { useFlowStatus } from "./useFlowStatus";
import { playlistPath } from "../../navigation/playlistPaths";

const PlaylistImportModal = lazy(() =>
  import("./import/PlaylistImportModal.jsx").then((m) => ({ default: m.PlaylistImportModal })),
);

function SyncedBadge({ importSource }) {
  const logo =
    importSource?.syncEnabled === true ? getImportedProviderLogo(importSource.provider) : null;
  if (!logo) return null;
  const label = `Synced from ${getImportedProviderLabel(importSource.provider)}`;
  return (
    <Tooltip content={label}>
      <span className="playlists-page__synced" role="img" aria-label={label} tabIndex={0}>
        <span
          className="playlists-page__synced-logo"
          style={{ "--synced-logo": `url("${logo}")` }}
          aria-hidden="true"
        />
      </span>
    </Tooltip>
  );
}

export default function PlaylistsPage() {
  useDocumentTitle("Playlists");
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { status, loading, error, fetchStatus, getPlaylistStats, sharedPlaylists } =
    useFlowStatus();
  const { artworkUrlFor } = usePlaylistArtwork();
  const [importOpen, setImportOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    if (!location.state?.openImport) return;
    setImportOpen(true);
    navigate(location.pathname, { replace: true, state: {} });
  }, [location.pathname, location.state?.openImport, navigate]);

  const openCreate = () => {
    setCreateError("");
    setCreateOpen(true);
  };

  const handleCreate = async (name) => {
    setCreating(true);
    setCreateError("");
    try {
      const response = await createSharedPlaylist({ name });
      showSuccess(`Created ${name}`);
      setCreateOpen(false);
      await fetchStatus();
      if (response?.playlistId) {
        navigate(playlistPath(response.playlistId), { state: { created: true } });
      }
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.error ||
        err.message ||
        "Failed to create playlist";
      setCreateError(message);
      showError(message);
    } finally {
      setCreating(false);
    }
  };

  const describePlaylist = (playlist) => {
    const parts = [formatTrackTotal(getSharedPlaylistTrackCount(playlist, getPlaylistStats(playlist.id)))];
    if (playlist.ownerUsername && (user?.role === "admin" || playlist.ownerUsername !== user?.username)) {
      parts.unshift(playlist.ownerUsername);
    }
    return parts.join(" · ");
  };

  const renderContent = () => {
    if (loading && !status) {
      return (
        <div className="native-library-state" role="status">
          <DotLoader size="xl" label={null} />
          <span>Loading playlists…</span>
        </div>
      );
    }
    if (error && !status) {
      return (
        <div className="native-library-state" role="alert">
          <strong>Playlists unavailable</strong>
          <span>Aurral could not load your playlists.</span>
          <button type="button" className="native-library-state__action" onClick={fetchStatus}>
            Retry
          </button>
        </div>
      );
    }
    if (sharedPlaylists.length === 0) {
      return (
        <div className="native-library-state">
          <strong>No playlists yet</strong>
          <span>Create one here, or import from Spotify, YouTube Music, ListenBrainz, or Last.fm.</span>
          <div className="playlists-page__empty-actions">
            <button type="button" className="native-library-state__action" onClick={openCreate}>
              <ListMusic aria-hidden="true" />
              New playlist
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setImportOpen(true)}
            >
              <Upload aria-hidden="true" />
              Import playlist
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="native-library-grid" role="list" aria-label="Playlists">
        {sharedPlaylists.map((playlist) => (
          <article className="native-library-card" role="listitem" key={playlist.id}>
            <div className="native-library-card__cover-wrap">
              <Link
                to={playlistPath(playlist.id)}
                className="native-library-card__cover playlists-page__cover"
                aria-label={`Open ${playlist.name}`}
              >
                <PlaylistArtworkThumb artworkUrl={artworkUrlFor(playlist.id)} name={playlist.name} />
              </Link>
              <SyncedBadge importSource={playlist.importSource} />
            </div>
            <div className="native-library-card__body">
              <Link to={playlistPath(playlist.id)} className="native-library-card__title playlists-page__title">
                {playlist.name}
              </Link>
              <span className="native-library-card__meta">{describePlaylist(playlist)}</span>
            </div>
          </article>
        ))}
      </div>
    );
  };

  return (
    <main className="library-page native-library-page playlist-page">
      <header className="native-library-header">
        <div className="native-library-title-row">
          <div className="native-library-title">
            <h1 className="page-title">Playlists</h1>
          </div>
          <div className="native-library-header-actions">
            <LibraryItemMenu
              label="Playlist"
              triggerLabel="Create playlist"
              contextMenu={false}
              triggerIcon={
                <>
                  <Plus aria-hidden="true" />
                  <MoreVertical aria-hidden="true" />
                </>
              }
              menuLabel="Create playlist"
              items={[
                { id: "new", label: "New playlist", icon: ListMusic, onSelect: openCreate },
                {
                  id: "import",
                  label: "Import playlist",
                  icon: Upload,
                  onSelect: () => setImportOpen(true),
                },
              ]}
            />
          </div>
        </div>
      </header>
      <div className="native-library-content">{renderContent()}</div>
      <CreatePlaylistModal
        open={createOpen}
        defaultName={reserveUniqueFlowName(
          new Set(sharedPlaylists.map((playlist) => normalizeNameKey(playlist?.name)).filter(Boolean)),
          "Playlist",
        )}
        saving={creating}
        error={createError}
        onClose={() => {
          if (creating) return;
          setCreateError("");
          setCreateOpen(false);
        }}
        onSubmit={handleCreate}
      />
      {importOpen ? (
        <Suspense fallback={null}>
          <PlaylistImportModal
            open={importOpen}
            onClose={() => setImportOpen(false)}
            onImported={fetchStatus}
            showError={showError}
            showSuccess={showSuccess}
            existingPlaylistNames={sharedPlaylists.map((playlist) => playlist?.name)}
          />
        </Suspense>
      ) : null}
    </main>
  );
}
