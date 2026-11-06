export type AlbumDiscTrack = {
  // The track's disc on the album, or 0 when it has none.
  disc: number;
  // The album title the track's own file carries, or "" without a file.
  title: string;
};

// The heading shown above each track of an album with several discs, or null
// where none is shown. Only the disc number splits an album: files carrying
// different album titles, as when a single's tracks come from several
// releases, stay one disc. A disc is named after its files' album title when
// all of them agree on one and it is not the album's own, as a box set's discs
// are. A track without a disc number, such as one still missing, belongs to
// the disc of the tracks around it.
export function albumDiscHeadings(tracks: AlbumDiscTrack[], albumTitle: string) {
  const discs = tracks.map(({ disc }) => disc || 0);
  for (let index = 1; index < discs.length; index++) discs[index] ||= discs[index - 1] ?? 0;
  for (let index = discs.length - 2; index >= 0; index--) discs[index] ||= discs[index + 1] ?? 0;
  if (new Set(discs).size < 2) return tracks.map(() => null);

  const titles = new Map<number, Set<string>>();
  tracks.forEach(({ title }, index) => {
    const disc = discs[index] ?? 0;
    if (!title) return;
    const seen = titles.get(disc) ?? new Set<string>();
    seen.add(title);
    titles.set(disc, seen);
  });
  const discTitle = (disc: number) => {
    const seen = titles.get(disc);
    const [title] = seen?.size === 1 ? seen : [];
    return title && title !== albumTitle ? title : "";
  };

  return discs.map((disc, index) =>
    index && discs[index - 1] === disc
      ? null
      : [disc ? `Disc ${disc}` : "", discTitle(disc)].filter(Boolean).join(" · ") || null,
  );
}

type DiscTrack = {
  albums?: readonly { albumId: unknown; discNumber?: unknown }[] | null;
  metadata?: unknown;
};

const firstText = (value: unknown) => {
  const [first] = Array.isArray(value) ? value : [value];
  return typeof first === "string" ? first.trim() : "";
};

// The title a track's own file gives its disc: the disc subtitle tag (TSST,
// DISCSUBTITLE) when it has one, as a box set retagged with one album title
// keeps each disc's name there, or else the file's album title.
export const fileAlbumTitle = (track: DiscTrack) => {
  const tags = (
    track.metadata as { tags?: { album?: unknown; discsubtitle?: unknown } } | null | undefined
  )?.tags;
  return firstText(tags?.discsubtitle) || firstText(tags?.album);
};

// The heading above each track of this album's track list, from the track's
// disc on the album and its file's album title.
export const albumDiscSections = (album: { id: unknown; title: string }, tracks: DiscTrack[]) =>
  albumDiscHeadings(
    tracks.map((track) => ({
      disc: Number(
        track.albums?.find((entry) => String(entry.albumId) === String(album.id))?.discNumber || 0,
      ),
      title: fileAlbumTitle(track),
    })),
    album.title,
  );
