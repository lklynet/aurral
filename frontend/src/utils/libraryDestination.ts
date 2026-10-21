const MANAGER_NAMES = {
  aurral: "Aurral",
  lidarr: "Lidarr",
};

type LibraryManager = keyof typeof MANAGER_NAMES;

interface LibrarySourceFields {
  managedBy?: string | null;
  sources?: string[] | null;
}

interface LibraryAlbumRef extends LibrarySourceFields {
  releaseGroupMbid?: string | null;
  mbid?: string | null;
  providerId?: string | number | null;
}

export const normalizeLibraryManager = (value: unknown): LibraryManager | null => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return Object.hasOwn(MANAGER_NAMES, normalized) ? (normalized as LibraryManager) : null;
};

export const resolveAlbumManager = (album: LibrarySourceFields | null | undefined) =>
  normalizeLibraryManager(album?.managedBy) ||
  (Array.isArray(album?.sources) && album.sources.includes("lidarr") ? "lidarr" : null);

export const canRemoveLibraryAlbum = (
  album: LibraryAlbumRef,
  { lidarrConnected = false }: { lidarrConnected?: boolean } = {},
) => {
  const manager = resolveAlbumManager(album);
  if (manager === "aurral") return true;
  return (
    manager === "lidarr" &&
    lidarrConnected &&
    Boolean(album.releaseGroupMbid || album.mbid || album.providerId)
  );
};

export const canRemoveLibraryArtist = (
  artist: ({ mbid?: string | null } & LibrarySourceFields) | null | undefined,
) =>
  Boolean(artist?.mbid) ||
  (artist?.managedBy !== "lidarr" &&
    Array.isArray(artist?.sources) &&
    artist.sources.includes("aurral"));

export const canSearchLibraryAlbum = (
  album: LibrarySourceFields | null | undefined,
  { lidarrConnected = false }: { lidarrConnected?: boolean } = {},
) => {
  const manager = resolveAlbumManager(album);
  return manager === "aurral" || (manager === "lidarr" && lidarrConnected);
};

export const getManagerName = (manager: string | null | undefined) =>
  MANAGER_NAMES[normalizeLibraryManager(manager)] || MANAGER_NAMES.aurral;

export const getAddToManagerLabel = (manager: string | null | undefined) =>
  normalizeLibraryManager(manager) === "lidarr" ? "Add to Lidarr" : "Add to library";

export const getManagedByLabel = (manager: string | null | undefined) => {
  const normalized = normalizeLibraryManager(manager);
  return normalized ? `Managed by ${MANAGER_NAMES[normalized]}` : null;
};

export const resolveLibraryDestination = ({
  lidarrConfigured = false,
}: { lidarrConfigured?: boolean } = {}) => ({
  primary: lidarrConfigured ? "lidarr" : "aurral",
});

const describeAvailability = (
  availability:
    | { available?: boolean; trackCount?: number | null; availableTrackCount?: number | null }
    | null
    | undefined,
) => {
  if (!availability) return null;
  if (availability.available) return "Available";
  const trackCount = Number(availability.trackCount || 0);
  if (trackCount <= 0) return null;
  return `${Number(availability.availableTrackCount || 0)} of ${trackCount} tracks`;
};

export const getLibraryOwnerConflict = (error: unknown) => {
  const response = error?.response;
  const data = response?.data || {};
  if (response?.status !== 409 || !String(data.code || "").endsWith("_owner_conflict")) {
    return null;
  }
  const managedBy = normalizeLibraryManager(data.managedBy ?? data.conflict?.managedBy);
  if (!managedBy) return null;
  const label = getManagedByLabel(managedBy);
  const availability = describeAvailability(data.availability ?? data.conflict?.availability);
  return {
    managedBy,
    label,
    message: availability ? `${label} · ${availability}` : label,
  };
};

export const buildArtistAddPayload = ({
  artistMbid,
  artistName,
  managedBy,
  lidarrOptions = {},
  ...rest
}: {
  artistMbid: string;
  artistName: string;
  managedBy: string;
  lidarrOptions?: Record<string, unknown>;
  quality?: string;
  monitorOption?: string | null;
}) => ({
  ...rest,
  foreignArtistId: artistMbid,
  artistName,
  managedBy,
  ...(managedBy === "lidarr" ? lidarrOptions : {}),
});

export const buildAlbumRequestPayload = ({
  albumMbid,
  albumName,
  artistMbid,
  artistName,
  managedBy,
  triggerSearch = false,
}: {
  albumMbid: string;
  albumName: string;
  artistMbid?: string | null;
  artistName?: string | null;
  managedBy: string;
  triggerSearch?: boolean;
}) => ({
  albumMbid,
  albumName,
  artistMbid,
  artistName,
  managedBy,
  triggerSearch,
});
