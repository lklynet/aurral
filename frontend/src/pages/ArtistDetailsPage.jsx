import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Loader,
  Music,
  ExternalLink,
  CheckCircle,
  Plus,
  ArrowLeft,
  Calendar,
  MapPin,
  Tag,
  Sparkles,
  Filter,
  CheckSquare,
  Square,
  MinusSquare,
  Eye,
  EyeOff,
  Search,
  X,
} from "lucide-react";
import {
  getArtistDetails,
  getArtistCover,
  lookupArtistInLidarr,
  getLidarrAlbums,
  updateLidarrAlbum,
  searchLidarrAlbum,
  getSimilarArtistsForArtist,
  lookupArtistsInLidarrBatch,
  bulkUpdateAlbumMonitoring,
} from "../utils/api";
import { useToast } from "../contexts/ToastContext";
import AddArtistModal from "../components/AddArtistModal";
import ArtistImage from "../components/ArtistImage";

const ALBUM_TYPES = ["Album", "EP", "Single", "Broadcast", "Other"];

function ArtistDetailsPage() {
  const { mbid } = useParams();
  const navigate = useNavigate();
  const [artist, setArtist] = useState(null);
  const [coverImages, setCoverImages] = useState([]);
  const [lidarrArtist, setLidarrArtist] = useState(null);
  const [lidarrAlbums, setLidarrAlbums] = useState([]);
  const [similarArtists, setSimilarArtists] = useState([]);
  const [existingSimilar, setExistingSimilar] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [existsInLidarr, setExistsInLidarr] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [artistToAdd, setArtistToAdd] = useState(null);
  const [requestingAlbum, setRequestingAlbum] = useState(null);
  const { showSuccess, showError } = useToast();

  // Album management state
  const [albumFilter, setAlbumFilter] = useState("all");
  const [showSecondaryTypes, setShowSecondaryTypes] = useState(true);
  const [selectedAlbums, setSelectedAlbums] = useState(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [showOnlyMonitored, setShowOnlyMonitored] = useState(false);

  useEffect(() => {
    const fetchArtistData = async () => {
      setLoading(true);
      setError(null);

      try {
        const artistData = await getArtistDetails(mbid);
        setArtist(artistData);

        try {
          const similarData = await getSimilarArtistsForArtist(mbid);
          setSimilarArtists(similarData.artists || []);
          if (similarData.artists?.length > 0) {
            const similarMbids = similarData.artists.map((a) => a.id);
            const existingMap = await lookupArtistsInLidarrBatch(similarMbids);
            setExistingSimilar(existingMap);
          }
        } catch (err) {
          console.error("Failed to fetch similar artists:", err);
        }

        try {
          const coverData = await getArtistCover(mbid);
          if (coverData.images && coverData.images.length > 0) {
            setCoverImages(coverData.images);
          }
        } catch (err) {
          console.log("No cover art available");
        }

        try {
          const lookup = await lookupArtistInLidarr(mbid);
          setExistsInLidarr(lookup.exists);
          if (lookup.exists && lookup.artist) {
            setLidarrArtist(lookup.artist);
            setTimeout(async () => {
              try {
                const albums = await getLidarrAlbums(lookup.artist.id);
                console.log("Lidarr Albums:", albums);
                setLidarrAlbums(albums);
              } catch (err) {
                console.log("Retrying album fetch...");
                setTimeout(async () => {
                  try {
                    const albums = await getLidarrAlbums(lookup.artist.id);
                    setLidarrAlbums(albums);
                  } catch (e) {}
                }, 2000);
              }
            }, 1000);
          }
        } catch (err) {
          console.error("Failed to lookup artist in Lidarr:", err);
        }
      } catch (err) {
        setError(
          err.response?.data?.message || "Failed to fetch artist details"
        );
      } finally {
        setLoading(false);
      }
    };

    fetchArtistData();
  }, [mbid]);

  const handleAddArtistClick = () => {
    setShowAddModal(true);
  };

  const handleAddSuccess = async (addedArtist) => {
    if (!artistToAdd) {
      setExistsInLidarr(true);
    }

    setShowAddModal(false);
    setArtistToAdd(null);
    showSuccess(`Successfully added ${addedArtist.name} to Lidarr!`);

    if (addedArtist.id) {
      setExistingSimilar((prev) => ({ ...prev, [addedArtist.id]: true }));
    }

    setTimeout(async () => {
      try {
        const lookup = await lookupArtistInLidarr(mbid);
        if (lookup.exists && lookup.artist) {
          setLidarrArtist(lookup.artist);
          const albums = await getLidarrAlbums(lookup.artist.id);
          setLidarrAlbums(albums);
        }
      } catch (err) {
        console.error("Failed to refresh Lidarr data", err);
      }
    }, 1500);
  };

  const handleRequestAlbum = async (albumId, title) => {
    setRequestingAlbum(albumId);
    try {
      const lidarrAlbum = lidarrAlbums.find(
        (a) => a.foreignAlbumId === albumId
      );

      if (!lidarrAlbum) {
        throw new Error("Album not found in Lidarr");
      }

      await updateLidarrAlbum(lidarrAlbum.id, {
        ...lidarrAlbum,
        monitored: true,
      });

      await searchLidarrAlbum([lidarrAlbum.id]);

      setLidarrAlbums((prev) =>
        prev.map((a) =>
          a.id === lidarrAlbum.id ? { ...a, monitored: true } : a
        )
      );

      showSuccess(`Requested album: ${title}`);
    } catch (err) {
      showError(`Failed to request album: ${err.message}`);
    } finally {
      setRequestingAlbum(null);
    }
  };

  const handleUnmonitorAlbum = async (albumId, title) => {
    setRequestingAlbum(albumId);
    try {
      const lidarrAlbum = lidarrAlbums.find(
        (a) => a.foreignAlbumId === albumId
      );

      if (!lidarrAlbum) {
        throw new Error("Album not found in Lidarr");
      }

      await updateLidarrAlbum(lidarrAlbum.id, {
        ...lidarrAlbum,
        monitored: false,
      });

      setLidarrAlbums((prev) =>
        prev.map((a) =>
          a.id === lidarrAlbum.id ? { ...a, monitored: false } : a
        )
      );

      showSuccess(`Unmonitored album: ${title}`);
    } catch (err) {
      showError(`Failed to unmonitor album: ${err.message}`);
    } finally {
      setRequestingAlbum(null);
    }
  };

  const handleBulkMonitor = async (shouldMonitor) => {
    if (selectedAlbums.size === 0 || !lidarrArtist) return;

    setBulkUpdating(true);
    try {
      // Get Lidarr album IDs from selected MusicBrainz IDs
      const lidarrAlbumIds = [];
      for (const mbAlbumId of selectedAlbums) {
        const lidarrAlbum = lidarrAlbums.find(
          (a) => a.foreignAlbumId === mbAlbumId
        );
        if (lidarrAlbum) {
          lidarrAlbumIds.push(lidarrAlbum.id);
        }
      }

      if (lidarrAlbumIds.length === 0) {
        throw new Error("No matching albums found in Lidarr");
      }

      await bulkUpdateAlbumMonitoring(
        lidarrArtist.id,
        lidarrAlbumIds,
        shouldMonitor,
        shouldMonitor // searchAfter only if monitoring
      );

      // Update local state
      setLidarrAlbums((prev) =>
        prev.map((a) =>
          lidarrAlbumIds.includes(a.id) ? { ...a, monitored: shouldMonitor } : a
        )
      );

      showSuccess(
        `${shouldMonitor ? "Monitored" : "Unmonitored"} ${lidarrAlbumIds.length} album${lidarrAlbumIds.length !== 1 ? "s" : ""}`
      );
      setSelectedAlbums(new Set());
      setIsSelectionMode(false);
    } catch (err) {
      showError(`Failed to update albums: ${err.message}`);
    } finally {
      setBulkUpdating(false);
    }
  };

  const getAlbumStatus = (releaseGroupId) => {
    if (!existsInLidarr || lidarrAlbums.length === 0) return null;

    const album = lidarrAlbums.find((a) => a.foreignAlbumId === releaseGroupId);

    if (!album) {
      return null;
    }

    if (album.monitored) {
      if (album.statistics?.percentOfTracks === 100) {
        return { status: "available", label: "Available" };
      }
      return { status: "processing", label: "Processing" };
    }

    return { status: "unmonitored", label: "Not Monitored" };
  };

  const handleModalClose = () => {
    setShowAddModal(false);
  };

  const formatLifeSpan = (lifeSpan) => {
    if (!lifeSpan) return null;
    const { begin, end, ended } = lifeSpan;
    if (!begin) return null;

    const beginYear = begin.split("-")[0];
    if (ended && end) {
      const endYear = end.split("-")[0];
      return `${beginYear} - ${endYear}`;
    }
    return `${beginYear} - Present`;
  };

  const getArtistType = (type) => {
    const types = {
      Person: "Solo Artist",
      Group: "Band",
      Orchestra: "Orchestra",
      Choir: "Choir",
      Character: "Character",
      Other: "Other",
    };
    return types[type] || type;
  };

  const getCoverImage = () => {
    if (coverImages.length > 0) {
      const frontCover = coverImages.find((img) => img.front);
      return frontCover?.image || coverImages[0]?.image;
    }
    return null;
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

  const filteredReleaseGroups = useMemo(() => {
    if (!artist?.["release-groups"]) return [];

    let filtered = artist["release-groups"];

    if (albumFilter !== "all") {
      filtered = filtered.filter((rg) => rg["primary-type"] === albumFilter);
    }

    if (!showSecondaryTypes) {
      filtered = filtered.filter(
        (rg) => !rg["secondary-types"] || rg["secondary-types"].length === 0
      );
    }

    if (showOnlyMonitored && existsInLidarr) {
      filtered = filtered.filter((rg) => {
        const status = getAlbumStatus(rg.id);
        return status && status.status !== "unmonitored";
      });
    }

    return filtered.sort((a, b) => {
      const dateA = a["first-release-date"] || "";
      const dateB = b["first-release-date"] || "";
      return dateB.localeCompare(dateA);
    });
  }, [
    artist,
    albumFilter,
    showSecondaryTypes,
    showOnlyMonitored,
    existsInLidarr,
    lidarrAlbums,
  ]);

  const handleSelectAll = () => {
    const newSelection = new Set(selectedAlbums);
    filteredReleaseGroups.forEach((rg) => {
      // Only select albums that are in Lidarr
      const status = getAlbumStatus(rg.id);
      if (status) {
        newSelection.add(rg.id);
      }
    });
    setSelectedAlbums(newSelection);
  };

  const handleDeselectAll = () => {
    const newSelection = new Set(selectedAlbums);
    filteredReleaseGroups.forEach((rg) => newSelection.delete(rg.id));
    setSelectedAlbums(newSelection);
  };

  const getSelectionState = () => {
    const visibleIds = new Set(
      filteredReleaseGroups
        .filter((rg) => getAlbumStatus(rg.id))
        .map((rg) => rg.id)
    );
    const selectedVisible = [...selectedAlbums].filter((id) =>
      visibleIds.has(id)
    ).length;

    if (selectedVisible === 0) return "none";
    if (selectedVisible === visibleIds.size) return "all";
    return "partial";
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <Loader className="w-12 h-12 text-primary-600 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <div className="text-center py-12">
          <Music className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-gray-700 dark:text-gray-200 mb-2">
            Error Loading Artist
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-6">{error}</p>
          <button
            onClick={() => navigate("/search")}
            className="btn btn-primary"
          >
            Back to Search
          </button>
        </div>
      </div>
    );
  }

  if (!artist) {
    return null;
  }

  const coverImage = getCoverImage();
  const lifeSpan = formatLifeSpan(artist["life-span"]);
  const selectionState = getSelectionState();

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => navigate(-1)}
        className="btn btn-secondary mb-6 inline-flex items-center"
      >
        <ArrowLeft className="w-5 h-5 mr-2" />
        Back
      </button>

      <div className="card mb-8">
        <div className="flex flex-col md:flex-row gap-6">
          <div className="w-full md:w-64 h-64 flex-shrink-0 bg-gray-200 dark:bg-gray-800 rounded-lg overflow-hidden">
            {coverImage ? (
              <img
                src={coverImage}
                alt={artist.name}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Music className="w-24 h-24 text-gray-400 dark:text-gray-600" />
              </div>
            )}
          </div>

          <div className="flex-1">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {artist.name}
            </h1>

            {artist["sort-name"] && artist["sort-name"] !== artist.name && (
              <p className="text-lg text-gray-600 dark:text-gray-400 mb-4">
                {artist["sort-name"]}
              </p>
            )}

            {artist.disambiguation && (
              <p className="text-gray-600 dark:text-gray-400 italic mb-4">
                {artist.disambiguation}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
              {artist.type && (
                <div className="flex items-center text-gray-700 dark:text-gray-300">
                  <Music className="w-5 h-5 mr-2 text-gray-400 dark:text-gray-500" />
                  <span className="font-medium mr-2">Type:</span>
                  <span>{getArtistType(artist.type)}</span>
                </div>
              )}

              {lifeSpan && (
                <div className="flex items-center text-gray-700 dark:text-gray-300">
                  <Calendar className="w-5 h-5 mr-2 text-gray-400 dark:text-gray-500" />
                  <span className="font-medium mr-2">Active:</span>
                  <span>{lifeSpan}</span>
                </div>
              )}

              {artist.country && (
                <div className="flex items-center text-gray-700 dark:text-gray-300">
                  <MapPin className="w-5 h-5 mr-2 text-gray-400 dark:text-gray-500" />
                  <span className="font-medium mr-2">Country:</span>
                  <span>{artist.country}</span>
                </div>
              )}

              {artist.area && artist.area.name && (
                <div className="flex items-center text-gray-700 dark:text-gray-300">
                  <MapPin className="w-5 h-5 mr-2 text-gray-400 dark:text-gray-500" />
                  <span className="font-medium mr-2">Area:</span>
                  <span>{artist.area.name}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-3">
              {existsInLidarr ? (
                <button className="btn btn-success inline-flex items-center cursor-default">
                  <CheckCircle className="w-5 h-5 mr-2" />
                  In Your Library
                </button>
              ) : (
                <button
                  onClick={handleAddArtistClick}
                  className="btn btn-primary inline-flex items-center"
                >
                  <Plus className="w-5 h-5 mr-2" />
                  Add to Lidarr
                </button>
              )}

              <a
                href={`https://musicbrainz.org/artist/${mbid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary inline-flex items-center"
              >
                <ExternalLink className="w-5 h-5 mr-2" />
                View on MusicBrainz
              </a>
            </div>
          </div>
        </div>
      </div>

      {((artist.tags && artist.tags.length > 0) ||
        (artist.genres && artist.genres.length > 0)) && (
        <div className="card mb-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4 flex items-center">
            <Tag className="w-6 h-6 mr-2" />
            Tags & Genres
          </h2>
          <div className="flex flex-wrap gap-2">
            {artist.genres &&
              artist.genres.map((genre, idx) => (
                <span
                  key={`genre-${idx}`}
                  className="badge badge-primary text-sm px-3 py-1"
                >
                  {genre.name}
                </span>
              ))}
            {artist.tags &&
              artist.tags.map((tag, idx) => (
                <span
                  key={`tag-${idx}`}
                  className="badge bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-sm px-3 py-1"
                >
                  {tag.name}
                </span>
              ))}
          </div>
        </div>
      )}

      {artist["release-groups"] && artist["release-groups"].length > 0 && (
        <div className="card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              Albums & Releases ({artist["release-groups"].length})
            </h2>

            {existsInLidarr && (
              <button
                onClick={() => {
                  setIsSelectionMode(!isSelectionMode);
                  if (isSelectionMode) {
                    setSelectedAlbums(new Set());
                  }
                }}
                className={`btn ${isSelectionMode ? "btn-primary" : "btn-secondary"} btn-sm`}
              >
                {isSelectionMode ? (
                  <>
                    <X className="w-4 h-4 mr-1.5" />
                    Cancel Selection
                  </>
                ) : (
                  <>
                    <CheckSquare className="w-4 h-4 mr-1.5" />
                    Select Albums
                  </>
                )}
              </button>
            )}
          </div>

          {/* Filter controls */}
          <div className="flex flex-wrap items-center gap-3 pb-4 mb-4 border-b border-gray-200 dark:border-gray-800">
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
              Compilations/Live
            </label>

            {existsInLidarr && (
              <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={showOnlyMonitored}
                  onChange={(e) => setShowOnlyMonitored(e.target.checked)}
                  className="w-4 h-4 text-primary-600 border-gray-300 dark:border-gray-600 dark:bg-gray-800 rounded focus:ring-primary-500"
                />
                Monitored Only
              </label>
            )}

            {isSelectionMode && (
              <>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={
                    selectionState === "all"
                      ? handleDeselectAll
                      : handleSelectAll
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
              </>
            )}
          </div>

          {/* Bulk action bar */}
          {isSelectionMode && selectedAlbums.size > 0 && (
            <div className="flex items-center gap-3 p-3 mb-4 bg-primary-50 dark:bg-primary-900/20 rounded-lg border border-primary-200 dark:border-primary-700">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {selectedAlbums.size} album
                {selectedAlbums.size !== 1 ? "s" : ""} selected
              </span>
              <div className="flex-1" />
              <button
                onClick={() => handleBulkMonitor(true)}
                disabled={bulkUpdating}
                className="btn btn-primary btn-sm flex items-center gap-1.5"
              >
                {bulkUpdating ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
                Monitor & Search
              </button>
              <button
                onClick={() => handleBulkMonitor(false)}
                disabled={bulkUpdating}
                className="btn btn-secondary btn-sm flex items-center gap-1.5"
              >
                {bulkUpdating ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <EyeOff className="w-4 h-4" />
                )}
                Unmonitor
              </button>
            </div>
          )}

          {/* Album list */}
          <div className="space-y-3 max-h-[500px] overflow-y-auto">
            {filteredReleaseGroups.length === 0 ? (
              <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                <Music className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>No albums match the current filter</p>
              </div>
            ) : (
              filteredReleaseGroups.map((releaseGroup) => {
                const status = getAlbumStatus(releaseGroup.id);
                const isSelected = selectedAlbums.has(releaseGroup.id);
                const canSelect = existsInLidarr && status;

                return (
                  <div
                    key={releaseGroup.id}
                    onClick={
                      isSelectionMode && canSelect
                        ? () => handleToggleAlbum(releaseGroup.id)
                        : undefined
                    }
                    className={`flex items-center justify-between p-4 rounded-lg transition-colors ${
                      isSelectionMode && canSelect
                        ? "cursor-pointer"
                        : "cursor-default"
                    } ${
                      isSelected
                        ? "bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-700"
                        : "bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800 border border-transparent"
                    }`}
                  >
                    {isSelectionMode && (
                      <div className="flex-shrink-0 mr-3">
                        {canSelect ? (
                          isSelected ? (
                            <CheckSquare className="w-5 h-5 text-primary-600" />
                          ) : (
                            <Square className="w-5 h-5 text-gray-400" />
                          )
                        ) : (
                          <Square className="w-5 h-5 text-gray-300 dark:text-gray-600" />
                        )}
                      </div>
                    )}

                    <div className="flex-1">
                      <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                        {releaseGroup.title}
                      </h3>
                      <div className="flex items-center gap-3 mt-1 text-sm text-gray-600 dark:text-gray-400">
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
                        {releaseGroup["secondary-types"] &&
                          releaseGroup["secondary-types"].length > 0 && (
                            <span className="badge bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs">
                              {releaseGroup["secondary-types"].join(", ")}
                            </span>
                          )}
                      </div>
                    </div>

                    {!isSelectionMode && (
                      <div className="flex items-center gap-2">
                        {status ? (
                          status.status === "available" ? (
                            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 cursor-default">
                              <CheckCircle className="w-3.5 h-3.5" />
                              Available
                            </span>
                          ) : status.status === "processing" ? (
                            <div className="flex items-center gap-2">
                              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 cursor-default">
                                <Loader className="w-3.5 h-3.5 animate-spin" />
                                Processing
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleUnmonitorAlbum(
                                    releaseGroup.id,
                                    releaseGroup.title
                                  );
                                }}
                                disabled={requestingAlbum === releaseGroup.id}
                                className="btn btn-secondary btn-sm"
                                title="Unmonitor this album"
                              >
                                {requestingAlbum === releaseGroup.id ? (
                                  <Loader className="w-4 h-4 animate-spin" />
                                ) : (
                                  <EyeOff className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRequestAlbum(
                                  releaseGroup.id,
                                  releaseGroup.title
                                );
                              }}
                              disabled={requestingAlbum === releaseGroup.id}
                              className="btn btn-primary btn-sm"
                            >
                              {requestingAlbum === releaseGroup.id ? (
                                <Loader className="w-4 h-4 animate-spin" />
                              ) : (
                                "Request"
                              )}
                            </button>
                          )
                        ) : existsInLidarr ? (
                          <span className="text-xs text-gray-400 italic">
                            Not in Lidarr
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 italic">
                            Add Artist First
                          </span>
                        )}

                        <a
                          href={`https://musicbrainz.org/release-group/${releaseGroup.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-secondary btn-sm ml-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {artist.aliases && artist.aliases.length > 0 && (
        <div className="card mt-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            Also Known As
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {artist.aliases.slice(0, 12).map((alias, idx) => (
              <div
                key={idx}
                className="text-gray-700 dark:text-gray-300 p-2 bg-gray-50 dark:bg-gray-800 rounded"
              >
                {alias.name}
                {alias.locale && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                    ({alias.locale})
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {similarArtists.length > 0 && (
        <div className="mt-12">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6 flex items-center">
            <Sparkles className="w-6 h-6 mr-2 text-primary-500" />
            Similar Artists
          </h2>
          <div className="flex overflow-x-auto pb-4 gap-4 no-scrollbar">
            {similarArtists.map((similar) => (
              <div
                key={similar.id}
                className="flex-shrink-0 w-40 group cursor-pointer"
                onClick={() => navigate(`/artist/${similar.id}`)}
              >
                <div className="relative aspect-square rounded-xl overflow-hidden bg-gray-200 dark:bg-gray-800 mb-2 shadow-sm group-hover:shadow-md transition-all">
                  <ArtistImage
                    src={similar.image}
                    mbid={similar.id}
                    alt={similar.name}
                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                  />

                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                    {!existingSimilar[similar.id] && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setArtistToAdd(similar);
                        }}
                        className="p-1.5 bg-primary-500 text-white rounded-full hover:bg-primary-600 transition-colors"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {existingSimilar[similar.id] && (
                    <div className="absolute top-2 right-2 bg-green-500 text-white p-1 rounded-full shadow-md">
                      <CheckCircle className="w-2.5 h-2.5" />
                    </div>
                  )}

                  {similar.match && (
                    <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-sm text-white text-[10px] px-1.5 py-0.5 rounded font-medium">
                      {similar.match}% Match
                    </div>
                  )}
                </div>
                <h3 className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate group-hover:text-primary-500 transition-colors">
                  {similar.name}
                </h3>
              </div>
            ))}
          </div>
        </div>
      )}

      {showAddModal && artist && (
        <AddArtistModal
          artist={{
            id: mbid,
            name: artist.name,
            type: artist.type,
            country: artist.country,
            "life-span": artist["life-span"],
          }}
          onClose={handleModalClose}
          onSuccess={handleAddSuccess}
        />
      )}

      {artistToAdd && (
        <AddArtistModal
          artist={{
            id: artistToAdd.id,
            name: artistToAdd.name,
          }}
          onClose={() => setArtistToAdd(null)}
          onSuccess={handleAddSuccess}
        />
      )}
    </div>
  );
}

export default ArtistDetailsPage;
