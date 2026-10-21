type CanonicalFileCandidate = {
  id?: number;
  albumId?: number | null;
  source?: string | null;
  path?: string | null;
  format?: string | null;
  size?: number;
  mtimeMs?: number | null;
  durationMs?: number | null;
  quality?: { audioFormat?: string; format?: string; quality?: { name?: string } } | null;
  available?: unknown;
  createdAt?: number;
};

const sourceRank = (source: string | null | undefined, managedBy: string | null) => {
  if (managedBy && source === managedBy) return 0;
  if (source === "lidarr") return 1;
  return 2;
};

export function selectCanonicalFile<T extends CanonicalFileCandidate>(
  files: T[] | null | undefined,
  albumId: number | null = null,
  managedBy: string | null = null,
) {
  const candidates = (Array.isArray(files) ? files : [])
    .filter((file) => file?.albumId == null || albumId == null || file.albumId == albumId)
    .map((file) => ({ file }))
    .sort((left, right) => {
      const available =
        Number(Boolean(right.file.available)) - Number(Boolean(left.file.available));
      if (available) return available;
      const scoped = Number(left.file.albumId != null) - Number(right.file.albumId != null);
      if (scoped) return -scoped;
      const source =
        sourceRank(left.file.source, managedBy) - sourceRank(right.file.source, managedBy);
      if (source) return source;
      return String(left.file.path || "").localeCompare(String(right.file.path || ""));
    });

  return candidates[0]?.file || null;
}
