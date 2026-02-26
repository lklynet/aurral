import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Loader, Music, AlertCircle } from "lucide-react";
import { getLibraryArtists } from "../utils/api";
import ArtistImage from "../components/ArtistImage";
import { useWebSocketChannel } from "../hooks/useWebSocket";

const PAGE_SIZE = 48;

function LibraryPage() {
  const [artists, setArtists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("name");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [retryKey, setRetryKey] = useState(0);
  const sentinelRef = useRef(null);
  const lastWsRefreshRef = useRef(0);
  const navigate = useNavigate();

  useEffect(() => {
    const controller = new AbortController();
    const fetchArtists = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getLibraryArtists();
        if (!controller.signal.aborted) {
          setArtists(data);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(
            err.response?.data?.message || "Failed to fetch artists from library"
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    fetchArtists();
    return () => controller.abort();
  }, [retryKey]);

  const scheduleRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastWsRefreshRef.current < 1000) return;
    lastWsRefreshRef.current = now;
    setRetryKey((key) => key + 1);
  }, []);

  useWebSocketChannel("library", (msg) => {
    if (msg.type === "library_update") {
      scheduleRefresh();
    }
  });

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchTerm, sortBy]);

  // Infinite scroll observer
  const onSentinel = useCallback((entries) => {
    if (entries[0].isIntersecting) {
      setVisibleCount((prev) => prev + PAGE_SIZE);
    }
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(onSentinel, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSentinel, loading, error]);

  const filteredArtists = useMemo(() => {
    const seen = new Set();
    let filtered = artists.filter((artist) => {
      const key = artist?.foreignArtistId || artist?.mbid || artist?.id;
      if (!key) return false;
      const normalized = String(key);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

    if (searchTerm) {
      filtered = filtered.filter((artist) =>
        artist.artistName.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.artistName.localeCompare(b.artistName);
        case "added":
          return new Date(b.added) - new Date(a.added);
        case "albums":
          return (
            (b.statistics?.albumCount || 0) - (a.statistics?.albumCount || 0)
          );
        default:
          return 0;
      }
    });
  }, [artists, searchTerm, sortBy]);

  return (
    <div className="animate-fade-in">
      <div className="mb-4 p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold mb-1" style={{ color: "#fff" }}>
              Your Library
            </h1>
            <p className="text-sm" style={{ color: "#c1c1c3" }}>
              {loading
                ? "Loading..."
                : `${artists.length} artist${
                    artists.length !== 1 ? "s" : ""
                  } in your collection`}
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search library..."
              className="input input-sm"
            />
          </div>
          <div className="sm:w-40">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="input input-sm"
            >
              <option value="name">Sort by Name</option>
              <option value="added">Sort by Date Added</option>
              <option value="albums">Sort by Album Count</option>
            </select>
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center items-center py-20">
          <Loader
            className="w-12 h-12 animate-spin"
            style={{ color: "#c1c1c3" }}
          />
        </div>
      )}

      {error && (
        <div className="bg-red-500/20 ">
          <div className="flex items-center">
            <AlertCircle className="w-6 h-6 text-red-400 mr-3" />
            <div>
              <h3 className="text-red-400 font-semibold">
                Error Loading Library
              </h3>
              <p className="text-red-300 mt-1">{error}</p>
            </div>
          </div>
          <button onClick={() => setRetryKey((k) => k + 1)} className="btn btn-primary mt-4">
            Try Again
          </button>
        </div>
      )}

      {!loading && !error && artists.length === 0 && (
        <div className="card text-center py-12">
          <Music
            className="w-16 h-16 mx-auto mb-4"
            style={{ color: "#c1c1c3" }}
          />
          <h3 className="text-xl font-semibold mb-2" style={{ color: "#fff" }}>
            No Artists in Library
          </h3>
          <p className="mb-6" style={{ color: "#c1c1c3" }}>
            Your library is empty. Search and add artists in Lidarr.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => navigate("/search")}
              className="btn btn-secondary"
            >
              Search for Artists
            </button>
          </div>
        </div>
      )}

      {!loading && !error && filteredArtists.length > 0 && (
        <div className="animate-slide-up">
          {searchTerm && (
            <div className="mb-3 text-sm" style={{ color: "#c1c1c3" }}>
              Showing {filteredArtists.length} of {artists.length} artists
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
            {filteredArtists.slice(0, visibleCount).map((artist) => {
              const monitorOption =
                artist.addOptions?.monitor ||
                artist.monitorNewItems ||
                artist.monitorOption ||
                "none";
              const isMonitored = artist.monitored && monitorOption !== "none";

              return (
                <div key={artist.id} className="group relative">
                  <div
                    className="relative aspect-square overflow-hidden cursor-pointer mb-2 shadow-sm group-hover:shadow-md transition-all"
                    style={{ backgroundColor: "#211f27" }}
                    onClick={() =>
                      navigate(`/artist/${artist.foreignArtistId}`, {
                        state: { artistName: artist.artistName },
                      })
                    }
                  >
                    <ArtistImage
                      mbid={artist.foreignArtistId}
                      artistName={artist.artistName}
                      alt={artist.artistName}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      showLoading={false}
                    />

                    {isMonitored && (
                      <div className="absolute top-2 right-2">
                        <div
                          className="w-3 h-3 bg-green-500 shadow-md"
                          title="Monitored"
                        />
                      </div>
                    )}
                  </div>

                  <h3
                    className="text-sm font-semibold group-hover:underline transition-colors cursor-pointer truncate text-center"
                    style={{ color: "#fff" }}
                    onClick={() =>
                      navigate(`/artist/${artist.foreignArtistId}`, {
                        state: { artistName: artist.artistName },
                      })
                    }
                    title={artist.artistName}
                  >
                    {artist.artistName}
                  </h3>
                </div>
              );
            })}
          </div>
          {visibleCount < filteredArtists.length && (
            <div ref={sentinelRef} className="flex justify-center py-8">
              <Loader className="w-6 h-6 animate-spin" style={{ color: "#c1c1c3" }} />
            </div>
          )}
        </div>
      )}

      {!loading &&
        !error &&
        artists.length > 0 &&
        filteredArtists.length === 0 && (
          <div className="card text-center py-12">
            <Music
              className="w-16 h-16 mx-auto mb-4"
              style={{ color: "#c1c1c3" }}
            />
            <h3
              className="text-xl font-semibold mb-2"
              style={{ color: "#fff" }}
            >
              No Artists Found
            </h3>
            <p className="mb-4" style={{ color: "#c1c1c3" }}>
              No artists match your search &quot;{searchTerm}&quot;
            </p>
            <button
              onClick={() => setSearchTerm("")}
              className="btn btn-secondary"
            >
              Clear Search
            </button>
          </div>
        )}
    </div>
  );
}

export default LibraryPage;
