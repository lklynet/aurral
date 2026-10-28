import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { ArrowDown, ArrowUp, Check, Pause, Play, Plus } from "../components/icons";
import ArtworkImage from "../components/ArtworkImage";
import { DiscoverRail } from "../components/DiscoverRail";
import { DotLoader } from "../components/DotLoader";
import RouteLink from "../components/RouteLink";
import { SkeletonRail, SkeletonStatus } from "../components/Skeletons";
import Tooltip from "../components/Tooltip";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useAudioQueue } from "../contexts/audioQueueContext.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { playlistPath } from "../navigation/playlistPaths";
import { resolveAlbumPath, resolveArtistPath } from "../navigation/resolveLinks.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { trendingChartsQueryOptions } from "../queryOptions.ts";
import { discoveryClient } from "../utils/api/clients/discovery.ts";
import { normalizePlaylistQueueTrack } from "../utils/audioQueue.ts";
import { formatRelativeTime } from "../utils/dateTime.ts";
import { DiscoverPlaylistSection, editorialPlaylistPath } from "./DiscoverPlaylistSection";
import { mapPreviewTracks } from "./deezerPreviewTracks.ts";
import { getApiErrorMessage } from "./onboardingUtils";
import { TrendingArtistsRail } from "./TrendingArtistsRail";
import { useEditorialShelf } from "./useEditorialShelf";
import { useTrackSaveActions } from "./useTrackSaveActions";
import "./TrendingPage.css";

type TrendingCharts = InferResponseType<typeof discoveryClient.trending.$get, 200>;
type Songs = NonNullable<TrendingCharts["songs"]>;
type Spotlight = NonNullable<Songs["spotlight"]>;
type GenreShare = NonNullable<TrendingCharts["genreShare"]>;

const SONG_GRID_END = 10;
const SPARK_WIDTH = 220;
const SPARK_HEIGHT = 56;
const SPARK_PAD = 6;

const regionName = (region: string | null) => {
  if (!region) return null;
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(region) ?? region;
  } catch {
    return region;
  }
};

function Movement({ value }: { value: Songs["items"][number]["movement"] }) {
  if (value === "new") return <span className="trending-movement is-new">New</span>;
  if (!value) return <span className="trending-movement" />;
  const Icon = value > 0 ? ArrowUp : ArrowDown;
  const label = `${value > 0 ? "Up" : "Down"} ${Math.abs(value)}`;
  return (
    <span className={`trending-movement${value > 0 ? " is-up" : ""}`} aria-label={label}>
      <Icon aria-hidden="true" />
      {Math.abs(value)}
    </span>
  );
}

function RankSparkline({ ranks }: { ranks: Spotlight["ranks"] }) {
  const lowest = Math.max(10, ...ranks.map((rank) => rank ?? 0));
  const x = (index: number) =>
    SPARK_PAD + ((SPARK_WIDTH - SPARK_PAD * 2) * index) / (ranks.length - 1);
  const y = (rank: number) =>
    SPARK_PAD + ((SPARK_HEIGHT - SPARK_PAD * 2) * (rank - 1)) / (lowest - 1);
  const path = ranks
    .map((rank, index) => {
      if (rank === null) return "";
      const command = index > 0 && ranks[index - 1] !== null ? "L" : "M";
      return `${command}${x(index).toFixed(1)},${y(rank).toFixed(1)}`;
    })
    .join(" ");
  const lastIndex = ranks.findLastIndex((rank) => rank !== null);
  const last = ranks[lastIndex];
  const charted = ranks.filter((rank) => rank !== null).length;
  return (
    <svg
      className="trending-spark"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      role="img"
      aria-label={`Charted ${charted} of the last ${ranks.length} days`}
    >
      <line
        className="trending-spark__grid"
        x1={SPARK_PAD}
        x2={SPARK_WIDTH - SPARK_PAD}
        y1={SPARK_PAD}
        y2={SPARK_PAD}
      />
      <path className="trending-spark__line" d={path} />
      {ranks.map((rank, index) =>
        rank === null ? null : (
          <circle key={index} className="trending-spark__hit" cx={x(index)} cy={y(rank)} r={8}>
            <title>{`${ranks.length - 1 - index === 0 ? "Today" : `${ranks.length - 1 - index}d ago`}: No. ${rank}`}</title>
          </circle>
        ),
      )}
      {last ? (
        <circle className="trending-spark__dot" cx={x(lastIndex)} cy={y(last)} r={4} />
      ) : null}
    </svg>
  );
}

