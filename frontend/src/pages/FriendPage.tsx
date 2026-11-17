import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { parseResponse, type InferResponseType } from "hono/client";
import { AlertCircle, Users } from "../components/icons";
import StatePanel from "../components/StatePanel";
import { FriendButton } from "../components/FriendButton";
import { FriendArt, useFriends, useHubLink } from "../components/PlayerFriends";
import { useAuth } from "../contexts/AuthContext";
import { queryKeys } from "../queryClient";
import { hubLinkClient } from "../utils/api/clients/hubLink.ts";
import { peopleClient } from "../utils/api/clients/people.ts";
import { readApiError } from "../utils/api/errors.ts";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { resolveAlbumPath, resolveArtistPath } from "../navigation/resolveLinks.ts";
import { FRIEND_BLEND_MIX_PREFIX } from "../../../lib/browsePlaylists.ts";

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

  const playlists = profile.data?.playlists ?? [];
  const blendNote =
    friend &&
    friends.data?.state === "linked" &&
    friends.data.sharing &&
    !playlists.some((playlist) => playlist.id.startsWith(FRIEND_BLEND_MIX_PREFIX)) ? (
      <p className="friend-page__empty">
        Your Blend with {name} fills in once you both play a few more tracks.
      </p>
    ) : null;

  const lists = friend ? (
    hasTopPlays(top) ? (
      <TopPlayLists top={top} />
    ) : (
      <p className="friend-page__empty">No top plays from {name} yet.</p>
    )
  ) : self ? (
    <>
      {friends.data?.state === "linked" && !friends.data.sharing ? (
        <p className="friend-page__empty">
          {"Friends don't see your listening. Share it in Profile."}
        </p>
      ) : null}
      {hasTopPlays(top) ? <TopPlayLists top={top} /> : null}
    </>
  ) : (
    <p className="friend-page__empty">Friends see what {name} is playing and their top plays.</p>
  );

  return (
    <div className="library-page native-library-page" aria-busy={profile.isPending}>
      <header className="native-library-header">
        <div className="native-library-title-row friend-page__title">
          <h1 className="page-title">{name}</h1>
          {profile.data ? <FriendButton handle={handle} /> : null}
        </div>
        <FriendNowPlaying playing={friend?.nowPlaying} />
      </header>
      <div className="native-library-content">
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
            {playlists.length ? (
              <DiscoverPlaylistSection
                title="Playlists"
                playlists={playlists.map((playlist) => ({ ...playlist, curator: null }))}
              />
            ) : (
              <p className="friend-page__empty">No public playlists from {name} yet.</p>
            )}
            {blendNote}
            {lists}
          </>
        ) : null}
      </div>
    </div>
  );
}
