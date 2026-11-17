import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { parseResponse, type InferResponseType } from "hono/client";
import { AlertCircle, ListMusic, Users } from "../components/icons";
import ArtworkImage from "../components/ArtworkImage";
import { ClaimBadge } from "../components/PlaylistCard";
import RelativeTime from "../components/RelativeTime";
import RouteLink from "../components/RouteLink";
import StatePanel from "../components/StatePanel";
import Tooltip from "../components/Tooltip";
import { useCollectionTint } from "../components/CollectionHeader";
import { FriendButton } from "../components/FriendButton";
import { FriendArt, friendArtSrc, useFriends, useHubLink } from "../components/PlayerFriends";
import { useAuth } from "../contexts/AuthContext";
import { queryKeys } from "../queryClient";
import { browsePlaylistPath } from "../navigation/playlistPaths.ts";
import { resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { hubLinkClient } from "../utils/api/clients/hubLink.ts";
import { peopleClient } from "../utils/api/clients/people.ts";
import { readApiError } from "../utils/api/errors.ts";
import type { BrowseShelfPlaylist } from "./DiscoverPlaylistSection";
import { formatTrackTotal } from "./playlists/playlistPageUtils";
import { usePlaylistClaims } from "./usePlaylistShelf";
import { resolveAlbumPath, resolveArtistPath } from "../navigation/resolveLinks.ts";
import { albumPath } from "../../../lib/albumPath.ts";
import { BLEND_MIX_PREFIX, FRIEND_BLEND_MIX_PREFIX } from "../../../lib/browsePlaylists.ts";

const plays = (count: number) => `${count} ${count === 1 ? "play" : "plays"}`;
const searchPath = (query: string) => `/search?${new URLSearchParams({ q: query })}`;

function Ranked({
  title,
  className = "friend-page__section",
  rows,
}: {
  title: string;
  className?: string;
  rows: {
    key: string;
    to: string;
    name: string;
    note: string;
    art?: string | null;
    round?: boolean;
  }[];
}) {
  if (!rows.length) return null;
  return (
    <section className={className}>
      <div className="native-library-section-heading">
        <h2>{title}</h2>
      </div>
      <ol className="friend-page__list">
        {rows.map((row, index) => (
          <li key={row.key}>
            <Link className="friend-page__row" to={row.to}>
              <span className="friend-page__rank">{index + 1}</span>
              {row.art === undefined ? null : <FriendArt src={row.art} round={row.round} />}
              <span className="player-queue__copy">
                <span className="player-queue__name">{row.name}</span>
                <span className="player-queue__artist">{row.note}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Person = InferResponseType<(typeof peopleClient)[":username"]["$get"], 200>;
type TopPlays = Person["topPlays"];
type LocalPerson = InferResponseType<typeof peopleClient.$get>["people"][number];
type Listener = { [Key in "nowPlaying" | "lastPlayed"]?: LocalPerson[Key] | null };

export const hasTopPlays = (top: TopPlays | null | undefined): top is TopPlays =>
  !!top && top.artists.length + top.albums.length + top.tracks.length > 0;

function FriendListening({ listener }: { listener: Listener | null | undefined }) {
  const track = listener?.nowPlaying ?? listener?.lastPlayed;
  if (!track) return null;
  const playedAt = listener?.nowPlaying ? null : listener?.lastPlayed?.at;
  return (
    <Link
      className="friend-page__row friend-page__now"
      to={
        resolveAlbumPath({ artistName: track.artist, albumName: track.album }) ??
        resolveArtistPath({ name: track.artist }) ??
        searchPath(track.title)
      }
    >
      <FriendArt src={track.artworkUrl} />
      <span className="player-queue__copy">
        <span className="player-queue__name">
          {playedAt ? null : (
            <span className="track-playing-indicator" role="img" aria-label="Playing now">
              <span />
              <span />
              <span />
            </span>
          )}
          <span className="friend-page__now-title">{track.title}</span>
        </span>
        <span className="player-queue__artist">
          {playedAt ? (
            <>
              {track.artist} · <RelativeTime value={playedAt} />
            </>
          ) : (
            [track.artist, track.album].filter(Boolean).join(" · ")
          )}
        </span>
      </span>
    </Link>
  );
}

const isBlend = (playlist: BrowseShelfPlaylist) =>
  [BLEND_MIX_PREFIX, FRIEND_BLEND_MIX_PREFIX].some((prefix) => playlist.id.startsWith(prefix));

function ProfilePlaylist({
  playlist,
  name,
  claim,
}: {
  playlist: BrowseShelfPlaylist;
  name: string;
  claim: ReturnType<ReturnType<typeof usePlaylistClaims>>;
}) {
  const [failed, setFailed] = useState(false);
  const artworkUrl = resolveAuthenticatedApiAssetUrl(playlist.artworkUrl);
  const blend = isBlend(playlist);
  const tracks = formatTrackTotal(playlist.trackCount);
  return (
    <li className="discover-feed-tile discover-feed-tile--list">
      <RouteLink
        className="discover-feed-tile__body"
        to={browsePlaylistPath(playlist.provider, playlist.id)}
        state={{
          seed: {
            name: playlist.name,
            artworkUrl: playlist.artworkUrl,
            trackCount: playlist.trackCount,
          },
        }}
      >
        <span className="discover-feed-tile__art">
          {artworkUrl && !failed ? (
            <ArtworkImage src={artworkUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
          ) : (
            <ListMusic aria-hidden="true" />
          )}
        </span>
        <span className="discover-feed-tile__text">
          <span className="discover-feed-tile__title">{blend ? "Blend" : playlist.name}</span>
          <span className="discover-feed-tile__meta">
            {blend ? `You and ${name} · ${tracks}` : tracks}
          </span>
        </span>
      </RouteLink>
      {claim ? <ClaimBadge claim={claim} /> : null}
    </li>
  );
}

export function ProfilePlaylists({
  title,
  name,
  playlists,
}: {
  title: string;
  name: string;
  playlists: BrowseShelfPlaylist[];
}) {
  const claimOf = usePlaylistClaims();
  if (!playlists.length) return null;
  return (
    <section>
      <div className="native-library-section-heading">
        <h2>{title}</h2>
      </div>
      <ul className="friend-page__playlists">
        {playlists.map((playlist) => (
          <ProfilePlaylist
            key={`${playlist.provider}:${playlist.id}`}
            playlist={playlist}
            name={name}
            claim={claimOf(playlist)}
          />
        ))}
      </ul>
    </section>
  );
}

export function ProfileNotes({ notes }: { notes: (string | false | null)[] }) {
  const shown = notes.filter((note) => typeof note === "string");
  if (!shown.length) return null;
  return (
    <div className="friend-page__notes">
      {shown.map((note) => (
        <p key={note} className="friend-page__empty">
          {note}
        </p>
      ))}
    </div>
  );
}

const HOUR_MARKS = [0, 6, 12, 18];
const hourName = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;

function ListeningStats({ stats }: { stats: NonNullable<TopPlays["stats"]> }) {
  const peak = Math.max(1, ...stats.hours);
  const peakHour = stats.hours.indexOf(peak);
  const listened = stats.minutes >= 60 ? `${Math.round(stats.minutes / 60)}h` : `${stats.minutes}m`;
  return (
    <section
      className="friend-page__section friend-stats"
      aria-label="Listening in the last 30 days"
    >
      <div className="native-library-section-heading">
        <h2>Last 30 days</h2>
      </div>
      <div className="friend-stats__totals">
        <p>
          <strong>{stats.plays}</strong> {stats.plays === 1 ? "play" : "plays"}
        </p>
        {stats.minutes ? (
          <p>
            <strong>{listened}</strong> listened
          </p>
        ) : null}
        <p>
          <strong>{stats.artists}</strong> {stats.artists === 1 ? "artist" : "artists"}
        </p>
      </div>
      {peakHour >= 0 ? (
        <p className="friend-stats__peak">Most plays around {hourName(peakHour)}</p>
      ) : null}
      <div className="friend-stats__hours">
        {stats.hours.map((count, hour) => (
          <Tooltip key={hour} placement="top" content={`${hourName(hour)} · ${plays(count)}`}>
            <span
              className="friend-stats__hour"
              data-empty={count ? undefined : ""}
              data-peak={hour === peakHour ? "" : undefined}
              style={{ "--share": count / peak }}
            />
          </Tooltip>
        ))}
      </div>
      <div className="friend-stats__axis" aria-hidden="true">
        {HOUR_MARKS.map((hour) => (
          <span key={hour} style={{ gridColumn: `${hour + 1} / span 6` }}>
            {hourName(hour)}
          </span>
        ))}
      </div>
    </section>
  );
}

export function TopPlayLists({ top }: { top: TopPlays }) {
  return (
    <div className="friend-page__lists" data-stats={top.stats?.plays ? "" : undefined}>
      {top.stats?.plays ? <ListeningStats stats={top.stats} /> : null}
      <Ranked
        title="Top artists"
        rows={top.artists.map((artist) => ({
          key: artist.name,
          to: artist.mbid
            ? `/artist/${artist.mbid}`
            : (resolveArtistPath({ name: artist.name }) ?? searchPath(artist.name)),
          name: artist.name,
          note: plays(artist.plays),
          art: artist.artworkUrl,
          round: true,
        }))}
      />
      <Ranked
        title="Top albums"
        rows={top.albums.map((album) => ({
          key: `${album.artist}\u0000${album.title}`,
          to: album.mbid
            ? albumPath(album.mbid)
            : (resolveAlbumPath({ artistName: album.artist, albumName: album.title }) ??
              searchPath(album.title)),
          name: album.title,
          note: `${album.artist} · ${plays(album.plays)}`,
          art: album.artworkUrl,
        }))}
      />
      <Ranked
        title="Top tracks"
        className="friend-page__section friend-page__section--tracks"
        rows={top.tracks.map((track) => ({
          key: `${track.artist}\u0000${track.title}`,
          to: track.albumMbid
            ? albumPath(track.albumMbid, { track: track.mbid })
            : searchPath(`${track.artist} ${track.title}`),
          name: track.title,
          note: `${track.artist} · ${plays(track.plays)}`,
        }))}
      />
    </div>
  );
}

export function ProfilePage({
  title,
  action,
  listener,
  top,
  busy,
  children,
}: {
  title: string;
  action: ReactNode;
  listener: Listener | null | undefined;
  top: TopPlays | null | undefined;
  busy: boolean;
  children: ReactNode;
}) {
  const track = listener?.nowPlaying ?? listener?.lastPlayed;
  const art = top?.artists[0]?.artworkUrl ?? track?.artworkUrl;
  const tint = useCollectionTint(art && friendArtSrc(art));
  return (
    <div
      className="library-page native-library-page collection-page"
      style={tint ? { "--collection-tint": tint } : undefined}
      aria-busy={busy}
    >
      <header className="native-library-header friend-page__header">
        <div className="native-library-title-row friend-page__title">
          <h1 className="page-title">{title}</h1>
          {action}
        </div>
        <FriendListening listener={listener} />
      </header>
      <div className="native-library-content friend-page__sections">{children}</div>
    </div>
  );
}

function useOwnTopPlays(enabled: boolean) {
  const { user } = useAuth();
  const username = user?.username ?? "";
  return useQuery({
    queryKey: queryKeys.person(user?.id, username),
    queryFn: ({ signal }) =>
      parseResponse(
        peopleClient[":username"].$get(
          { param: { username: encodeURIComponent(username) } },
          { init: { signal } },
        ),
      ),
    enabled: enabled && !!username,
  });
}

export default function FriendPage() {
  const { handle: param = "" } = useParams();
  const handle = param.replace(/^@/, "").toLowerCase();
  const { user } = useAuth();
  const profile = useQuery({
    queryKey: queryKeys.hubProfile(user?.id, handle),
    queryFn: ({ signal }) =>
      parseResponse(
        hubLinkClient.profiles[":handle"].$get(
          { param: { handle: encodeURIComponent(handle) } },
          { init: { signal } },
        ),
      ),
    retry: false,
  });
  const friends = useFriends(true, true);
  const link = useHubLink();
  const friend =
    friends.data?.state === "linked"
      ? friends.data.friends.find((row) => row.handle === handle)
      : null;
  const self = link.data?.state === "linked" && link.data.handle === handle;
  const own = useOwnTopPlays(self);
  const top = self ? own.data?.topPlays : friend?.topPlays;
  const name = `@${handle}`;

  const blend = profile.data?.blend ?? null;
  const playlists = [...(blend ? [blend] : []), ...(profile.data?.playlists ?? [])];
  const linked = friends.data?.state === "linked" ? friends.data : null;

  return (
    <ProfilePage
      title={name}
      action={profile.data ? <FriendButton handle={handle} /> : null}
      listener={friend}
      top={top}
      busy={profile.isPending}
    >
      {profile.isError ? (
        readApiError(profile.error).status === 404 ? (
          <StatePanel icon={<Users />} title={`No one on aurral.org is ${name}`} />
        ) : (
          <StatePanel
            icon={<AlertCircle />}
            title={`Couldn't load ${name}`}
            role="alert"
            onRetry={() => profile.refetch()}
            retrying={profile.isFetching}
          />
        )
      ) : profile.data ? (
        <>
          <ProfilePlaylists
            title={blend ? "Playlists" : "Public playlists"}
            name={name}
            playlists={playlists.map((playlist) => ({ ...playlist, curator: null }))}
          />
          <ProfileNotes
            notes={[
              !friend && !self && `Friends see what ${name} is playing and their top plays.`,
              self &&
                linked?.sharing === false &&
                "Friends don't see your listening. Share it in Profile.",
              !playlists.length && `No public playlists from ${name} yet.`,
              !!friend &&
                !!linked?.sharing &&
                !blend &&
                `Your Blend with ${name} fills in once you both play a few more tracks.`,
              !!friend && !hasTopPlays(top) && `No top plays from ${name} yet.`,
            ]}
          />
          {(friend || self) && hasTopPlays(top) ? <TopPlayLists top={top} /> : null}
        </>
      ) : null}
    </ProfilePage>
  );
}