function GenreBars({ share }: { share: GenreShare }) {
  const top = share.genres[0]?.count || 1;
  return (
    <section className="trending-genres" aria-labelledby="trending-genres-title">
      <div className="artist-discover-rail__header">
        <h2 id="trending-genres-title" className="artist-section-title--discover">
          Genres in the top {share.total} albums
        </h2>
      </div>
      <ul className="trending-genres__list">
        {share.genres.map((genre) => (
          <li key={genre.name} className="trending-genres__row">
            <span className="trending-genres__name">{genre.name}</span>
            <Tooltip content={`${genre.count} of ${share.total} albums`} placement="top">
              <span className="trending-genres__track" tabIndex={0}>
                <span
                  className="trending-genres__bar"
                  style={{ width: `${Math.max(2, (100 * genre.count) / top)}%` }}
                />
              </span>
            </Tooltip>
            <span className="trending-genres__count">{genre.count}</span>
          </li>
        ))}
      </ul>
      {share.other > 0 ? (
        <p className="trending-genres__other">Other genres: {share.other}</p>
      ) : null}
    </section>
  );
}

function TrendingSkeleton() {
  return (
    <SkeletonStatus label="Loading charts">
      <SkeletonRail kind="album" />
      <SkeletonRail kind="album" />
      <SkeletonRail kind="artist" />
    </SkeletonStatus>
  );
}

