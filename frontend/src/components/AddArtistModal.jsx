import { useState, useEffect, useMemo } from "react";
import {
  X,
  Loader,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  ChevronLeft,
  Music,
  Disc,
  Filter,
  CheckSquare,
  Square,
  MinusSquare,
} from "lucide-react";
import {
  getLidarrRootFolders,
  getLidarrQualityProfiles,
  getLidarrMetadataProfiles,
  addArtistToLidarr,
  getAppSettings,
  getArtistDetails,
} from "../utils/api";

const ALBUM_TYPES = ["Album", "EP", "Single", "Broadcast", "Other"];

function AddArtistModal({ artist, onClose, onSuccess }) {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [showOptions, setShowOptions] = useState(false);
  const [rootFolders, setRootFolders] = useState([]);
  const [qualityProfiles, setQualityProfiles] = useState([]);
  const [metadataProfiles, setMetadataProfiles] = useState([]);
  const [selectedRootFolder, setSelectedRootFolder] = useState("");
  const [selectedQualityProfile, setSelectedQualityProfile] = useState("");
  const [selectedMetadataProfile, setSelectedMetadataProfile] = useState("");
  const [monitored, setMonitored] = useState(true);
  const [monitorOption, setMonitorOption] = useState("all");
  const [searchForMissingAlbums, setSearchForMissingAlbums] = useState(false);
  const [albumFolders, setAlbumFolders] = useState(true);

  // Album selection state
  const [step, setStep] = useState(1); // 1 = options, 2 = album selection
  const [releaseGroups, setReleaseGroups] = useState([]);
  const [selectedAlbums, setSelectedAlbums] = useState(new Set());
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [albumFilter, setAlbumFilter] = useState("all");
  const [showSecondaryTypes, setShowSecondaryTypes] = useState(true);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, []);

  useEffect(() => {
    const fetchOptions = async () => {
      setLoading(true);
      setError(null);

      try {
        const [folders, quality, metadata, savedSettings] = await Promise.all([
          getLidarrRootFolders(),
          getLidarrQualityProfiles(),
          getLidarrMetadataProfiles(),
          getAppSettings(),
        ]);

        setRootFolders(folders);
        setQualityProfiles(quality);
        setMetadataProfiles(metadata);

        setSelectedRootFolder(
          savedSettings.rootFolderPath || (folders[0]?.path ?? "")
        );
        setSelectedQualityProfile(
          savedSettings.qualityProfileId || (quality[0]?.id ?? "")
        );
        setSelectedMetadataProfile(
          savedSettings.metadataProfileId || (metadata[0]?.id ?? "")
        );
        setMonitored(savedSettings.monitored ?? true);
        setSearchForMissingAlbums(savedSettings.searchForMissingAlbums ?? false);
        setAlbumFolders(savedSettings.albumFolders ?? true);
      } catch (err) {
        setError(
          err.response?.data?.message || "Failed to load configuration options"
        );
      } finally {
        setLoading(false);
      }
    };

    fetchOptions();
  }, []);

  // Fetch release groups when switching to album selection step
  useEffect(() => {
    const fetchReleaseGroups = async () => {
      if (step !== 2 || releaseGroups.length > 0) return;

      setLoadingAlbums(true);
      try {
        const artistData = await getArtistDetails(artist.id);
        const groups = artistData["release-groups"] || [];
        setReleaseGroups(groups);

        // Pre-select albums based on monitorOption from step 1
        const sorted = [...groups].sort((a, b) => {
          const dateA = a["first-release-date"] || "";
          const dateB = b["first-release-date"] || "";
          return dateB.localeCompare(dateA);
        });

        const initialSelection = new Set();
        if (monitorOption === "all") {
          groups.forEach((g) => initialSelection.add(g.id));
        } else if (monitorOption === "future") {
          // Don't select any existing albums
        } else if (monitorOption === "missing") {
          groups.forEach((g) => initialSelection.add(g.id));
        } else if (monitorOption === "latest" && sorted.length > 0) {
          initialSelection.add(sorted[0].id);
        } else if (monitorOption === "first" && sorted.length > 0) {
          initialSelection.add(sorted[sorted.length - 1].id);
        }
        setSelectedAlbums(initialSelection);
      } catch (err) {
        console.error("Failed to fetch release groups:", err);
        setError("Failed to load album list");
      } finally {
        setLoadingAlbums(false);
      }
    };

    fetchReleaseGroups();
  }, [step, artist.id, monitorOption, releaseGroups.length]);

  const filteredReleaseGroups = useMemo(() => {
    let filtered = releaseGroups;

    if (albumFilter !== "all") {
      filtered = filtered.filter(
        (rg) => rg["primary-type"] === albumFilter
      );
    }

    if (!showSecondaryTypes) {
      filtered = filtered.filter(
        (rg) => !rg["secondary-types"] || rg["secondary-types"].length === 0
      );
    }

    return filtered.sort((a, b) => {
      const dateA = a["first-release-date"] || "";
      const dateB = b["first-release-date"] || "";
      return dateB.localeCompare(dateA);
    });
  }, [releaseGroups, albumFilter, showSecondaryTypes]);

  const handleSubmit = async (e) => {
    e?.preventDefault();

    if (
      !selectedRootFolder ||
      !selectedQualityProfile ||
      !selectedMetadataProfile
    ) {
      setError("Please select all required options");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      // If we're on step 2 (album selection), pass selected albums
      const albumsToMonitor =
        step === 2 ? Array.from(selectedAlbums) : undefined;

      await addArtistToLidarr({
        foreignArtistId: artist.id,
        artistName: artist.name,
        qualityProfileId: parseInt(selectedQualityProfile),
        metadataProfileId: parseInt(selectedMetadataProfile),
        rootFolderPath: selectedRootFolder,
        monitored,
        monitor: step === 2 ? "none" : monitorOption,
        searchForMissingAlbums,
        albumFolders,
        selectedAlbums: albumsToMonitor,
      });

      onSuccess(artist);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to add artist to Lidarr");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectAll = () => {
    const newSelection = new Set(selectedAlbums);
    filteredReleaseGroups.forEach((rg) => newSelection.add(rg.id));
    setSelectedAlbums(newSelection);
  };

  const handleDeselectAll = () => {
    const newSelection = new Set(selectedAlbums);
    filteredReleaseGroups.forEach((rg) => newSelection.delete(rg.id));
    setSelectedAlbums(newSelection);
  };

  const handleToggleAlbum = (id) => {
    const newSelection = new Set(selectedAlbums);
    if (newSelection.has(id)) {
      newSelection.delete(id);
    } else {
      newSelection.add(id);
    }
    setSelectedAlbums(newSelection);
  };

  const getSelectionState = () => {
    const visibleIds = new Set(filteredReleaseGroups.map((rg) => rg.id));
    const selectedVisible = [...selectedAlbums].filter((id) =>
      visibleIds.has(id)
    ).length;

    if (selectedVisible === 0) return "none";
    if (selectedVisible === filteredReleaseGroups.length) return "all";
    return "partial";
  };

  const goToAlbumSelection = () => {
    setStep(2);
  };

  const goBackToOptions = () => {
    setStep(1);
    setReleaseGroups([]);
    setSelectedAlbums(new Set());
  };

  const renderStep1 = () => (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex gap-3">
        <button
          type="submit"
          className="btn btn-primary flex-1 disabled:opacity-50 h-12"
          disabled={submitting}
        >
          {submitting ? (
            <>
              <Loader className="w-5 h-5 animate-spin mr-2" />
              Adding to Lidarr...
            </>
          ) : (
            <>
              <CheckCircle className="w-5 h-5 mr-2" />
              Add to Lidarr
            </>
          )}
        </button>
        <button
          type="button"
          onClick={goToAlbumSelection}
          className="btn btn-secondary flex items-center justify-center px-4"
          title="Select specific albums"
          disabled={submitting}
        >
          <Disc className="w-5 h-5 mr-2" />
          Select Albums
        </button>
        <button
          type="button"
          onClick={() => setShowOptions(!showOptions)}
          className="btn btn-secondary flex items-center justify-center px-4"
          title="Advanced Options"
          disabled={submitting}
        >
          {showOptions ? (
            <ChevronUp className="w-5 h-5" />
          ) : (
            <ChevronDown className="w-5 h-5" />
          )}
        </button>
      </div>

      {showOptions && (
        <div className="space-y-6 pt-4 border-t border-gray-200 dark:border-gray-800">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Root Folder <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedRootFolder}
              onChange={(e) => setSelectedRootFolder(e.target.value)}
              className="input"
              required
              disabled={submitting}
            >
              {rootFolders.map((folder) => (
                <option key={folder.id} value={folder.path}>
                  {folder.path}
                  {folder.freeSpace &&
                    ` (${(folder.freeSpace / 1024 / 1024 / 1024).toFixed(2)} GB free)`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Quality Profile <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedQualityProfile}
              onChange={(e) => setSelectedQualityProfile(e.target.value)}
              className="input"
              required
              disabled={submitting}
            >
              {qualityProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Metadata Profile <span className="text-red-500">*</span>
            </label>
            <select
              value={selectedMetadataProfile}
              onChange={(e) => setSelectedMetadataProfile(e.target.value)}
              className="input"
              required
              disabled={submitting}
            >
              {metadataProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-4 pt-4 border-t border-gray-200 dark:border-gray-800">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">
              Options
            </h3>

            <div className="flex items-start">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  id="monitored"
                  checked={monitored}
                  onChange={(e) => setMonitored(e.target.checked)}
                  className="w-4 h-4 text-primary-600 border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded focus:ring-primary-500"
                  disabled={submitting}
                />
              </div>
              <div className="ml-3">
                <label
                  htmlFor="monitored"
                  className="font-medium text-gray-700 dark:text-gray-300"
                >
                  Monitor Artist
                </label>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Lidarr will search for and download new releases
                </p>
              </div>
            </div>

            {monitored && (
              <div className="ml-8 mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Monitor Option
                </label>
                <select
                  value={monitorOption}
                  onChange={(e) => setMonitorOption(e.target.value)}
                  className="input text-sm"
                  disabled={submitting}
                >
                  <option value="all">All Albums</option>
                  <option value="future">Future Albums</option>
                  <option value="missing">Missing Albums</option>
                  <option value="latest">Latest Album</option>
                  <option value="first">First Album</option>
                  <option value="none">None (Artist Only)</option>
                </select>
              </div>
            )}

            <div className="flex items-start">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  id="searchForMissingAlbums"
                  checked={searchForMissingAlbums}
                  onChange={(e) => setSearchForMissingAlbums(e.target.checked)}
                  className="w-4 h-4 text-primary-600 border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded focus:ring-primary-500"
                  disabled={submitting}
                />
              </div>
              <div className="ml-3">
                <label
                  htmlFor="searchForMissingAlbums"
                  className="font-medium text-gray-700 dark:text-gray-300"
                >
                  Search for Missing Albums on Add
                </label>
              </div>
            </div>

            <div className="flex items-start">
              <div className="flex items-center h-5">
                <input
                  type="checkbox"
                  id="albumFolders"
                  checked={albumFolders}
                  onChange={(e) => setAlbumFolders(e.target.checked)}
                  className="w-4 h-4 text-primary-600 border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded focus:ring-primary-500"
                  disabled={submitting}
                />
              </div>
              <div className="ml-3">
                <label
                  htmlFor="albumFolders"
                  className="font-medium text-gray-700 dark:text-gray-300"
                >
                  Create Album Folders
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {!showOptions && (
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary flex-1"
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      )}

      {showOptions && (
        <div className="flex gap-3 pt-4 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary flex-1"
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      )}
    </form>
  );

  const renderStep2 = () => {
    const selectionState = getSelectionState();

    return (
      <div className="space-y-4">
        {/* Filter controls */}
        <div className="flex flex-wrap items-center gap-3 pb-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-500" />
            <select
              value={albumFilter}
              onChange={(e) => setAlbumFilter(e.target.value)}
              className="input text-sm py-1.5"
            >
              <option value="all">All Types</option>
              {ALBUM_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}s
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={showSecondaryTypes}
              onChange={(e) => setShowSecondaryTypes(e.target.checked)}
              className="w-4 h-4 text-primary-600 border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded focus:ring-primary-500"
            />
            Show compilations/live/etc
          </label>

          <div className="flex-1" />

          <button
            type="button"
            onClick={
              selectionState === "all" ? handleDeselectAll : handleSelectAll
            }
            className="btn btn-secondary btn-sm flex items-center gap-1.5"
          >
            {selectionState === "none" && (
              <>
                <Square className="w-4 h-4" />
                Select All
              </>
            )}
            {selectionState === "partial" && (
              <>
                <MinusSquare className="w-4 h-4" />
                Select All
              </>
            )}
            {selectionState === "all" && (
              <>
                <CheckSquare className="w-4 h-4" />
                Deselect All
              </>
            )}
          </button>
        </div>

        {/* Selection summary */}
        <div className="text-sm text-gray-600 dark:text-gray-400">
          {selectedAlbums.size} of {releaseGroups.length} albums selected
          {filteredReleaseGroups.length !== releaseGroups.length && (
            <span className="ml-1">
              (showing {filteredReleaseGroups.length} filtered)
            </span>
          )}
        </div>

        {/* Album list */}
        {loadingAlbums ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader className="w-10 h-10 text-primary-600 animate-spin mb-4" />
            <p className="text-gray-600 dark:text-gray-400">Loading albums...</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {filteredReleaseGroups.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <Music className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>No albums match the current filter</p>
              </div>
            ) : (
              filteredReleaseGroups.map((releaseGroup) => {
                const isSelected = selectedAlbums.has(releaseGroup.id);
                return (
                  <div
                    key={releaseGroup.id}
                    onClick={() => handleToggleAlbum(releaseGroup.id)}
                    className={`flex items-center p-3 rounded-lg cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-700"
                        : "bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent"
                    }`}
                  >
                    <div className="flex-shrink-0 mr-3">
                      {isSelected ? (
                        <CheckSquare className="w-5 h-5 text-primary-600" />
                      ) : (
                        <Square className="w-5 h-5 text-gray-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-gray-900 dark:text-gray-100 truncate">
                        {releaseGroup.title}
                      </h4>
                      <div className="flex items-center gap-2 mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                        {releaseGroup["first-release-date"] && (
                          <span>
                            {releaseGroup["first-release-date"].split("-")[0]}
                          </span>
                        )}
                        {releaseGroup["primary-type"] && (
                          <span className="badge badge-primary text-xs">
                            {releaseGroup["primary-type"]}
                          </span>
                        )}
                        {releaseGroup["secondary-types"]?.length > 0 && (
                          <span className="badge bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs">
                            {releaseGroup["secondary-types"].join(", ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-4 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={goBackToOptions}
            className="btn btn-secondary flex items-center"
            disabled={submitting}
          >
            <ChevronLeft className="w-5 h-5 mr-1" />
            Back
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="btn btn-primary flex-1 disabled:opacity-50"
            disabled={submitting || selectedAlbums.size === 0}
          >
            {submitting ? (
              <>
                <Loader className="w-5 h-5 animate-spin mr-2" />
                Adding to Lidarr...
              </>
            ) : (
              <>
                <CheckCircle className="w-5 h-5 mr-2" />
                Add with {selectedAlbums.size} Album
                {selectedAlbums.size !== 1 ? "s" : ""}
              </>
            )}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center justify-between rounded-t-xl z-10">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {step === 1 ? "Add Artist to Lidarr" : "Select Albums"}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {artist.name}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            disabled={submitting}
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="px-6 py-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader className="w-12 h-12 text-primary-600 animate-spin mb-4" />
              <p className="text-gray-600 dark:text-gray-400">
                Loading configuration options...
              </p>
            </div>
          ) : error ? (
            <div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-500/20 rounded-lg p-4 flex items-start">
              <AlertCircle className="w-5 h-5 text-red-500 mr-3 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-red-900 dark:text-red-400 font-semibold">
                  Error
                </h3>
                <p className="text-red-700 dark:text-red-300 mt-1">{error}</p>
              </div>
            </div>
          ) : step === 1 ? (
            renderStep1()
          ) : (
            renderStep2()
          )}
        </div>
      </div>
    </div>
  );
}

export default AddArtistModal;
