import { useParams } from "react-router";
import { useCollectionTint } from "../components/CollectionHeader";
import { AlertCircle } from "../components/icons";
import PlaylistCard from "../components/PlaylistCard";
import RouteLink from "../components/RouteLink";
import { SkeletonLibraryGrid, SkeletonStatus } from "../components/Skeletons";
import StatePanel from "../components/StatePanel";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { browsePlaylistPath } from "../navigation/playlistPaths.ts";
import { resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { formatTrackTotal } from "./playlists/playlistPageUtils";
import { usePlaylistCategories } from "./usePlaylistShelf";

export default function DiscoverPlaylistCategoryPage() {
  const categoryId = useParams().categoryId ?? "";
  const { categories, madeForYou, shelf } = usePlaylistCategories();
  const category = categories.find((entry) => entry.id === categoryId);
  const source = categoryId === "made-for-you" ? madeForYou : shelf;
  useDocumentTitle(category?.name ?? "Playlists");
  const tint = useCollectionTint(
    resolveAuthenticatedApiAssetUrl(category?.playlists[0]?.artworkUrl),
  );

  const renderBody = () => {
    if (category) {
      return (
        <div className="discover-playlist-grid">
          {category.playlists.map((playlist) => {
            const artworkUrl = resolveAuthenticatedApiAssetUrl(playlist.artworkUrl) || null;
            return (
              <PlaylistCard
                key={`${playlist.provider}:${playlist.id}`}
                to={browsePlaylistPath(playlist.provider, playlist.id)}
                state={{
                  seed: { name: playlist.name, artworkUrl, trackCount: playlist.trackCount },
                }}
                name={playlist.name}
                artworkUrl={artworkUrl}
                meta={formatTrackTotal(playlist.trackCount)}
              />
            );
          })}
        </div>
      );
    }
    if (source.isPending) {
      return (
        <SkeletonStatus label="Loading playlists">
          <SkeletonLibraryGrid count={12} kind="playlist" className="discover-playlist-grid" />
        </SkeletonStatus>
      );
    }
    if (source.error) {
      return (
        <StatePanel
          role="alert"
          icon={<AlertCircle />}
          title="Couldn’t load playlists"
          message="Deezer didn’t respond. Try again in a moment."
          retrying={source.isFetching}
          onRetry={() => source.refetch()}
        />
      );
    }
    return (
      <StatePanel role="status" title="No playlists here right now">
        <RouteLink className="btn btn-secondary" to="/discover/playlists">
          All playlists
        </RouteLink>
      </StatePanel>
    );
  };

  return (
    <div
      className="discover-playlists-page"
      style={tint ? { "--collection-tint": tint } : undefined}
    >
      <h1 className="page-title discover-playlists-page__title">{category?.name ?? "Playlists"}</h1>
      {renderBody()}
    </div>
  );
}