export default function TrendingPage() {
  useDocumentTitle("Trending");
  const { user, hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();
  const chartsQuery = trendingChartsQueryOptions(user?.id);
  const { data, error, isPending, isFetching, refetch } = useQuery(chartsQuery);
  const { data: shelf } = useEditorialShelf();
  const trackSaveActions = useTrackSaveActions();
  const { playQueue, togglePlayPause, currentTrack, isPlaying, matchesSource } = useAudioQueue();
  const [savingPlaylist, setSavingPlaylist] = useState(false);

  const songs = data?.songs ?? null;
  const tracks = useMemo(
    () => mapPreviewTracks(songs?.items, songs?.playlistId ?? "trending"),
    [songs],
  );
  const playbackSource = useMemo(
    () => ({
      type: "trending-songs",
      id: songs?.playlistId ?? "trending",
      label: songs?.playlistName ?? "Top songs",
      recordHistory: false,
    }),
    [songs?.playlistId, songs?.playlistName],
  );
  const queueTracks = useMemo(
    () =>
      tracks
        .filter((track) => track.streamUrl)
        .map((track) => normalizePlaylistQueueTrack(track, { recordHistory: false })),
    [tracks],
  );
  const currentId = matchesSource(playbackSource) ? String(currentTrack?.id ?? "") : "";
  const isTrackPlaying = (index: number) => currentId === tracks[index]?.id && isPlaying;
  const playFrom = (index: number) => {
    const track = tracks[index];
    if (!track?.streamUrl) return;
    if (currentId === track.id) {
      togglePlayPause();
      return;
    }
    playQueue(queueTracks, { startTrackId: track.id, source: playbackSource });
  };

  const savePlaylist = async () => {
    if (!songs) return;
    setSavingPlaylist(true);
    try {
      const result = await parseResponse(
        discoveryClient.editorial[":playlistId"].library.$post({
          param: { playlistId: encodeURIComponent(songs.playlistId) },
        }),
      );
      queryClient.setQueryData(chartsQuery.queryKey, (current) =>
        current?.songs
          ? { ...current, songs: { ...current.songs, libraryPlaylistId: result.playlistId } }
          : current,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.editorialPlaylist(user?.id, songs.playlistId),
      });
      showSuccess(
        result.alreadyAdded
          ? `${result.name} is already in your playlists`
          : `Added ${result.name} to your playlists. It syncs with Deezer daily.`,
      );
    } catch (err) {
      showError(getApiErrorMessage(err, "Couldn't save this chart. Nothing was added. Try again."));
    } finally {
      setSavingPlaylist(false);
    }
  };

  const region = regionName(data?.region ?? null);
  const updated = data?.updatedAt ? formatRelativeTime(new Date(data.updatedAt)) : null;
  const popularPlaylists = shelf?.genres.find((genre) => genre.id === 0)?.playlists ?? [];
  const hasCharts = Boolean(
    data && (data.songs || data.albums || data.artists || data.genres.length > 0),
  );

  const renderCharts = () => {
    if (isPending) return <TrendingSkeleton />;
    if (error || !hasCharts) {
      return (
        <div className="search-empty-panel" role={error ? "alert" : "status"}>
          <h2 className="search-empty-panel__title">
            {error ? "Charts didn’t load" : "Charts are on the way"}
          </h2>
          <p className="search-empty-panel__message">
            {error
              ? getApiErrorMessage(error, "Aurral couldn't load the charts. Try again.")
              : "Aurral fetches the charts from Deezer and Apple Music a few minutes after it starts."}
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            Try again
          </button>
        </div>
      );
    }
    const lead = songs?.items[0];
    const leadTrack = tracks[0];
    const leadPlaying = isTrackPlaying(0);
    const leadAlbumPath = lead
      ? resolveAlbumPath({
          artistName: lead.artistName,
          albumName: lead.albumName,
          deezerAlbumId: lead.deezerAlbumId,
        })
      : null;
    const leadArtistPath = lead ? resolveArtistPath({ name: lead.artistName }) : null;
    const leadArtwork = lead?.largeArtworkUrl || lead?.artworkUrl;
    const canSavePlaylist = hasPermission("accessFlow");

    return (
      <>
        {lead && leadTrack ? (
          <section className="trending-spotlight" aria-label="No. 1 song">
            {leadArtwork ? (
              <ArtworkImage
                src={leadArtwork}
                alt=""
                className="trending-spotlight__cover"
                loading="eager"
              />
            ) : (
              <span className="trending-spotlight__cover" />
            )}
            <div className="trending-spotlight__main">
              <h2 className="trending-spotlight__title">{lead.trackName}</h2>
              <p className="trending-spotlight__by">
                No. 1 ·{" "}
                {leadArtistPath ? (
                  <RouteLink to={leadArtistPath}>{lead.artistName}</RouteLink>
                ) : (
                  lead.artistName
                )}
                {lead.albumName && lead.albumName !== lead.trackName ? (
                  <>
                    {" · "}
                    {leadAlbumPath ? (
                      <RouteLink to={leadAlbumPath}>{lead.albumName}</RouteLink>
                    ) : (
                      lead.albumName
                    )}
                  </>
                ) : null}
              </p>
              <div className="trending-spotlight__actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => playFrom(0)}
                  disabled={!leadTrack.streamUrl}
                >
                  {leadPlaying ? (
                    <Pause aria-hidden="true" fill="currentColor" />
                  ) : (
                    <Play aria-hidden="true" fill="currentColor" />
                  )}
                  {leadPlaying ? "Pause" : "Preview"}
                </button>
                {trackSaveActions.onAddTrackToLibrary ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => trackSaveActions.onAddTrackToLibrary?.(leadTrack)}
                    disabled={Boolean(trackSaveActions.libraryTrackSavingKey)}
                  >
                    {trackSaveActions.libraryTrackSavingKey === leadTrack.id ? (
                      <DotLoader size="sm" label={null} />
                    ) : (
                      <Plus aria-hidden="true" />
                    )}
                    Add to Library
                  </button>
                ) : null}
              </div>
            </div>
            {songs?.spotlight ? (
              <div className="trending-spotlight__trend">
                <p className="trending-spotlight__stat">
                  {songs.spotlight.daysAtTop} {songs.spotlight.daysAtTop === 1 ? "day" : "days"}
                  <span>at No. 1</span>
                </p>
                <RankSparkline ranks={songs.spotlight.ranks} />
                <p className="trending-spotlight__caption">Rank, last 14 days</p>
              </div>
            ) : null}
          </section>
        ) : null}

        {songs && songs.items.length > 1 ? (
          <section className="trending-section" aria-labelledby="trending-songs-title">
            <div className="artist-discover-rail__header">
              <h2 id="trending-songs-title" className="artist-section-title--discover">
                Top songs
              </h2>
              <div className="artist-discover-rail__actions">
                {canSavePlaylist && songs.libraryPlaylistId ? (
                  <RouteLink
                    to={playlistPath(songs.libraryPlaylistId)}
                    className="artist-discover-rail__show-all trending-section__saved"
                  >
                    <Check aria-hidden="true" />
                    Saved as playlist
                  </RouteLink>
                ) : canSavePlaylist ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={savePlaylist}
                    disabled={savingPlaylist}
                  >
                    {savingPlaylist ? <DotLoader size="sm" label={null} /> : null}
                    Save as playlist
                  </button>
                ) : null}
                <RouteLink
                  to={editorialPlaylistPath(songs.playlistId)}
                  className="artist-discover-rail__show-all"
                >
                  Show all {songs.items.length}
                </RouteLink>
              </div>
            </div>
            <ol className="trending-songs">
              {songs.items.slice(1, SONG_GRID_END).map((song, offset) => {
                const index = offset + 1;
                const playing = isTrackPlaying(index);
                return (
                  <li key={song.key}>
                    <button
                      type="button"
                      className={`trending-song${currentId === tracks[index]?.id ? " is-current" : ""}`}
                      onClick={() => playFrom(index)}
                      disabled={!song.preview_url}
                      aria-label={`${playing ? "Pause" : "Play"} ${song.trackName} by ${song.artistName}`}
                    >
                      <span className="trending-song__rank">{song.position}</span>
                      <span className="trending-song__art">
                        {song.artworkUrl ? (
                          <ArtworkImage src={song.artworkUrl} alt="" loading="lazy" />
                        ) : null}
                        <span className="trending-song__play">
                          {playing ? (
                            <Pause aria-hidden="true" fill="currentColor" />
                          ) : (
                            <Play aria-hidden="true" fill="currentColor" />
                          )}
                        </span>
                      </span>
                      <span className="trending-song__text">
                        <span className="trending-song__title">{song.trackName}</span>
                        <span className="trending-song__artist">{song.artistName}</span>
                      </span>
                      <Movement value={song.movement} />
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {data?.albums?.length ? (
          <DiscoverRail title="Top albums">
            {data.albums.map((album) => {
              const label = `No. ${album.position}, ${album.name} by ${album.artistName}`;
              const text = (
                <>
                  <div className="artist-card-title-row--discover">
                    <Tooltip content={album.name}>
                      <span className="artist-card-title--discover">{album.name}</span>
                    </Tooltip>
                  </div>
                  <p className="artist-card-meta--discover">{album.artistName}</p>
                </>
              );
              const to = resolveAlbumPath({ artistName: album.artistName, albumName: album.name });
              return (
                <div key={album.key} className="artist-discover-shelf-card">
                  <div
                    className="artist-discover-card artist-discover-card--album"
                    data-artwork-scope
                  >
                    <div className="artist-discover-card__cover" data-artwork>
                      {album.artworkUrl ? (
                        <ArtworkImage
                          src={album.artworkUrl}
                          alt=""
                          className="artist-discover-card__image"
                          loading="lazy"
                        />
                      ) : null}
                      <span className="trending-album__rank" aria-hidden="true">
                        {album.position}
                      </span>
                    </div>
                    <div className="artist-discover-card__content">
                      {to ? (
                        <RouteLink
                          to={to}
                          className="artist-discover-card__text card-link"
                          aria-label={label}
                        >
                          {text}
                        </RouteLink>
                      ) : (
                        <div className="artist-discover-card__text">{text}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </DiscoverRail>
        ) : null}

        {data?.artists ? <TrendingArtistsRail title="Top artists" artists={data.artists} /> : null}

        {data && data.genres.length > 0 ? (
          <DiscoverRail title="Charts by genre">
            {data.genres.map((genre) => (
              <div key={genre.id} className="artist-discover-shelf-card">
                <div className="artist-discover-card artist-discover-card--playlist">
                  <div className="artist-discover-card__cover trending-genre-card__cover">
                    {genre.covers.map((cover) => (
                      <ArtworkImage key={cover} src={cover} alt="" loading="lazy" />
                    ))}
                  </div>
                  <div className="artist-discover-card__content">
                    <RouteLink
                      to={`/discover/trending/genres/${genre.id}`}
                      className="artist-discover-card__text card-link"
                      aria-label={`Open Top ${genre.name}`}
                    >
                      <div className="artist-card-title-row--discover">
                        <span className="artist-card-title--discover">Top {genre.name}</span>
                      </div>
                      <p className="artist-card-meta--discover">
                        {genre.artists.length > 0 ? `${genre.artists.join(", ")} and more` : null}
                      </p>
                    </RouteLink>
                  </div>
                </div>
              </div>
            ))}
          </DiscoverRail>
        ) : null}

        {data?.genreShare?.genres.length || popularPlaylists.length > 0 ? (
          <div className="trending-pair">
            {data?.genreShare?.genres.length ? <GenreBars share={data.genreShare} /> : null}
            <DiscoverPlaylistSection
              title="Popular playlists"
              playlists={popularPlaylists}
              showViewAll
            />
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div className="trending-page">
      <header className="trending-page__header">
        <h1 className="page-title">Trending</h1>
        {region || updated ? (
          <p className="trending-page__meta">
            {[region, updated ? `updated ${updated}` : null].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </header>
      {renderCharts()}
    </div>
  );
}
