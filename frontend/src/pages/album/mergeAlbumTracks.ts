type AlbumTrackPosition = {
  albumId: string | number;
  discNumber?: number | null;
  trackNumber?: number | null;
};

export type MergeableLibraryTrack = {
  id: string | number;
  mbid?: string | null;
  title?: string | null;
  albums?: AlbumTrackPosition[] | null;
};

export type MergeableReleaseTrack = {
  id?: string | null;
  mbid?: string | null;
  title?: string | null;
  trackName?: string | null;
  trackNumber?: number | null;
  position?: number | null;
  discNumber?: number | null;
};

export type MergedAlbumTrack<Library, Release> = {
  key: string;
  libraryTrack: Library | null;
  releaseTrack: Release | null;
  releaseIndex: number;
  disc: number;
  number: number;
};

const positiveNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export const normalizeTrackTitle = (value: unknown) =>
  String(value || "")
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const mbidOf = (track: { mbid?: string | null } | null | undefined) =>
  String(track?.mbid || "").trim();

const libraryPosition = (track: MergeableLibraryTrack, libraryAlbumId: string | null) => {
  const relation =
    (libraryAlbumId && track.albums?.find((entry) => String(entry.albumId) === libraryAlbumId)) ||
    track.albums?.[0];
  return {
    disc: positiveNumber(relation?.discNumber) ?? 1,
    number: positiveNumber(relation?.trackNumber),
  };
};

export const releaseTrackId = (
  track: MergeableReleaseTrack | null | undefined,
  releaseKey: string | undefined,
  index: number,
) => String(track?.id || track?.mbid || `${releaseKey}-${index}`);

export function mergeAlbumTracks<
  Library extends MergeableLibraryTrack,
  Release extends MergeableReleaseTrack,
>({
  libraryTracks,
  releaseTracks,
  libraryAlbumId = null,
  releaseKey = "release",
}: {
  libraryTracks: readonly Library[] | null | undefined;
  releaseTracks: readonly Release[] | null | undefined;
  libraryAlbumId?: string | number | null;
  releaseKey?: string;
}): MergedAlbumTrack<Library, Release>[] {
  const albumId = libraryAlbumId == null ? null : String(libraryAlbumId);
  const library = (libraryTracks || []).map((track) => ({
    track,
    ...libraryPosition(track, albumId),
  }));
  const unmatched = new Set(library);
  const byMbid = new Map<string, (typeof library)[number]>();
  for (const entry of library) {
    const mbid = mbidOf(entry.track);
    if (mbid && !byMbid.has(mbid)) byMbid.set(mbid, entry);
  }

  const rows: (MergedAlbumTrack<Library, Release> & { sortNumber: number | null })[] = [];
  (releaseTracks || []).forEach((releaseTrack, index) => {
    const disc = positiveNumber(releaseTrack.discNumber) ?? 1;
    const number =
      positiveNumber(releaseTrack.trackNumber) ?? positiveNumber(releaseTrack.position);
    let match = byMbid.get(mbidOf(releaseTrack));
    if (!match || !unmatched.has(match)) {
      const title = normalizeTrackTitle(releaseTrack.title || releaseTrack.trackName);
      match = [...unmatched].find(
        (entry) =>
          entry.disc === disc &&
          entry.number != null &&
          entry.number === number &&
          title !== "" &&
          normalizeTrackTitle(entry.track.title) === title,
      );
    }
    if (match) unmatched.delete(match);
    rows.push({
      key: match ? String(match.track.id) : releaseTrackId(releaseTrack, releaseKey, index),
      libraryTrack: match?.track ?? null,
      releaseTrack,
      releaseIndex: index,
      disc,
      number: number ?? match?.number ?? index + 1,
      sortNumber: number ?? match?.number ?? null,
    });
  });

  for (const entry of library) {
    if (!unmatched.has(entry)) continue;
    const after = rows.findLastIndex(
      (row) =>
        row.disc < entry.disc ||
        (row.disc === entry.disc && (row.sortNumber ?? Infinity) <= (entry.number ?? Infinity)),
    );
    rows.splice(after + 1, 0, {
      key: String(entry.track.id),
      libraryTrack: entry.track,
      releaseTrack: null,
      releaseIndex: -1,
      disc: entry.disc,
      number: entry.number ?? 0,
      sortNumber: entry.number,
    });
  }

  return rows.map(({ sortNumber: _sortNumber, ...row }, index) => ({
    ...row,
    number: row.number || index + 1,
  }));
}
