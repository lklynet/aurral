import { DotLoader } from "../components/DotLoader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { useEditorialShelf } from "./useEditorialShelf";

export default function DiscoverPlaylistsPage() {
  useDocumentTitle("Playlists");
  const { data, error, isPending, isFetching, refetch } = useEditorialShelf();

  const renderShelf = () => {
    if (isPending) {
      return (
        <div className="search-empty-panel discover-playlists-page__status-panel" role="status">
          <DotLoader size="lg" label={null} />
          <h2 className="search-empty-panel__title">Loading playlists</h2>
        </div>
      );
    }
    if (error) {
      return (
        <div className="search-empty-panel" role="alert">
          <h2 className="search-empty-panel__title">Playlists didn&rsquo;t load</h2>
          <p className="search-empty-panel__message">Deezer didn&rsquo;t respond. Try again in a moment.</p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <>
        <DiscoverPlaylistSection title="For you" playlists={data?.forYou || []} />
        {(data?.genres || []).map((genre) => (
          <DiscoverPlaylistSection key={genre.id} title={genre.name} playlists={genre.playlists} />
        ))}
      </>
    );
  };

  return (
    <div className="discover-playlists-page">
      <header className="discover-playlists-page__header">
        <div className="discover-playlists-page__title-row">
          <h1 className="page-title">Playlists</h1>
        </div>
      </header>
      {renderShelf()}
    </div>
  );
}
