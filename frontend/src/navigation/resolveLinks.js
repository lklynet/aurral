import { queryOptions } from "@tanstack/react-query";
import { resolveEditorialTrackLinks } from "../utils/api/endpoints/discovery.js";
import {
  getLibraryPage,
  lookupAlbumsInLibraryBatch,
  lookupArtistInLibrary,
} from "../utils/api/endpoints/library.js";
import {
  findLibraryAlbumByName,
  findLibraryArtistByName,
  libraryRecordId,
} from "../utils/libraryTrackNavigation.js";

export const RESOLVE_KINDS = ["artist", "album", "library-artist", "library-album"];

const text = (value) => String(value ?? "").trim();

const buildPath = (kind, params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (text(value)) search.set(key, text(value));
  }
  return `/go/${kind}?${search}`;
};

export const resolveArtistPath = ({ name }) => (text(name) ? buildPath("artist", { name }) : null);

export const resolveAlbumPath = ({ artistName, albumName, deezerAlbumId }) =>
  text(artistName) && text(albumName)
    ? buildPath("album", { artist: artistName, name: albumName, deezer: deezerAlbumId })
    : null;

export const resolveLibraryArtistPath = ({ mbid, name }) =>
  text(mbid) || text(name) ? buildPath("library-artist", { mbid, name }) : null;

export const resolveLibraryAlbumPath = ({ mbid, name, artistName }) =>
  text(mbid) || text(name)
    ? buildPath("library-album", { mbid, name, artist: artistName })
    : null;

const releaseTarget = (artistMbid, albumMbid, artistName, albumName) => ({
  to: `/artist/${artistMbid}/release/${albumMbid}`,
  state: {
    artistName,
    focusReleaseGroupMbid: albumMbid,
    focusReleaseGroup: { id: albumMbid, title: albumName || "" },
  },
});

const notFound = (message) => Object.assign(new Error(message), { resolveNotFound: true });

async function resolveCatalog(kind, params, signal) {
  const artistName = text(kind === "artist" ? params.get("name") : params.get("artist"));
  const albumName = kind === "album" ? text(params.get("name")) : "";
  const { artistMbid, albumMbid } = await resolveEditorialTrackLinks(
    {
      artistName,
      albumName: albumName || null,
      deezerAlbumId: kind === "album" ? text(params.get("deezer")) || null : null,
    },
    { signal },
  );
  if (!artistMbid) throw notFound(`Couldn't find ${artistName} in MusicBrainz`);
  if (kind === "album" && albumMbid) {
    return releaseTarget(artistMbid, albumMbid, artistName, albumName);
  }
  return {
    to: `/artist/${artistMbid}`,
    state: { artistName },
    notice: kind === "album" ? `Couldn't find ${albumName}. Opened ${artistName} instead.` : null,
  };
}

async function resolveLibraryArtist(params, signal) {
  const mbid = text(params.get("mbid"));
  const name = text(params.get("name"));
  let canonicalId = null;
  if (mbid) {
    const lookup = await lookupArtistInLibrary(mbid, { signal }).catch(() => null);
    canonicalId = lookup?.libraryArtistId || lookup?.artist?.canonicalId || null;
  }
  if (!canonicalId && name) {
    const page = await getLibraryPage(
      { kind: "artists", page: 1, pageSize: 100, query: name, availableOnly: false },
      { signal },
    ).catch(() => null);
    canonicalId = libraryRecordId(findLibraryArtistByName(page?.items, name));
  }
  if (!canonicalId) throw notFound(`Couldn't find ${name || "this artist"} in your library`);
  return { to: `/library/artist/${encodeURIComponent(canonicalId)}` };
}

async function resolveLibraryAlbum(params, signal) {
  const mbid = text(params.get("mbid"));
  const name = text(params.get("name"));
  let canonicalId = null;
  if (mbid) {
    const lookup = await lookupAlbumsInLibraryBatch([mbid], { signal }).catch(() => null);
    canonicalId = lookup?.[mbid]?.canonicalAlbumId || null;
  }
  if (!canonicalId && name) {
    const page = await getLibraryPage(
      { kind: "albums", page: 1, pageSize: 100, query: name, availableOnly: false },
      { signal },
    ).catch(() => null);
    canonicalId = libraryRecordId(
      findLibraryAlbumByName(page?.items, name, text(params.get("artist"))),
    );
  }
  if (!canonicalId) throw notFound(`Couldn't find ${name || "this album"} in your library`);
  return { to: `/library/album/${encodeURIComponent(canonicalId)}` };
}

export function resolveLinkTarget(kind, params, { signal } = {}) {
  if (kind === "artist" || kind === "album") return resolveCatalog(kind, params, signal);
  if (kind === "library-artist") return resolveLibraryArtist(params, signal);
  if (kind === "library-album") return resolveLibraryAlbum(params, signal);
  return Promise.reject(notFound("This link isn't valid"));
}

export const resolveLinkQueryOptions = (kind, search) => {
  const params = new URLSearchParams(search);
  params.sort();
  return queryOptions({
    queryKey: ["navigation", "resolve", kind, params.toString()],
    queryFn: ({ signal }) => resolveLinkTarget(kind, params, { signal }),
    enabled: RESOLVE_KINDS.includes(kind),
    staleTime: 5 * 60 * 1000,
  });
};
