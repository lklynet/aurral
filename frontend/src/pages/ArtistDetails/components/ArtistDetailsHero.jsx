import { useState } from "react";
import PropTypes from "prop-types";
import {
  Loader,
  Music,
  ExternalLink,
  CheckCircle,
  RefreshCw,
  ChevronDown,
  Calendar,
  MapPin,
  Trash2,
  Play,
  Pause,
  Pencil,
  Volume2,
  VolumeX,
} from "lucide-react";
import { getCoverImage, getTagColor, formatLifeSpan, getArtistType } from "../utils";
import AddToLibraryButton from "../../../components/AddToLibraryButton";

export function ArtistDetailsHero({
  artist,
  libraryArtist,
  appSettings,
  coverImages,
  loadingCover,
  loadingLibrary,
  existsInLibrary,
  showRemoveDropdown,
  setShowRemoveDropdown,
  showMonitorOptionMenu,
  setShowMonitorOptionMenu,
  updatingMonitor,
  canChangeMonitoring,
  getCurrentMonitorOption,
  handleUpdateMonitorOption,
  canDeleteArtist,
  handleDeleteClick,
  canAddArtist,
  handleAddToLibrary,
  addingToLibrary,
  canRefreshArtist,
  handleRefreshArtist,
  refreshingArtist,
  onNavigate,
  loadingPreview,
  previewTracks,
  previewAudioRef,
  playingPreviewId,
  previewProgress,
  previewSnappingBack,
  previewVolume,
  setPreviewVolume,
  handlePreviewPlay,
  onEditIds,
}) {
  const coverImage = getCoverImage(coverImages);
  const lifeSpan = formatLifeSpan(artist["life-span"]);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const lidarrArtistId =
    artist?.id ||
    libraryArtist?.foreignArtistId ||
    libraryArtist?.mbid ||
    artist?._lidarrData?.foreignArtistId;
  const lidarrUrl =
    appSettings?.integrations?.lidarr?.externalUrl ||
    appSettings?.integrations?.lidarr?.url;
  const lidarrArtistLink =
    lidarrUrl && lidarrArtistId
      ? `${lidarrUrl.replace(/\/$/, "")}/${
          existsInLibrary
            ? `artist/${lidarrArtistId}`
            : `add/search?term=lidarr:${encodeURIComponent(lidarrArtistId)}`
        }`
      : null;

  return (
    <div className="card mb-8 relative">
      <div className="flex flex-col md:flex-row gap-6">
        <div
          className="w-full md:w-64 h-64 flex-shrink-0 overflow-hidden relative"
          style={{ backgroundColor: "#211f27" }}
        >
          {loadingCover ? (
            <div className="w-full h-full flex items-center justify-center">
              <Loader
                className="w-12 h-12 animate-spin"
                style={{ color: "#c1c1c3" }}
              />
            </div>
          ) : coverImage ? (
            <img
              src={coverImage}
              alt={artist.name}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Music className="w-24 h-24" style={{ color: "#c1c1c3" }} />
            </div>
          )}
        </div>

        <div className="flex-1">
          <div className="flex justify-between items-start gap-4">
            <h1 className="text-4xl font-bold mb-2" style={{ color: "#fff" }}>
              {artist.name}
            </h1>
            {existsInLibrary && canRefreshArtist && (
              <button
                onClick={handleRefreshArtist}
                disabled={refreshingArtist}
                className="btn btn-secondary btn-sm p-2 flex-shrink-0"
                title="Refresh & Scan Artist"
              >
                {refreshingArtist ? (
                  <Loader className="w-5 h-5 animate-spin" />
                ) : (
                  <RefreshCw className="w-5 h-5" />
                )}
              </button>
            )}
          </div>

          {artist["sort-name"] && artist["sort-name"] !== artist.name && (
            <p className="text-lg mb-4" style={{ color: "#c1c1c3" }}>
              {artist["sort-name"]}
            </p>
          )}

          {artist.disambiguation && (
            <p className="italic mb-4" style={{ color: "#c1c1c3" }}>
              {artist.disambiguation}
            </p>
          )}

          {artist.bio && (
            <p
              className="text-sm mb-4 line-clamp-6 max-w-2xl"
              style={{ color: "#c1c1c3" }}
              title={artist.bio}
            >
              {artist.bio}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            {artist.type && (
              <div className="flex items-center" style={{ color: "#fff" }}>
                <Music
                  className="w-5 h-5 mr-2"
                  style={{ color: "#c1c1c3" }}
                />
                <span className="font-medium mr-2">Type:</span>
                <span>{getArtistType(artist.type)}</span>
              </div>
            )}

            {lifeSpan && (
              <div className="flex items-center" style={{ color: "#fff" }}>
                <Calendar
                  className="w-5 h-5 mr-2"
                  style={{ color: "#c1c1c3" }}
                />
                <span className="font-medium mr-2">Active:</span>
                <span>{lifeSpan}</span>
              </div>
            )}

            {artist.country && (
              <div className="flex items-center" style={{ color: "#fff" }}>
                <MapPin
                  className="w-5 h-5 mr-2"
                  style={{ color: "#c1c1c3" }}
                />
                <span className="font-medium mr-2">Country:</span>
                <span>{artist.country}</span>
              </div>
            )}

            {artist.area && artist.area.name && (
              <div className="flex items-center" style={{ color: "#fff" }}>
                <MapPin
                  className="w-5 h-5 mr-2"
                  style={{ color: "#c1c1c3" }}
                />
                <span className="font-medium mr-2">Area:</span>
                <span>{artist.area.name}</span>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            {loadingLibrary ? (
              <div
                className="btn btn-secondary inline-flex items-center"
                disabled
              >
                <Loader className="w-5 h-5 mr-2 animate-spin" />
                Loading...
              </div>
            ) : existsInLibrary ? (
              <>
                <div className="relative inline-flex">
                  {canChangeMonitoring || canDeleteArtist ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowRemoveDropdown(!showRemoveDropdown)}
                        className="btn btn-success inline-flex items-center"
                      >
                        <CheckCircle className="w-5 h-5 mr-2" />
                        In Your Library
                        <ChevronDown
                          className={`w-4 h-4 ml-2 transition-transform ${
                            showRemoveDropdown ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                      {showRemoveDropdown && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={() => setShowRemoveDropdown(false)}
                          />
                          <div
                            className="absolute right-0 top-full w-56 z-20 py-1 rounded shadow-lg border border-white/10"
                            style={{ backgroundColor: "#2a2830" }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {canChangeMonitoring && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowMonitorOptionMenu(!showMonitorOptionMenu);
                                }}
                                disabled={updatingMonitor}
                                className="w-full text-left px-4 py-2 text-sm  hover:bg-gray-900/50 transition-colors flex items-center justify-between"
                                style={{ color: "#fff" }}
                              >
                                <span>Change Monitor Option</span>
                                <ChevronDown
                                  className={`w-4 h-4 transition-transform ${
                                    showMonitorOptionMenu ? "rotate-180" : ""
                                  }`}
                                />
                              </button>
                            )}

                            {canChangeMonitoring && showMonitorOptionMenu && (
                              <>
                                <div className="my-1" />
                                {[
                                  { value: "none", label: "None (Artist Only)" },
                                  { value: "all", label: "All Albums" },
                                  { value: "future", label: "Future Albums" },
                                  { value: "missing", label: "Missing Albums" },
                                  { value: "latest", label: "Latest Album" },
                                  { value: "first", label: "First Album" },
                                ].map((option) => (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleUpdateMonitorOption(option.value);
                                      setShowMonitorOptionMenu(false);
                                      setShowRemoveDropdown(false);
                                    }}
                                    disabled={updatingMonitor}
                                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-900/50 transition-colors"
                                    style={
                                      getCurrentMonitorOption() === option.value
                                        ? {
                                            backgroundColor: "#211f27",
                                            color: "#fff",
                                            fontWeight: "500",
                                          }
                                        : { color: "#fff" }
                                    }
                                  >
                                    {option.label}
                                  </button>
                                ))}
                              </>
                            )}

                            {canDeleteArtist && (
                              <>
                                <div className=" my-1" />
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleDeleteClick();
                                    setShowRemoveDropdown(false);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 transition-colors flex items-center"
                                >
                                  <Trash2 className="w-4 h-4 mr-2" />
                                  Remove from Library
                                </button>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="btn btn-success inline-flex items-center cursor-default">
                      <CheckCircle className="w-5 h-5 mr-2" />
                      In Your Library
                    </div>
                  )}
                </div>
              </>
            ) : (
              canAddArtist && (
                <AddToLibraryButton
                  onClick={handleAddToLibrary}
                  isLoading={addingToLibrary}
                />
              )
            )}

            <button
              type="button"
              onClick={onEditIds}
              className="btn btn-secondary btn-sm p-2 inline-flex items-center"
              aria-label="Edit IDs"
            >
              <Pencil className="w-5 h-5" />
            </button>
            <div className="relative inline-flex">
              <button
                type="button"
                onClick={() => setShowViewMenu(!showViewMenu)}
                className="btn btn-secondary inline-flex items-center"
              >
                <ExternalLink className="w-5 h-5 mr-2" />
                View on...
                <ChevronDown
                  className={`w-4 h-4 ml-2 transition-transform ${
                    showViewMenu ? "rotate-180" : ""
                  }`}
                />
              </button>
              {showViewMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowViewMenu(false)}
                  />
                  <div
                    className="absolute right-0 top-full mt-2 w-56 shadow-xl z-20 py-1 rounded-md border border-white/10"
                    style={{
                      backgroundColor: "#2d2b35",
                      boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
                    }}
                  >
                    <a
                      href={`https://www.last.fm/music/${encodeURIComponent(
                        artist.name
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 transition-colors flex items-center"
                      style={{ color: "#fff" }}
                      onClick={() => setShowViewMenu(false)}
                    >
                      <ExternalLink className="w-4 h-4 mr-2" />
                      View on Last.fm
                    </a>
                    {artist.id &&
                      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                        artist.id
                      ) && (
                        <a
                          href={`https://musicbrainz.org/artist/${artist.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 transition-colors flex items-center"
                          style={{ color: "#fff" }}
                          onClick={() => setShowViewMenu(false)}
                        >
                          <ExternalLink className="w-4 h-4 mr-2" />
                          View on MusicBrainz
                        </a>
                      )}
                    {lidarrArtistLink && (
                      <a
                        href={lidarrArtistLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 transition-colors flex items-center"
                        style={{ color: "#fff" }}
                        onClick={() => setShowViewMenu(false)}
                      >
                        <ExternalLink className="w-4 h-4 mr-2" />
                        View on Lidarr
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {((!loadingPreview && previewTracks && previewTracks.length > 0) ||
          loadingPreview) && (
          <div className="w-full md:w-80 bg-black/20 p-2 flex-shrink-0">
            {!loadingPreview && previewTracks.length > 0 && (
              <>
                <audio ref={previewAudioRef} />
                <div className="flex items-center gap-2 px-2 pb-2">
                  {previewVolume <= 0 ? (
                    <VolumeX className="w-4 h-4 flex-shrink-0" style={{ color: "#c1c1c3" }} />
                  ) : (
                    <Volume2 className="w-4 h-4 flex-shrink-0" style={{ color: "#c1c1c3" }} />
                  )}
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(previewVolume * 100)}
                    onChange={(e) =>
                      setPreviewVolume(
                        Math.max(
                          0,
                          Math.min(1, Number(e.target.value) / 100),
                        ),
                      )
                    }
                    className="w-full accent-[#707e61]"
                    aria-label="Preview volume"
                  />
                  <span
                    className="text-xs tabular-nums w-8 text-right"
                    style={{ color: "#c1c1c3" }}
                  >
                    {Math.round(previewVolume * 100)}
                  </span>
                </div>
                <ul className="space-y-0.5">
                  {previewTracks.map((track) => (
                    <li
                      key={track.id}
                      className="relative flex items-center gap-2 py-2 px-2 rounded hover:bg-black/30 transition-colors cursor-pointer overflow-hidden"
                      style={{
                        backgroundColor:
                          playingPreviewId === track.id
                            ? "rgba(0,0,0,0.12)"
                            : undefined,
                      }}
                      onClick={() => handlePreviewPlay(track)}
                    >
                      {playingPreviewId === track.id && (
                        <div
                          className="absolute inset-0 rounded pointer-events-none"
                          style={{
                            width: `${previewProgress * 100}%`,
                            backgroundColor: "rgba(112, 126, 97, 0.55)",
                            transition: previewSnappingBack
                              ? "width 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)"
                              : "width 0.1s linear",
                            zIndex: 15,
                          }}
                        />
                      )}
                      <button
                        type="button"
                        className="relative z-10 flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                        style={{ color: "#fff" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePreviewPlay(track);
                        }}
                      >
                        {playingPreviewId === track.id && !previewSnappingBack ? (
                          <Pause className="w-4 h-4" />
                        ) : (
                          <Play className="w-4 h-4 ml-0.5" />
                        )}
                      </button>
                      <div className="relative z-10 flex-1 min-w-0">
                        <div
                          className="text-sm font-medium truncate"
                          style={{ color: "#fff" }}
                        >
                          {track.title}
                        </div>
                        {track.album && (
                          <div
                            className="text-xs truncate"
                            style={{ color: "#c1c1c3" }}
                          >
                            {track.album}
                          </div>
                        )}
                      </div>
                      {track.duration_ms > 0 && (
                        <span
                          className="relative z-10 text-xs flex-shrink-0"
                          style={{ color: "#c1c1c3" }}
                        >
                          0:30
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {artist && (
        <div className="mt-3 pt-3">
          <h3
            className="text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: "#c1c1c3" }}
          >
            Tags
          </h3>
          <div className="flex flex-wrap gap-2">
            {artist.genres &&
              artist.genres.map((genre, idx) => {
                const name = typeof genre === "string" ? genre : genre?.name;
                if (!name) return null;
                return (
                  <button
                    key={`genre-${idx}`}
                    onClick={() =>
                      onNavigate(
                        `/search?q=${encodeURIComponent(`#${name}`)}&type=tag`
                      )
                    }
                    className="badge genre-tag-pill text-sm px-3 py-1 cursor-pointer"
                    style={{
                      backgroundColor: getTagColor(name),
                      color: "#fff",
                    }}
                    title={`View artists with tag: ${name}`}
                  >
                    #{name}
                  </button>
                );
              })}
            {artist.tags &&
              artist.tags.map((tag, idx) => {
                const name = typeof tag === "string" ? tag : tag?.name;
                if (!name) return null;
                return (
                  <button
                    key={`tag-${idx}`}
                    onClick={() =>
                      onNavigate(
                        `/search?q=${encodeURIComponent(`#${name}`)}&type=tag`
                      )
                    }
                    className="badge genre-tag-pill text-sm px-3 py-1 cursor-pointer"
                    style={{
                      backgroundColor: getTagColor(name),
                      color: "#fff",
                    }}
                    title={`View artists with tag: ${name}`}
                  >
                    #{name}
                  </button>
                );
              })}
            {(!artist.genres || artist.genres.length === 0) &&
              (!artist.tags || artist.tags.length === 0) && (
                <span className="text-sm" style={{ color: "#c1c1c3" }}>
                  No tags
                </span>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

ArtistDetailsHero.propTypes = {
  artist: PropTypes.object.isRequired,
  libraryArtist: PropTypes.object,
  appSettings: PropTypes.object,
  coverImages: PropTypes.arrayOf(
    PropTypes.shape({
      front: PropTypes.bool,
      image: PropTypes.string,
    })
  ),
  loadingCover: PropTypes.bool,
  loadingLibrary: PropTypes.bool,
  existsInLibrary: PropTypes.bool,
  showRemoveDropdown: PropTypes.bool,
  setShowRemoveDropdown: PropTypes.func,
  showMonitorOptionMenu: PropTypes.bool,
  setShowMonitorOptionMenu: PropTypes.func,
  updatingMonitor: PropTypes.bool,
  canChangeMonitoring: PropTypes.bool,
  getCurrentMonitorOption: PropTypes.func,
  handleUpdateMonitorOption: PropTypes.func,
  canDeleteArtist: PropTypes.bool,
  handleDeleteClick: PropTypes.func,
  canAddArtist: PropTypes.bool,
  handleAddToLibrary: PropTypes.func,
  addingToLibrary: PropTypes.bool,
  canRefreshArtist: PropTypes.bool,
  handleRefreshArtist: PropTypes.func,
  refreshingArtist: PropTypes.bool,
  onNavigate: PropTypes.func,
  loadingPreview: PropTypes.bool,
  previewTracks: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      title: PropTypes.string.isRequired,
      album: PropTypes.string,
      duration_ms: PropTypes.number,
    })
  ),
  previewAudioRef: PropTypes.oneOfType([
    PropTypes.func,
    PropTypes.shape({ current: PropTypes.instanceOf(Element) }),
  ]),
  playingPreviewId: PropTypes.string,
  previewProgress: PropTypes.number,
  previewSnappingBack: PropTypes.bool,
  previewVolume: PropTypes.number,
  setPreviewVolume: PropTypes.func,
  handlePreviewPlay: PropTypes.func,
  onEditIds: PropTypes.func,
};
