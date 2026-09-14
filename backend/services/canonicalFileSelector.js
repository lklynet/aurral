const sourceRank = (source, managedBy) => {
  if (managedBy && source === managedBy) return 0;
  if (source === "lidarr") return 1;
  return 2;
};

export function selectCanonicalFile(files, albumId = null, managedBy = null) {
  const candidates = (Array.isArray(files) ? files : [])
    .filter((file) => file?.albumId == null || albumId == null || file.albumId == albumId)
    .map((file) => ({ file }))
    .sort((left, right) => {
      const available = Number(Boolean(right.file.available)) - Number(Boolean(left.file.available));
      if (available) return available;
      const scoped = Number(left.file.albumId != null) - Number(right.file.albumId != null);
      if (scoped) return -scoped;
      const source = sourceRank(left.file.source, managedBy) - sourceRank(right.file.source, managedBy);
      if (source) return source;
      return String(left.file.path || "").localeCompare(String(right.file.path || ""));
    });

  return candidates[0]?.file || null;
}
