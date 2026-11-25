export type ArtistCredit = { name: string; mbid: string | null; joinPhrase: string }[];

export const formatArtistCredit = (credit: ArtistCredit) =>
  credit
    .map(({ name, joinPhrase }) => `${name}${joinPhrase}`)
    .join("")
    .trim();

const text = (value: unknown) => String(value ?? "").trim();

// ID3v2.3 has no multi-value frames, but tag editors still separate values
// with NUL, each value starting with its own byte-order mark, which trim drops.
export const tagValues = (value: unknown) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((entry) => text(entry).split("\0"))
    .map(text)
    .filter(Boolean);

export const artistNames = (value: unknown) => {
  const seen = new Set<string>();
  return tagValues(value)
    .flatMap((entry) => entry.split(";"))
    .map(text)
    .filter((name) => {
      const key = name.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

export function trackArtistCreditFromTags(artist: unknown, artists: unknown) {
  const primary = text(artist);
  const names = artistNames(artists);
  const normalizedPrimary = primary.toLocaleLowerCase();
  if (
    names.length > 1 &&
    names.some((name) => !normalizedPrimary.includes(name.toLocaleLowerCase()))
  ) {
    return names.join(", ");
  }
  return primary || names.join(", ");
}

export const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

const VARIOUS_ARTISTS_NAMES = new Set(["various artists", "various", "va", "v a"]);

// "Various Artists" credits a compilation, not a performer.
export function isVariousArtistsCredit(
  name: string | null | undefined,
  mbid: string | null = null,
) {
  return (
    text(mbid).toLowerCase() === VARIOUS_ARTISTS_MBID ||
    VARIOUS_ARTISTS_NAMES.has(
      text(name)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    )
  );
}

// Only a compilation names each track for its own artist. A featured credit,
// like "Daft Punk feat. Pharrell", keeps the album's artist.
export const albumTrackArtist = (
  albumArtist: string | null | undefined,
  albumArtistMbid: string | null | undefined,
  trackArtist: string | null | undefined,
) =>
  (isVariousArtistsCredit(albumArtist, albumArtistMbid ?? null) && text(trackArtist)) ||
  text(albumArtist) ||
  text(trackArtist);
