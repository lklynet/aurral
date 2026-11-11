import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { libraryAlbumPath } from "../../../../lib/albumPath.ts";
import ArtistImage from "../../components/ArtistImage";
import ArtworkImage from "../../components/ArtworkImage";
import { DotLoader } from "../../components/DotLoader";
import { AlertCircle, Check, Music } from "../../components/icons";
import { ModalShell } from "../../components/PlaylistModals";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { queryKeys } from "../../queryClient.ts";
import { resolveAuthenticatedApiAssetUrl } from "../../utils/api/core.ts";
import { getApiErrorText } from "../../utils/api/errors.ts";
import {
  fetchLibraryAlbumMatches,
  fetchLibraryArtistMatches,
  fetchLibraryTrackMatches,
  updateLibraryAlbumReleaseGroup,
  updateLibraryArtistMbid,
  updateLibraryTrackRecording,
} from "../../utils/api/endpoints/library.ts";
import type { LibraryAlbum, LibraryArtist, LibraryTrack } from "../../utils/libraryPageData.ts";
import { formatDuration } from "./libraryShared.tsx";

const MBID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SEARCH_DELAY_MS = 300;
const GROUPS = [
  ["Album", "Albums"],
  ["EP", "EPs"],
  ["Single", "Singles"],
] as const;

const pastedMbid = (value: string) => value.match(MBID_PATTERN)?.[0]?.toLowerCase() ?? null;
const nameKey = (value: string) =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type MatchRow = { id: string; title: string; detail: string; art: ReactNode };
type MatchGroup = { label: string | null; rows: MatchRow[] };
type MatchList = { groups: MatchGroup[]; loading: boolean; failed: boolean; retry: () => void };

const onlyExactMatch = (rows: MatchRow[], name: string) => {
  const exact = rows.filter((row) => nameKey(row.title) === nameKey(name));
  return exact.length === 1 ? exact[0]!.id : null;
};

const joinDetail = (...parts: (string | null | undefined | false)[]) =>
  parts.filter(Boolean).join(" · ");

