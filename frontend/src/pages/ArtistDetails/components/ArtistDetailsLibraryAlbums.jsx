import { useState } from "react";
import PropTypes from "prop-types";
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpWideNarrow,
  Loader,
  Music,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  MoreVertical,
  ExternalLink,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { getPopularityScale, segmentsFromScale } from "../utils";

export function ArtistDetailsLibraryAlbums({
  artist,
  libraryAlbums,
  downloadStatuses,
  requestingAlbum,
  reSearchingAlbum,
  albumCovers,
  expandedLibraryAlbum,
  albumTracks,
  loadingTracks,
  albumDropdownOpen,
  setAlbumDropdownOpen,
  handleLibraryAlbumClick,
  handleDeleteAlbumClick,
  handleReSearchAlbum,
}) {
  const [sortMode, setSortMode] = useState("date");
  const downloadedAlbums = libraryAlbums.filter((album) => {
    if (String(album.id ?? "").startsWith("pending-")) return false;
    return (
      album.monitored ||
      album.statistics?.percentOfTracks > 0 ||
      album.statistics?.sizeOnDisk > 0 ||
      downloadStatuses[album.id] ||
      (requestingAlbum &&
        (album.mbid === requestingAlbum ||
          album.foreignAlbumId === requestingAlbum))
    );
  });

  if (downloadedAlbums.length === 0) return null;
  const releaseGroups = artist?.["release-groups"] || [];
  const { pivot: popularityPivot } = getPopularityScale(releaseGroups);
  const popularityById = new Map(
    releaseGroups.map((rg) => [
      rg.id,
      typeof rg?.fans === "number" ? rg.fans : 0,
    ]),
  );
  const getAlbumFans = (album) => {
    const rgId = album.mbid || album.foreignAlbumId;
    return popularityById.get(rgId) || 0;
  };
  const sortedAlbums = [...downloadedAlbums].sort((a, b) => {
    if (sortMode === "popularityAsc") {
      const diff = getAlbumFans(a) - getAlbumFans(b);
      if (diff !== 0) return diff;
    } else if (sortMode === "popularityDesc") {
      const diff = getAlbumFans(b) - getAlbumFans(a);
      if (diff !== 0) return diff;
    }
    const dateA = a.releaseDate || "";
    const dateB = b.releaseDate || "";
    return dateB.localeCompare(dateA);
  });
  const sortTitle =
    sortMode === "date"
      ? "Sort: Default"
      : sortMode === "popularityDesc"
        ? "Sort: Most popular"
        : "Sort: Least popular";
  const SortIcon =
    sortMode === "date"
      ? ArrowUpDown
      : sortMode === "popularityDesc"
        ? ArrowDownWideNarrow
        : ArrowUpWideNarrow;

  return (
    <div className="card mb-4 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2
          className="text-lg font-semibold flex items-center"
          style={{ color: "#fff" }}
        >
          Albums in Your Library ({downloadedAlbums.length})
        </h2>
        <div className="relative">
          <button
            type="button"
            onClick={() =>
              setSortMode((prev) =>
                prev === "date"
                  ? "popularityDesc"
                  : prev === "popularityDesc"
                    ? "popularityAsc"
                    : "date",
              )
            }
            className="btn btn-secondary btn-sm p-2"
            title={sortTitle}
            aria-label={sortTitle}
          >
            <SortIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="space-y-1">
        {sortedAlbums.map((libraryAlbum, libraryAlbumIdx) => {
            const rgId =
              libraryAlbum.mbid || libraryAlbum.foreignAlbumId;
            const rg = artist?.["release-groups"]?.find(
              (r) => r.id === libraryAlbum.mbid || r.id === libraryAlbum.foreignAlbumId
            );
            const albumType =
              rg?.["primary-type"] || libraryAlbum.albumType || "Album";
            const isExpanded = expandedLibraryAlbum === rgId;
            const trackKey = libraryAlbum.id;
            const tracks = albumTracks[trackKey] || null;
            const isLoadingTracks = loadingTracks[trackKey] || false;
            const downloadStatus = downloadStatuses[libraryAlbum.id];
            const isComplete =
              libraryAlbum.statistics?.percentOfTracks === 100;
            const isActiveSearch =
              downloadStatus &&
              ["adding", "searching", "downloading", "moving", "processing"].includes(
                downloadStatus.status,
              );
            const canReSearch =
              !isComplete &&
              !String(libraryAlbum.id ?? "").startsWith("pending-") &&
              !isActiveSearch &&
              (downloadStatus?.status === "failed" || libraryAlbum.monitored);
            const rowBg = isExpanded
              ? "#2a2830"
              : libraryAlbumIdx % 2 === 0
              ? "#211f27"
              : "#1c1a22";
            const rowHoverBg = isExpanded ? "#2a2830" : "#25232b";
            const itemBg =
              libraryAlbumIdx % 2 === 0 ? "#1c1a22" : "#211f27";

            return (
              <div
                key={libraryAlbum.id}
                className="transition-colors"
                style={{ backgroundColor: rowBg }}
                onMouseEnter={(e) => {
                  if (!isExpanded) {
                    e.currentTarget.style.backgroundColor = rowHoverBg;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isExpanded) {
                    e.currentTarget.style.backgroundColor = rowBg;
                  }
                }}
              >
                <div
                  className="flex flex-col gap-2 py-2.5 px-3 cursor-pointer sm:flex-row sm:items-center sm:justify-between"
                  onClick={() =>
                    handleLibraryAlbumClick(rgId, libraryAlbum.id)
                  }
                >
                  <div className="flex-1 flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleLibraryAlbumClick(rgId, libraryAlbum.id);
                      }}
                      className="hover:text-gray-300 transition-colors"
                      style={{ color: "#c1c1c3" }}
                    >
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </button>
                    {albumCovers[rgId] ? (
                      <img
                        src={
                          albumCovers[
                            libraryAlbum.mbid ||
                              libraryAlbum.foreignAlbumId
                          ]
                        }
                        alt={libraryAlbum.albumName}
                        className="w-10 h-10 flex-shrink-0 object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <div
                        className="w-10 h-10 flex-shrink-0 flex items-center justify-center"
                        style={{ backgroundColor: itemBg }}
                      >
                        <Music
                          className="w-5 h-5"
                          style={{ color: "#c1c1c3" }}
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3
                        className="font-semibold text-sm truncate"
                        style={{ color: "#fff" }}
                      >
                        {libraryAlbum.albumName}
                      </h3>
                      <div
                        className="flex flex-wrap items-center gap-2 mt-0.5 text-xs"
                        style={{ color: "#c1c1c3" }}
                      >
                        {libraryAlbum.releaseDate && (
                          <span>
                            {libraryAlbum.releaseDate.split("-")[0]}
                          </span>
                        )}
                        {albumType && (
                          <span className="badge badge-primary text-xs">
                            {albumType}
                          </span>
                        )}
                        {libraryAlbum.statistics && (
                          <span className="text-xs">
                            {libraryAlbum.statistics.trackCount || 0}{" "}
                            tracks
                            {libraryAlbum.statistics.percentOfTracks !==
                              undefined && (
                              <span className="ml-1">
                                (
                                {
                                  libraryAlbum.statistics
                                    .percentOfTracks
                                }
                                % complete)
                              </span>
                            )}
                          </span>
                        )}
                        {(() => {
                          const rg = artist?.["release-groups"]?.find(
                            (r) => r.id === rgId
                          );
                          const fans =
                            typeof rg?.fans === "number" ? rg.fans : 0;
                          const segments = segmentsFromScale(
                            fans,
                            popularityPivot,
                            10,
                          );
                          return (
                            <span
                              className="flex items-center gap-0.5 ml-1"
                              title={`Popularity: ${segments}/10 · ${fans.toLocaleString()} listeners`}
                            >
                              {Array.from({ length: 10 }, (_, i) => {
                                const n = i + 1;
                                return (
                                  <span
                                    key={n}
                                    className="w-1 h-3 rounded-sm flex-shrink-0"
                                    style={{
                                      backgroundColor:
                                        n <= segments ? "#eab308" : "#4b5563",
                                    }}
                                  />
                                );
                              })}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 w-full sm:w-auto sm:justify-end">
                    {isComplete ? (
                      <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase bg-green-500/20 text-green-400 cursor-default">
                        <CheckCircle className="w-3.5 h-3.5" />
                        Complete
                      </span>
                    ) : downloadStatus ? (
                      downloadStatus.status === "added" ||
                      downloadStatus.status === "available" ? (
                        <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase bg-green-500/20 text-green-400 cursor-default">
                          <CheckCircle className="w-3.5 h-3.5" />
                          Added
                        </span>
                      ) : downloadStatus.status === "failed" ? (
                        <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase bg-red-500/20 text-red-400 cursor-default">
                          Failed
                        </span>
                      ) : (
                        <span
                          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase cursor-default"
                          style={{
                            backgroundColor: itemBg,
                            color: "#c1c1c3",
                          }}
                        >
                          <Loader className="w-3.5 h-3.5 animate-spin" />
                          {downloadStatus.status === "adding"
                            ? "Adding..."
                            : downloadStatus.status === "searching"
                            ? "Searching..."
                            : downloadStatus.status === "downloading"
                            ? "Downloading..."
                            : downloadStatus.status === "moving"
                            ? "Moving..."
                            : downloadStatus.status === "processing"
                            ? "Searching..."
                            : downloadStatus.status}
                        </span>
                      )
                    ) : requestingAlbum === rgId ? (
                      <span
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase cursor-default"
                        style={{
                          backgroundColor: itemBg,
                          color: "#c1c1c3",
                        }}
                      >
                        <Loader className="w-3.5 h-3.5 animate-spin" />
                        Adding...
                      </span>
                    ) : libraryAlbum.monitored ? (
                      <span
                        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase cursor-default"
                        style={{
                          backgroundColor: itemBg,
                          color: "#c1c1c3",
                        }}
                      >
                        Monitored
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase bg-yellow-500/20 text-yellow-400 cursor-default">
                        Unmonitored
                      </span>
                    )}
                    <div className="relative overflow-visible">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAlbumDropdownOpen(
                            albumDropdownOpen === rgId ? null : rgId
                          );
                        }}
                        className="btn btn-secondary btn-sm p-2"
                        style={{
                          backgroundColor: itemBg,
                          borderColor: itemBg,
                          color: "#c1c1c3",
                        }}
                        title="Options"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                      {albumDropdownOpen === rgId && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAlbumDropdownOpen(null);
                            }}
                          />
                          <div
                            className="absolute right-0 top-full mt-2 w-48 shadow-xl z-20 py-1 rounded-md border border-white/10"
                            style={{
                              backgroundColor: "#2d2b35",
                              boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
                            }}
                          >
                            <a
                              href={`https://www.last.fm/music/${encodeURIComponent(
                                artist.name
                              )}/${encodeURIComponent(
                                libraryAlbum.albumName
                              )}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 transition-colors flex items-center"
                              style={{ color: "#fff" }}
                              onClick={() => setAlbumDropdownOpen(null)}
                            >
                              <ExternalLink className="w-4 h-4 mr-2" />
                              View on Last.fm
                            </a>
                            {canReSearch && (
                              <>
                                <div className="my-1 border-t border-white/10" />
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleReSearchAlbum(
                                      libraryAlbum.id,
                                      libraryAlbum.albumName,
                                    );
                                    setAlbumDropdownOpen(null);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 transition-colors flex items-center"
                                  style={{ color: "#fff" }}
                                  disabled={reSearchingAlbum === libraryAlbum.id}
                                >
                                  {reSearchingAlbum === libraryAlbum.id ? (
                                    <Loader className="w-4 h-4 mr-2 animate-spin" />
                                  ) : (
                                    <RefreshCw className="w-4 h-4 mr-2" />
                                  )}
                                  {reSearchingAlbum === libraryAlbum.id
                                    ? "Searching..."
                                    : "Re-search"}
                                </button>
                              </>
                            )}
                            <div className="my-1 border-t border-white/10" />
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteAlbumClick(
                                  rgId,
                                  libraryAlbum.albumName
                                );
                              }}
                              className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 transition-colors flex items-center"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete Album
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div
                    className="px-3 py-2 overflow-hidden"
                    style={{
                      backgroundColor:
                        libraryAlbumIdx % 2 === 0
                          ? "#1c1a22"
                          : "#211f27",
                    }}
                  >
                    <div className="mb-2 pb-2">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                        {libraryAlbum.statistics && (
                          <>
                            <div>
                              <span
                                className=""
                                style={{ color: "#c1c1c3" }}
                              >
                                Tracks:
                              </span>
                              <span
                                className="ml-2 font-medium "
                                style={{ color: "#fff" }}
                              >
                                {libraryAlbum.statistics.trackCount ||
                                  0}
                              </span>
                            </div>
                            <div>
                              <span
                                className=""
                                style={{ color: "#c1c1c3" }}
                              >
                                Size:
                              </span>
                              <span
                                className="ml-2 font-medium "
                                style={{ color: "#fff" }}
                              >
                                {libraryAlbum.statistics.sizeOnDisk
                                  ? `${(
                                      libraryAlbum.statistics
                                        .sizeOnDisk /
                                      1024 /
                                      1024
                                    ).toFixed(2)} MB`
                                  : "N/A"}
                              </span>
                            </div>
                            <div>
                              <span
                                className=""
                                style={{ color: "#c1c1c3" }}
                              >
                                Completion:
                              </span>
                              <span
                                className="ml-2 font-medium "
                                style={{ color: "#fff" }}
                              >
                                {libraryAlbum.statistics
                                  .percentOfTracks || 0}
                                %
                              </span>
                            </div>
                          </>
                        )}
                        {libraryAlbum.releaseDate && (
                          <div>
                            <span
                              className=""
                              style={{ color: "#c1c1c3" }}
                            >
                              Release Date:
                            </span>
                            <span
                              className="ml-2 font-medium "
                              style={{ color: "#fff" }}
                            >
                              {libraryAlbum.releaseDate}
                            </span>
                          </div>
                        )}
                        {albumType && (
                          <div>
                            <span
                              className=""
                              style={{ color: "#c1c1c3" }}
                            >
                              Type:
                            </span>
                            <span
                              className="ml-2 font-medium "
                              style={{ color: "#fff" }}
                            >
                              {albumType}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div>
                      {isLoadingTracks ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader
                            className="w-5 h-5 animate-spin"
                            style={{ color: "#c1c1c3" }}
                          />
                        </div>
                      ) : tracks && tracks.length > 0 ? (
                        <div className="space-y-0">
                          {tracks.map((track, idx) => (
                            <div
                              key={track.id || track.mbid || idx}
                              className="flex items-center justify-between py-1.5 px-2 transition-colors text-sm"
                              style={{
                                backgroundColor:
                                  idx % 2 === 0
                                    ? "transparent"
                                    : "rgba(255, 255, 255, 0.02)",
                              }}
                            >
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <span
                                  className="text-xs  w-6 flex-shrink-0"
                                  style={{ color: "#c1c1c3" }}
                                >
                                  {track.trackNumber ||
                                    track.position ||
                                    idx + 1}
                                </span>
                                <span
                                  className="text-sm  truncate"
                                  style={{ color: "#fff" }}
                                >
                                  {track.title ||
                                    track.trackName ||
                                    "Unknown Track"}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {track.length && (
                                  <span
                                    className="text-xs "
                                    style={{ color: "#c1c1c3" }}
                                  >
                                    {Math.floor(track.length / 60000)}:
                                    {Math.floor(
                                      (track.length % 60000) / 1000
                                    )
                                      .toString()
                                      .padStart(2, "0")}
                                  </span>
                                )}
                                {track.hasFile ||
                                libraryAlbum?.statistics
                                  ?.percentOfTracks >= 100 ||
                                libraryAlbum?.statistics?.sizeOnDisk >
                                  0 ? (
                                  <CheckCircle className="w-4 h-4 text-green-500" />
                                ) : libraryAlbum.id ? (
                                  <span
                                    className="text-xs "
                                    style={{ color: "#c1c1c3" }}
                                  >
                                    Missing
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p
                          className="text-sm  italic py-4"
                          style={{ color: "#c1c1c3" }}
                        >
                          No tracks available
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

ArtistDetailsLibraryAlbums.propTypes = {
  artist: PropTypes.object,
  libraryAlbums: PropTypes.arrayOf(PropTypes.object).isRequired,
  downloadStatuses: PropTypes.object,
  requestingAlbum: PropTypes.string,
  albumCovers: PropTypes.object,
  expandedLibraryAlbum: PropTypes.string,
  albumTracks: PropTypes.object,
  loadingTracks: PropTypes.object,
  albumDropdownOpen: PropTypes.string,
  setAlbumDropdownOpen: PropTypes.func,
  handleLibraryAlbumClick: PropTypes.func,
  handleDeleteAlbumClick: PropTypes.func,
  handleReSearchAlbum: PropTypes.func,
  reSearchingAlbum: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
};
