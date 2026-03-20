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
  Plus,
  Tag,
  Disc,
  Disc3,
  FileMusic,
  RefreshCw,
} from "lucide-react";
import AddAlbumButton from "../../../components/AddAlbumButton";
import { getPopularityScale, segmentsFromScale } from "../utils";
import { matchesReleaseTypeFilter, hasActiveFilters } from "../utils";

export function ArtistDetailsReleaseGroups({
  artist,
  selectedReleaseTypes,
  setSelectedReleaseTypes,
  primaryReleaseTypes,
  secondaryReleaseTypes,
  showFilterDropdown,
  setShowFilterDropdown,
  existsInLibrary,
  handleMonitorAll,
  processingBulk,
  albumCovers,
  expandedReleaseGroup,
  albumTracks,
  loadingTracks,
  getAlbumStatus,
  albumDropdownOpen,
  setAlbumDropdownOpen,
  handleReleaseGroupAlbumClick,
  handleRequestAlbum,
  handleDeleteAlbumClick,
  requestingAlbum,
  reSearchingAlbum,
  handleReSearchAlbum,
  isReleaseGroupDownloadedInLibrary,
}) {
  const [sortMode, setSortMode] = useState("date");
  const releaseGroups = artist["release-groups"];
  if (!releaseGroups || releaseGroups.length === 0) return null;

  const filtered = releaseGroups
    .filter((rg) => matchesReleaseTypeFilter(rg, selectedReleaseTypes))
    .filter((rg) => !isReleaseGroupDownloadedInLibrary(rg.id));
  const totalCount = releaseGroups.length;
  const filteredCount = filtered.length;
  const { pivot: popularityPivot } = getPopularityScale(releaseGroups);
  const sortedReleaseGroups = [...filtered].sort((a, b) => {
    const fansA = typeof a?.fans === "number" ? a.fans : 0;
    const fansB = typeof b?.fans === "number" ? b.fans : 0;
    if (sortMode === "popularityAsc") {
      const diff = fansA - fansB;
      if (diff !== 0) return diff;
    } else if (sortMode === "popularityDesc") {
      const diff = fansB - fansA;
      if (diff !== 0) return diff;
    }
    const dateA = a["first-release-date"] || "";
    const dateB = b["first-release-date"] || "";
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

  const getIcon = (type) => {
    if (type === "Album") return <Disc className="w-4 h-4" />;
    if (type === "EP") return <Disc3 className="w-4 h-4" />;
    if (type === "Single") return <FileMusic className="w-4 h-4" />;
    return <Music className="w-4 h-4" />;
  };

  const activeFilters = hasActiveFilters(selectedReleaseTypes);

  return (
    <div className="card p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <h2
            className="text-lg font-semibold flex items-center"
            style={{ color: "#fff" }}
          >
            Albums & Releases ({filteredCount}/{totalCount})
          </h2>
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
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {primaryReleaseTypes.map((type) => {
              const isSelected = selectedReleaseTypes.includes(type);
              return (
                <button
                  key={type}
                  onClick={() => {
                    if (isSelected) {
                      setSelectedReleaseTypes(
                        selectedReleaseTypes.filter((t) => t !== type)
                      );
                    } else {
                      setSelectedReleaseTypes([
                        ...selectedReleaseTypes,
                        type,
                      ]);
                    }
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium transition-all"
                  style={{
                    backgroundColor: isSelected ? "#4a4a4a" : "#211f27",
                    color: "#fff",
                  }}
                  title={type}
                >
                  {getIcon(type)}
                  <span>{type}</span>
                </button>
              );
            })}
          </div>

          <div className="relative">
            <button
              onClick={() => setShowFilterDropdown(!showFilterDropdown)}
              className="btn btn-outline-secondary btn-sm flex items-center gap-2 px-3 py-2"
            >
              <Tag className="w-4 h-4" />
              <span className="text-sm">Filter</span>
              {activeFilters && (
                <span
                  className="text-white text-xs px-1.5 py-0.5 min-w-[18px] h-[18px] flex items-center justify-center"
                  style={{ backgroundColor: "#211f27" }}
                >
                  {secondaryReleaseTypes.length -
                    selectedReleaseTypes.filter((t) =>
                      secondaryReleaseTypes.includes(t)
                    ).length}
                </span>
              )}
              <ChevronDown
                className={`w-4 h-4 transition-transform ${
                  showFilterDropdown ? "rotate-180" : ""
                }`}
              />
            </button>

            {showFilterDropdown && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowFilterDropdown(false)}
                />
                <div
                  className="absolute right-0 top-full mt-2 z-20  shadow-xl  p-4 min-w-[280px]"
                  style={{ backgroundColor: "#211f27" }}
                >
                  <div className="space-y-4">
                    <div>
                      <h3
                        className="text-sm font-semibold  mb-2"
                        style={{ color: "#fff" }}
                      >
                        Secondary Types
                      </h3>
                      <div className="space-y-2">
                        {secondaryReleaseTypes.map((type) => (
                          <label
                            key={type}
                            className="flex items-center space-x-2 cursor-pointer hover:bg-gray-900/50 px-2 py-1.5 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selectedReleaseTypes.includes(type)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedReleaseTypes([
                                    ...selectedReleaseTypes,
                                    type,
                                  ]);
                                } else {
                                  setSelectedReleaseTypes(
                                    selectedReleaseTypes.filter(
                                      (t) => t !== type
                                    )
                                  );
                                }
                              }}
                              className="form-checkbox h-4 w-4"
                              style={{ color: "#c1c1c3" }}
                            />
                            <span
                              className="text-sm "
                              style={{ color: "#fff" }}
                            >
                              {type}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className=" pt-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            const currentPrimary =
                              selectedReleaseTypes.filter((t) =>
                                primaryReleaseTypes.includes(t)
                              );
                            setSelectedReleaseTypes([
                              ...currentPrimary,
                              ...secondaryReleaseTypes,
                            ]);
                          }}
                          className="text-xs hover:underline"
                          style={{ color: "#c1c1c3" }}
                        >
                          Select All
                        </button>
                        <span className="" style={{ color: "#c1c1c3" }}>
                          |
                        </span>
                        <button
                          onClick={() => {
                            const currentPrimary =
                              selectedReleaseTypes.filter((t) =>
                                primaryReleaseTypes.includes(t)
                              );
                            setSelectedReleaseTypes(currentPrimary);
                          }}
                          className="text-xs hover:underline"
                          style={{ color: "#c1c1c3" }}
                        >
                          Clear All
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          {existsInLibrary && (
            <button
              onClick={handleMonitorAll}
              disabled={processingBulk}
              className="btn btn-outline-primary btn-sm flex items-center gap-2 px-4 py-2"
            >
              {processingBulk ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Processing...</span>
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  <span className="text-sm">
                    {activeFilters ? "Add All Filtered" : "Add All"}
                  </span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
      <div className="space-y-1">
        {sortedReleaseGroups.map((releaseGroup, releaseGroupIdx) => {
            const status = getAlbumStatus(releaseGroup.id);
            const isExpanded = expandedReleaseGroup === releaseGroup.id;
            const libraryAlbumId = status?.libraryId;
            const trackKey = libraryAlbumId || releaseGroup.id;
            const tracks = albumTracks[trackKey] || null;
            const isLoadingTracks = loadingTracks[trackKey] || false;
            const isActiveStatus =
              status &&
              ["processing", "adding", "searching", "downloading", "moving"].includes(
                status.status,
              );
            const canReSearch =
              status &&
              status.libraryId &&
              !String(status.libraryId).startsWith("pending-") &&
              !isActiveStatus &&
              status.status !== "available" &&
              status.status !== "added";
            const rowBg = isExpanded
              ? "#2a2830"
              : releaseGroupIdx % 2 === 0
              ? "#211f27"
              : "#1c1a22";
            const rowHoverBg = isExpanded ? "#2a2830" : "#25232b";
            const itemBg =
              releaseGroupIdx % 2 === 0 ? "#1c1a22" : "#211f27";

            const AlbumDropdown = () => (
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
                    )}/${encodeURIComponent(releaseGroup.title)}`}
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
                            status.libraryId,
                            releaseGroup.title,
                          );
                          setAlbumDropdownOpen(null);
                        }}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 transition-colors flex items-center"
                        style={{ color: "#fff" }}
                        disabled={reSearchingAlbum === status.libraryId}
                      >
                        {reSearchingAlbum === status.libraryId ? (
                          <Loader className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <RefreshCw className="w-4 h-4 mr-2" />
                        )}
                        {reSearchingAlbum === status.libraryId
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
                        releaseGroup.id,
                        releaseGroup.title
                      );
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 transition-colors flex items-center"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete Album
                  </button>
                </div>
              </>
            );

            return (
              <div
                key={releaseGroup.id}
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
                  className="flex items-center justify-between py-2.5 px-3 cursor-pointer"
                  onClick={() =>
                    handleReleaseGroupAlbumClick(
                      releaseGroup.id,
                      status?.libraryId
                    )
                  }
                >
                  <div className="flex-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReleaseGroupAlbumClick(
                          releaseGroup.id,
                          status?.libraryId
                        );
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
                    {albumCovers[releaseGroup.id] ? (
                      <img
                        src={albumCovers[releaseGroup.id]}
                        alt={releaseGroup.title}
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
                        {releaseGroup.title}
                      </h3>
                      <div
                        className="flex items-center gap-2 mt-0.5 text-xs"
                        style={{ color: "#c1c1c3" }}
                      >
                        {releaseGroup["first-release-date"] && (
                          <span>
                            {
                              releaseGroup["first-release-date"].split(
                                "-"
                              )[0]
                            }
                          </span>
                        )}
                        {releaseGroup["primary-type"] && (
                          <span className="badge badge-primary text-xs">
                            {releaseGroup["primary-type"]}
                          </span>
                        )}
                        {releaseGroup["secondary-types"] &&
                          releaseGroup["secondary-types"].length > 0 && (
                            <span
                              className="badge text-xs"
                              style={{
                                backgroundColor: "#211f27",
                                color: "#fff",
                              }}
                            >
                              {releaseGroup["secondary-types"].join(", ")}
                            </span>
                          )}
                        {(() => {
                          const fans =
                            typeof releaseGroup.fans === "number"
                              ? releaseGroup.fans
                              : 0;
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

                  <div className="flex items-center gap-2">
                    {status ? (
                      status.status === "available" ||
                      status.status === "added" ? (
                        <>
                          <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase bg-green-500/20 text-green-400 cursor-default">
                            <CheckCircle className="w-3.5 h-3.5" />
                            {status.label || "Available"}
                          </span>
                          <div className="relative overflow-visible">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAlbumDropdownOpen(
                                  albumDropdownOpen === releaseGroup.id
                                    ? null
                                    : releaseGroup.id
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
                            {albumDropdownOpen === releaseGroup.id && (
                              <AlbumDropdown />
                            )}
                          </div>
                        </>
                      ) : status.status === "failed" ? (
                        <>
                          <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase bg-red-500/20 text-red-400 cursor-default">
                            Failed
                          </span>
                          <div className="relative overflow-visible">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAlbumDropdownOpen(
                                  albumDropdownOpen === releaseGroup.id
                                    ? null
                                    : releaseGroup.id
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
                            {albumDropdownOpen === releaseGroup.id && (
                              <AlbumDropdown />
                            )}
                          </div>
                        </>
                      ) : status.status === "monitored" ? (
                        <>
                          <span
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase cursor-default"
                            style={{
                              backgroundColor: itemBg,
                              color: "#c1c1c3",
                            }}
                          >
                            {status.label || "Monitored"}
                          </span>
                          <div className="relative overflow-visible">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAlbumDropdownOpen(
                                  albumDropdownOpen === releaseGroup.id
                                    ? null
                                    : releaseGroup.id
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
                            {albumDropdownOpen === releaseGroup.id && (
                              <AlbumDropdown />
                            )}
                          </div>
                        </>
                      ) : status.status === "processing" ||
                        status.status === "adding" ||
                        status.status === "searching" ||
                        status.status === "downloading" ||
                        status.status === "moving" ? (
                        <>
                          <span
                            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase cursor-default"
                            style={{
                              backgroundColor: itemBg,
                              color: "#c1c1c3",
                            }}
                          >
                            <Loader className="w-3.5 h-3.5 animate-spin" />
                            {status.label || "Processing"}
                          </span>
                          <div className="relative overflow-visible">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAlbumDropdownOpen(
                                  albumDropdownOpen === releaseGroup.id
                                    ? null
                                    : releaseGroup.id
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
                            {albumDropdownOpen === releaseGroup.id && (
                              <AlbumDropdown />
                            )}
                          </div>
                        </>
                      ) : (
                        <AddAlbumButton
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRequestAlbum(
                              releaseGroup.id,
                              releaseGroup.title
                            );
                          }}
                          isLoading={requestingAlbum === releaseGroup.id}
                          disabled={requestingAlbum === releaseGroup.id}
                          style={{
                            backgroundColor: itemBg,
                            borderColor: itemBg,
                          }}
                        />
                      )
                    ) : (
                      <AddAlbumButton
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRequestAlbum(
                            releaseGroup.id,
                            releaseGroup.title
                          );
                        }}
                        isLoading={requestingAlbum === releaseGroup.id}
                        disabled={requestingAlbum === releaseGroup.id}
                        style={{
                          backgroundColor: itemBg,
                          borderColor: itemBg,
                        }}
                      />
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <div
                    className="px-3 py-2 overflow-hidden"
                    style={{
                      backgroundColor:
                        releaseGroupIdx % 2 === 0 ? "#1c1a22" : "#211f27",
                    }}
                  >
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
                                status?.albumInfo?.statistics
                                  ?.percentOfTracks >= 100 ||
                                status?.albumInfo?.statistics?.sizeOnDisk >
                                  0 ? (
                                  <CheckCircle className="w-4 h-4 text-green-500" />
                                ) : status?.libraryId ? (
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

ArtistDetailsReleaseGroups.propTypes = {
  artist: PropTypes.object,
  selectedReleaseTypes: PropTypes.arrayOf(PropTypes.string),
  setSelectedReleaseTypes: PropTypes.func,
  primaryReleaseTypes: PropTypes.arrayOf(PropTypes.string),
  secondaryReleaseTypes: PropTypes.arrayOf(PropTypes.string),
  showFilterDropdown: PropTypes.bool,
  setShowFilterDropdown: PropTypes.func,
  existsInLibrary: PropTypes.bool,
  handleMonitorAll: PropTypes.func,
  processingBulk: PropTypes.bool,
  albumCovers: PropTypes.object,
  expandedReleaseGroup: PropTypes.string,
  albumTracks: PropTypes.object,
  loadingTracks: PropTypes.object,
  getAlbumStatus: PropTypes.func,
  albumDropdownOpen: PropTypes.string,
  setAlbumDropdownOpen: PropTypes.func,
  handleReleaseGroupAlbumClick: PropTypes.func,
  handleRequestAlbum: PropTypes.func,
  handleDeleteAlbumClick: PropTypes.func,
  requestingAlbum: PropTypes.string,
  reSearchingAlbum: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  handleReSearchAlbum: PropTypes.func,
  isReleaseGroupDownloadedInLibrary: PropTypes.func,
};
