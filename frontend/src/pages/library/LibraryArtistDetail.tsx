import type { ComponentProps, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Pause, Play, Shuffle, Sparkles } from "../../components/icons";
import { LibraryItemMenu, type LibraryMenuItem } from "../../components/LibraryItemMenu";
import { FavoriteButton, TrackList } from "../../components/TrackList";
import TooltipButton from "../../components/TooltipButton";
import RouteLink from "../../components/RouteLink";
import { useSharedArtworkStyle } from "../../navigation/viewTransitions.ts";
import { libraryArtistPlaysQueryOptions } from "../../utils/api/endpoints/library.ts";
import {
  firstAvailableFile,
  releaseTypeOf,
  type LibraryAlbum,
  type LibraryArtist,
} from "../../utils/libraryPageData.ts";
import {
  LIBRARY_SOURCE,
  type LibraryActions,
  type LibraryCollection,
} from "./useLibraryActions.tsx";
import { Cover, EmptyState, hasMbid, type LibraryPageTrack } from "./libraryShared.tsx";

export type AlbumCardOptions = { showArtist?: boolean; showType?: boolean; showTotal?: boolean };

type RenderAlbumCard = (album: LibraryAlbum, options?: AlbumCardOptions) => ReactNode;

const MOST_PLAYED = 10;

const count = (total: number, unit: string) => `${total} ${unit}${total === 1 ? "" : "s"}`;

const isSingle = (album: LibraryAlbum) => ["Single", "EP"].includes(releaseTypeOf(album) ?? "");

const newestFirst = (left: LibraryAlbum, right: LibraryAlbum) =>
  String(right.releaseDate || "").localeCompare(String(left.releaseDate || ""));

function ReleaseSection({
  title,
  albums,
  showArtist,
  action,
  renderAlbumCard,
}: {
  title: string;
  albums: LibraryAlbum[];
  showArtist: boolean;
  action: ReactNode;
  renderAlbumCard: RenderAlbumCard;
}) {
  const showType = new Set(albums.map(releaseTypeOf)).size > 1;
  return (
    <section className="library-artist__section">
      <div className="native-library-section-heading">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="native-library-grid library-artist__grid">
        {albums.map((album) => renderAlbumCard(album, { showArtist, showType, showTotal: false }))}
      </div>
    </section>
  );
}

