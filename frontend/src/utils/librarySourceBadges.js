const MANAGER_NAMES = { aurral: "Aurral", lidarr: "Lidarr" };

const sourceBadge = (source) => ({ id: source, label: `From ${MANAGER_NAMES[source]}` });

export const describeAlbumBadges = ({ managedBy, sources } = {}) => {
  const knownSources = [...new Set(sources || [])]
    .filter((source) => MANAGER_NAMES[source])
    .sort();
  const mixed = knownSources.length > 1;
  const differsFromManager =
    knownSources.length === 1 && Boolean(MANAGER_NAMES[managedBy]) && knownSources[0] !== managedBy;
  return {
    manager: MANAGER_NAMES[managedBy]
      ? { id: managedBy, label: `Managed by ${MANAGER_NAMES[managedBy]}` }
      : null,
    sources: mixed || differsFromManager ? knownSources.map(sourceBadge) : [],
    showTrackSources: mixed,
  };
};

export const trackSourceLabel = (file) =>
  MANAGER_NAMES[file?.source] ? `From ${MANAGER_NAMES[file.source]}` : null;
