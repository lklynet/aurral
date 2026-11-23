import { MBID_PATTERN } from "./mbid.ts";

export interface ArtistMatchFields {
  id?: string | number | null;
  mbid?: string | null;
  foreignArtistId?: string | null;
  artistMbid?: string | null;
  name?: string | null;
  artistName?: string | null;
  artistAliases?: readonly string[] | null;
}

const normalize = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

const identify = (artist: ArtistMatchFields | null | undefined) => {
  const ids = [artist?.id, artist?.mbid, artist?.foreignArtistId, artist?.artistMbid]
    .map(normalize)
    .filter(Boolean);
  return {
    mbids: ids.filter((id) => MBID_PATTERN.test(id)),
    ids: ids.filter((id) => !MBID_PATTERN.test(id)),
    names: [artist?.name, artist?.artistName, ...(artist?.artistAliases ?? [])]
      .map(normalize)
      .filter(Boolean),
  };
};

export const artistMatchKeys = (artist: ArtistMatchFields | null | undefined) => {
  const { mbids, ids, names } = identify(artist);
  return [
    ...new Set([
      ...mbids.map((mbid) => `mbid:${mbid}`),
      ...ids.map((id) => `id:${id}`),
      ...names.map((name) => `name:${name}`),
      ...(mbids.length > 0 ? [] : names.map((name) => `unidentified:${name}`)),
    ]),
  ];
};

export const artistProbeKeys = (artist: ArtistMatchFields | null | undefined) => {
  const { mbids, ids, names } = identify(artist);
  const nameKey = mbids.length > 0 ? "unidentified" : "name";
  return [
    ...mbids.map((mbid) => `mbid:${mbid}`),
    ...ids.map((id) => `id:${id}`),
    ...names.map((name) => `${nameKey}:${name}`),
  ];
};

export const matchesArtistKeys = (
  artist: ArtistMatchFields | null | undefined,
  keys: ReadonlySet<string>,
) => keys.size > 0 && artistProbeKeys(artist).some((key) => keys.has(key));

export const buildArtistMatchKeySet = (artists: readonly ArtistMatchFields[]) =>
  new Set(artists.flatMap(artistMatchKeys));

export const isSameArtist = (
  left: ArtistMatchFields | null | undefined,
  right: ArtistMatchFields | null | undefined,
) => matchesArtistKeys(right, new Set(artistMatchKeys(left)));