export function LibraryArtistDetail({
  artist,
  albums,
  topTracks,
  favorite,
  actions,
  menu,
  menuItems,
  loadTracks,
  renderAlbumCard,
}: {
  artist: LibraryArtist;
  albums: LibraryAlbum[];
  topTracks: LibraryPageTrack[] | null;
  favorite: boolean;
  actions: LibraryActions;
  menu: Omit<ComponentProps<typeof LibraryItemMenu>, "label" | "items">;
  menuItems: LibraryMenuItem[];
  loadTracks: () => Promise<LibraryCollection>;
  renderAlbumCard: RenderAlbumCard;
}) {
  const artworkStyle = useSharedArtworkStyle();
  const { data: plays } = useQuery({
    ...libraryArtistPlaysQueryOptions(String(artist.id)),
    enabled: topTracks !== null,
  });
  const name = artist.name || "Unknown Artist";
  const owned = albums
    .filter((album) => String(album.artistId) === String(artist.id))
    .sort(newestFirst);
  const { mbid } = artist;
  const appearsOn = mbid
    ? albums
        .filter((album) => !owned.includes(album) && album.creditedArtistMbids?.includes(mbid))
        .sort(newestFirst)
    : [];
  const releases = owned.filter((album) => !isSingle(album));
  const sections = [
    { title: "Albums", albums: releases, showArtist: false },
    { title: "Singles and EPs", albums: owned.filter(isSingle), showArtist: false },
    { title: "Appears on", albums: appearsOn, showArtist: true },
  ].filter((section) => section.albums.length);
  const tracks = owned.flatMap(actions.getAlbumTracks);
  const playable = tracks.some((track) => firstAvailableFile(track));
  const trackTotal = new Set(
    tracks.filter((track) => firstAvailableFile(track)).map((track) => String(track.id)),
  ).size;
  const mostPlayed = (topTracks ?? tracks).slice(0, MOST_PLAYED);
  const isCurrent =
    actions.matchesSource(LIBRARY_SOURCE) &&
    tracks.some((track) => String(track.id) === String(actions.currentTrack?.id));
  const isPlaying = isCurrent && actions.isRunning;
  const meta = [
    releases.length ? count(releases.length, "album") : "",
    trackTotal ? count(trackTotal, "track") : "",
    plays ? count(plays, "play") : "",
  ].filter(Boolean);

  return (
    <section className="library-artist">
      <div className="library-artist__hero" data-library-menu-target>
        <div className="library-artist__photo" style={artworkStyle}>
          <Cover src={artist.coverUrl} label={artist.name} thumbnail={false} round />
        </div>
        <div className="library-artist__body">
          <h1 className="library-artist__name">{name}</h1>
          {meta.length ? <p className="library-artist__meta">{meta.join(" · ")}</p> : null}
          <div className="library-artist__actions native-library-detail__actions">
            <TooltipButton
              className="btn btn-accent btn-round-lg library-artist__play"
              disabled={!playable}
              label={`${isPlaying ? "Pause" : "Play"} ${name}`}
              onClick={() =>
                isCurrent ? actions.togglePlayPause() : actions.playCollection(loadTracks)
              }
            >
              {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            </TooltipButton>
            <TooltipButton
              className="native-library-favorite"
              disabled={!playable}
              label={`Shuffle ${name}`}
              onClick={() => actions.playCollection(loadTracks, true)}
            >
              <Shuffle aria-hidden="true" />
            </TooltipButton>
            <FavoriteButton
              active={favorite}
              pending={Boolean(actions.pendingFavorite)}
              label={name}
              onClick={() => actions.toggleFavorite("artist", artist)}
            />
            <LibraryItemMenu
              label={name}
              {...menu}
              items={[
                ...actions.collectionQueueItems(loadTracks, !playable, {
                  seed: { artists: [{ id: String(artist.id) }] },
                  label: name,
                }),
                actions.shareMenuItem({ kind: "artist", entity: artist }),
                {
                  id: "info",
                  label: "View info",
                  icon: Info,
                  onSelect: () => actions.openLibraryInfo({ kind: "artist", entity: artist }),
                },
                ...menuItems,
              ]}
            />
            {hasMbid(artist) ? (
              <RouteLink
                to={"/artist/" + encodeURIComponent(artist.mbid)}
                state={actions.discoverArtistState(artist)}
                className="btn btn-ghost library-artist__discover"
              >
                <Sparkles aria-hidden="true" />
                <span>Discover</span>
              </RouteLink>
            ) : null}
          </div>
        </div>
      </div>
      {mostPlayed.length ? (
        <section className="library-artist__section">
          <div className="native-library-section-heading">
            <h2>Most played</h2>
            {trackTotal > mostPlayed.length ? (
              <RouteLink
                to={"/library/tracks?artist=" + encodeURIComponent(String(artist.id))}
                className="section-show-all"
              >
                All tracks
              </RouteLink>
            ) : null}
          </div>
          <TrackList
            label={`${name} most played`}
            variant="compact"
            rows={mostPlayed.map((track, index) => {
              const row = actions.buildLibraryTrackRow(track, index, mostPlayed);
              return { ...row, subtitle: row.album?.label };
            })}
          />
        </section>
      ) : null}
      {sections.map((section, index) => (
        <ReleaseSection
          key={section.title}
          {...section}
          renderAlbumCard={renderAlbumCard}
          action={
            index === 0 && hasMbid(artist) ? (
              <RouteLink
                to={"/artist/" + encodeURIComponent(artist.mbid)}
                state={actions.discoverArtistState(artist)}
                className="section-show-all"
              >
                Full discography
              </RouteLink>
            ) : null
          }
        />
      ))}
      {sections.length ? null : (
        <EmptyState title="No albums" message="No albums for this artist." />
      )}
    </section>
  );
}
