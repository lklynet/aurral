import { Navigate, useSearchParams } from "react-router";
import { DotLoader } from "../../components/DotLoader";
import { flowPath, playlistPath } from "../../navigation/playlistPaths";
import { useFlowStatus } from "./useFlowStatus";

export default function PlaylistRedirect() {
  const [searchParams] = useSearchParams();
  const selectedId = String(searchParams.get("selected") || "").trim();
  const { status, loading, flows, staticPlaylists } = useFlowStatus();

  if (!selectedId) return <Navigate to="/library/playlists" replace />;
  if (loading && !status) {
    return (
      <div className="native-library-state" role="status">
        <DotLoader size="xl" label={null} />
        <span>Opening playlist…</span>
      </div>
    );
  }
  if (flows.some((flow) => flow.id === selectedId)) {
    return <Navigate to={flowPath(selectedId)} replace />;
  }
  if (staticPlaylists.some((playlist) => playlist.id === selectedId)) {
    return <Navigate to={playlistPath(selectedId)} replace />;
  }
  return <Navigate to="/library/playlists" replace />;
}