function MatchModal({
  title,
  description,
  query,
  onQueryChange,
  placeholder,
  list,
  current,
  suggested,
  save,
  onClose,
}: {
  title: string;
  description: string;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  list: MatchList;
  current: string | null;
  suggested: string | null;
  save: (mbid: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState("");
  const pasted = pastedMbid(query);
  const chosen = pasted ?? picked ?? suggested ?? current;
  const groups: MatchGroup[] = pasted
    ? [{ label: null, rows: [{ id: pasted, title: "MusicBrainz ID", detail: pasted, art: null }] }]
    : list.groups.filter((group) => group.rows.length > 0);

  const submit = async (mbid: string | null) => {
    setSaving(mbid ? "save" : "clear");
    setError("");
    try {
      await save(mbid);
    } catch (saveError) {
      setError(getApiErrorText(saveError, "error") || "Could not save the match");
      setSaving(null);
    }
  };

  const renderList = () => {
    if (pasted) return null;
    if (list.loading) {
      return (
        <div className="match-modal__state">
          <DotLoader size="sm" label="Searching" />
        </div>
      );
    }
    if (list.failed) {
      return (
        <div className="match-modal__state" role="alert">
          <AlertCircle className="artist-icon-sm" aria-hidden="true" />
          <span>{"Couldn't load matches"}</span>
          <button type="button" className="btn btn-secondary" onClick={list.retry}>
            Try again
          </button>
        </div>
      );
    }
    if (groups.length === 0) return <div className="match-modal__state">No matches</div>;
    return null;
  };

  return createPortal(
    <ModalShell
      open
      className="match-modal"
      title={title}
      description={description}
      onClose={onClose}
      disableClose={saving !== null}
      footer={
        <>
          {current ? (
            <button
              type="button"
              className="btn btn-ghost match-modal__remove"
              onClick={() => void submit(null)}
              disabled={saving !== null}
            >
              {saving === "clear" ? <DotLoader size="sm" label={null} /> : null}
              Remove match
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={saving !== null}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit(chosen)}
            disabled={saving !== null || !chosen || chosen === current}
          >
            {saving === "save" ? <DotLoader size="sm" label={null} /> : null}
            Save
          </button>
        </>
      }
    >
      <div className="match-modal__body">
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="input input--tall"
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={saving !== null}
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        <div className="match-modal__list">
          {renderList() ??
            groups.map((group) => (
              <div key={group.label ?? "results"} role="group" aria-label={group.label ?? title}>
                {group.label ? <div className="match-modal__group">{group.label}</div> : null}
                {group.rows.map((row) => {
                  const selected = row.id === chosen;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className="match-modal__row"
                      aria-pressed={selected}
                      onClick={() => setPicked(row.id)}
                      disabled={saving !== null}
                      ref={
                        selected && picked === null
                          ? (node) => node?.scrollIntoView({ block: "nearest" })
                          : undefined
                      }
                    >
                      {row.art}
                      <span className="match-modal__text">
                        <span className="match-modal__title">{row.title}</span>
                        {row.detail ? (
                          <span className="match-modal__detail">{row.detail}</span>
                        ) : null}
                      </span>
                      {selected ? <Check className="artist-icon-sm" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
        {error ? (
          <p className="artist-error-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ModalShell>,
    document.body,
  );
}

const albumArt = (src: string | null) => (
  <span className="match-modal__art">
    {src ? (
      <ArtworkImage src={src} alt="" loading="lazy" thumbnail sizes="40px" />
    ) : (
      <Music aria-hidden="true" />
    )}
  </span>
);

export type ArtistMatchResult = Awaited<ReturnType<typeof updateLibraryArtistMbid>>;

export function ArtistMatchModal({
  artist,
  onClose,
  onSaved,
}: {
  artist: LibraryArtist;
  onClose: () => void;
  onSaved: (result: ArtistMatchResult) => void;
}) {
  const [query, setQuery] = useState(artist.name || "");
  const search = useDebouncedValue(query.trim(), SEARCH_DELAY_MS);
  const matches = useQuery({
    queryKey: queryKeys.libraryMatches("artist", artist.id, search),
    queryFn: ({ signal }) => fetchLibraryArtistMatches(artist.id, search, { signal }),
    enabled: !pastedMbid(query),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const rows = (matches.data?.items ?? []).map((item) => ({
    id: item.id,
    title: item.name,
    detail: joinDetail(
      item.disambiguation,
      item.type,
      item.libraryArtistId != null &&
        String(item.libraryArtistId) !== String(artist.id) &&
        "In your Library",
    ),
    art: (
      <span className="match-modal__art match-modal__art--round">
        <ArtistImage src={item.imageUrl} alt="" thumbnail={false} sizes="40px" />
      </span>
    ),
  }));
  return (
    <MatchModal
      title="Match artist"
      description={artist.name || "Artist"}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search or paste a MusicBrainz link"
      list={{
        groups: [{ label: null, rows }],
        loading: matches.isPending,
        failed: matches.isError,
        retry: () => void matches.refetch(),
      }}
      current={artist.mbid || null}
      suggested={onlyExactMatch(rows, artist.name || "")}
      save={async (mbid) => onSaved(await updateLibraryArtistMbid(artist.id, mbid))}
      onClose={onClose}
    />
  );
}

export type AlbumMatchResult = Awaited<ReturnType<typeof updateLibraryAlbumReleaseGroup>>;

export function AlbumMatchModal({
  album,
  artist,
  onClose,
  onSaved,
}: {
  album: LibraryAlbum;
  artist: LibraryArtist | null;
  onClose: () => void;
  onSaved: (result: AlbumMatchResult) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const artistName = artist?.name || album.albumArtist;
  const discography = Boolean(artist?.mbid);
  const [query, setQuery] = useState(discography ? "" : album.title || "");
  const search = useDebouncedValue(query.trim(), SEARCH_DELAY_MS);
  const matches = useQuery({
    queryKey: queryKeys.libraryMatches("album", album.id, discography ? "" : search),
    queryFn: ({ signal }) =>
      fetchLibraryAlbumMatches(album.id, discography ? "" : search, { signal }),
    enabled: !pastedMbid(query),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const fromDiscography = matches.data?.source === "discography";
  const filter = fromDiscography ? nameKey(query) : "";
  const items = (matches.data?.items ?? [])
    .filter((item) => nameKey(item.title).includes(filter))
    .sort(
      (left, right) =>
        Number(left.secondaryTypes.length > 0) - Number(right.secondaryTypes.length > 0),
    );
  const toRow = (item: (typeof items)[number]): MatchRow => ({
    id: item.id,
    title: item.title,
    detail: joinDetail(
      item.year,
      !fromDiscography && item.type,
      ...item.secondaryTypes,
      item.libraryAlbumId != null &&
        String(item.libraryAlbumId) !== String(album.id) &&
        "In your Library",
    ),
    art: albumArt(resolveAuthenticatedApiAssetUrl(item.coverUrl)),
  });
  const known = new Set<string>(GROUPS.map(([type]) => type));
  const groups = fromDiscography
    ? [
        ...GROUPS.map(([type, label]) => ({
          label,
          rows: items.filter((item) => item.type === type).map(toRow),
        })),
        { label: "Other", rows: items.filter((item) => !known.has(item.type)).map(toRow) },
      ]
    : [{ label: null, rows: items.map(toRow) }];

  const save = async (mbid: string | null) => {
    const result = await updateLibraryAlbumReleaseGroup(album.id, mbid);
    if (location.pathname === libraryAlbumPath(album)) {
      void navigate(libraryAlbumPath(result) + location.search, { replace: true });
    }
    onSaved(result);
  };

  return (
    <MatchModal
      title="Match album"
      description={joinDetail(
        album.title,
        artistName,
        plural(album.availableTrackCount ?? album.trackIds.length, "song"),
      )}
      query={query}
      onQueryChange={setQuery}
      placeholder={
        fromDiscography
          ? "Filter or paste a MusicBrainz link"
          : "Search or paste a MusicBrainz link"
      }
      list={{
        groups,
        loading: matches.isPending,
        failed: matches.isError,
        retry: () => void matches.refetch(),
      }}
      current={album.releaseGroupMbid || null}
      suggested={onlyExactMatch(
        groups.flatMap((group) => group.rows),
        album.title || "",
      )}
      save={save}
      onClose={onClose}
    />
  );
}

export type TrackMatchResult = Awaited<ReturnType<typeof updateLibraryTrackRecording>>;

export function TrackMatchModal({
  track,
  album,
  onClose,
  onSaved,
}: {
  track: LibraryTrack;
  album: LibraryAlbum;
  onClose: () => void;
  onSaved: (result: TrackMatchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useQuery({
    queryKey: queryKeys.libraryMatches("track", track.id, ""),
    queryFn: ({ signal }) => fetchLibraryTrackMatches(track.id, { signal }),
    enabled: !pastedMbid(query),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const items = matches.data?.items ?? [];
  const discs = new Set(items.map((item) => item.discNumber)).size;
  const position = track.albums?.find((entry) => String(entry.albumId) === String(album.id));
  const filter = nameKey(query);
  const rows = items
    .filter((item) => nameKey(item.title).includes(filter))
    .map((item) => ({
      id: item.id,
      title: item.title,
      detail: joinDetail(
        discs > 1 && `Disc ${item.discNumber}`,
        item.trackNumber ? `Track ${item.trackNumber}` : null,
        formatDuration(item.durationMs),
        item.inLibrary && "Already has a file",
      ),
      art: null,
    }));
  const atPosition = items.find(
    (item) =>
      item.trackNumber === position?.trackNumber && item.discNumber === (position?.discNumber || 1),
  );
  return (
    <MatchModal
      title="Match track"
      description={joinDetail(track.title, matches.data?.album || album.title)}
      query={query}
      onQueryChange={setQuery}
      placeholder="Filter or paste a MusicBrainz link"
      list={{
        groups: [{ label: null, rows }],
        loading: matches.isPending,
        failed: matches.isError,
        retry: () => void matches.refetch(),
      }}
      current={null}
      suggested={items.find((item) => item.id === track.mbid)?.id ?? atPosition?.id ?? null}
      save={async (mbid) => {
        if (mbid) onSaved(await updateLibraryTrackRecording(track.id, mbid));
      }}
      onClose={onClose}
    />
  );
}
