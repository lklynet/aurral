export type ArtistCredit = { name: string; mbid: string | null; joinPhrase: string }[];

export const formatArtistCredit = (credit: ArtistCredit) =>
  credit
    .map(({ name, joinPhrase }) => `${name}${joinPhrase}`)
    .join("")
    .trim();

const text = (value: unknown) => String(value ?? "").trim();

export const artistNames = (value: unknown) => {
  const seen = new Set<string>();
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => text(entry).split(";"))
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
