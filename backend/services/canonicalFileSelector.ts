import type { LibraryTrackFile } from "./libraryQueryService.ts";

type CanonicalFileCandidate = Partial<Omit<LibraryTrackFile, "available">> & {
  available?: unknown;
};

const sourceRank = (source: string | null | undefined, managed: boolean) =>
  managed && source === "aurral" ? 0 : 1;

export function selectCanonicalFile<T extends CanonicalFileCandidate>(
  files: T[] | null | undefined,
  albumId: number | null = null,
  managed = false,
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
      const source = sourceRank(left.file.source, managed) - sourceRank(right.file.source, managed);
      if (source) return source;
      return String(left.file.path || "").localeCompare(String(right.file.path || ""));
    });

  return candidates[0]?.file || null;
}
