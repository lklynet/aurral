export type ArtistCredit = { name: string; mbid: string | null; joinPhrase: string }[];

export const formatArtistCredit = (credit: ArtistCredit) =>
  credit
    .map(({ name, joinPhrase }) => `${name}${joinPhrase}`)
    .join("")
    .trim();
