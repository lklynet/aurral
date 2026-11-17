import { Link, useParams } from "react-router";
import type { InferResponseType } from "hono/client";
import { AlertCircle, Users } from "../components/icons";
import StatePanel from "../components/StatePanel";
import { FriendArt, useFriends } from "../components/PlayerFriends";
import { SettingsLink } from "../navigation/settingsRoute";
import { resolveAlbumPath, resolveArtistPath } from "../navigation/resolveLinks.ts";
import type { peopleClient } from "../utils/api/clients/people.ts";

const plays = (count: number) => `${count} ${count === 1 ? "play" : "plays"}`;
const searchPath = (query: string) => `/search?${new URLSearchParams({ q: query })}`;

function Ranked({
  title,
  rows,
}: {
  title: string;
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
    <section className="friend-page__section">
      <div className="native-library-section-heading">
        <h2>
          {title} <span className="friend-page__window">30 days</span>
        </h2>
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
type Playing = NonNullable<
  InferResponseType<typeof peopleClient.$get>["people"][number]["nowPlaying"]
>;

export const hasTopPlays = (top: TopPlays | null | undefined): top is TopPlays =>
  !!top && top.artists.length + top.albums.length + top.tracks.length > 0;

export function FriendNowPlaying({ playing }: { playing: Playing | null | undefined }) {
  if (!playing) return null;
  return (
    <Link
      className="friend-page__row friend-page__now"
      to={
        resolveAlbumPath({ artistName: playing.artist, albumName: playing.album }) ??
        resolveArtistPath({ name: playing.artist }) ??
        searchPath(playing.title)
      }
    >
      <FriendArt src={playing.artworkUrl} />
      <span className="player-queue__copy">
        <span className="player-queue__name">{playing.title}</span>
        <span className="player-queue__artist">
          {[playing.artist, playing.album].filter(Boolean).join(" · ")}
        </span>
      </span>
    </Link>
  );
}

export function TopPlayLists({ top }: { top: TopPlays }) {
  return (
    <div className="friend-page__lists">
      <Ranked
        title="Top artists"
        rows={top.artists.map((artist) => ({
          key: artist.name,
          to: resolveArtistPath({ name: artist.name }) ?? searchPath(artist.name),
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
          to:
            resolveAlbumPath({ artistName: album.artist, albumName: album.title }) ??
            searchPath(album.title),
          name: album.title,
          note: `${album.artist} · ${plays(album.plays)}`,
          art: album.artworkUrl,
        }))}
      />
      <Ranked
        title="Top tracks"
        rows={top.tracks.map((track) => ({
          key: `${track.artist}\u0000${track.title}`,
          to: searchPath(`${track.artist} ${track.title}`),
          name: track.title,
          note: `${track.artist} · ${plays(track.plays)}`,
        }))}
      />
    </div>
  );
}

export default function FriendPage() {
  const { handle = "" } = useParams();
  const friends = useFriends(true, true);
  const data = friends.data;
  const friend =
    data?.state === "linked" ? data.friends.find((row) => row.handle === handle) : null;

  const state =
    friends.isError && !data ? (
      <StatePanel
        icon={<AlertCircle />}
        title="Couldn't load friends"
        role="alert"
        onRetry={() => friends.refetch()}
        retrying={friends.isFetching}
      />
    ) : !data ? null : data.state === "off" ? (
      <StatePanel
        icon={<Users />}
        title="Friends are off"
        message="An admin turned off aurral.org accounts on this server."
      />
    ) : data.state !== "linked" ? (
      <StatePanel icon={<Users />} title="Not linked to aurral.org">
        <SettingsLink to="profile" className="btn btn-secondary">
          {data.state === "broken" ? "Relink in Profile" : "Link in Profile"}
        </SettingsLink>
      </StatePanel>
    ) : !friend ? (
      <StatePanel icon={<Users />} title={`You and @${handle} aren't friends`} />
    ) : null;

  const top = friend?.topPlays;
  return (
    <div className="library-page native-library-page" aria-busy={!data}>
      <header className="native-library-header">
        <h1 className="page-title">@{handle}</h1>
        <FriendNowPlaying playing={friend?.nowPlaying} />
      </header>
      <div className="native-library-content">
        {!data && !friends.isError
          ? null
          : (state ??
            (hasTopPlays(top) ? (
              <TopPlayLists top={top} />
            ) : (
              <p className="friend-page__empty">No top plays from @{handle} yet.</p>
            )))}
      </div>
    </div>
  );
}
