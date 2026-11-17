import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useParams } from "react-router";
import { AlertCircle, Users } from "../components/icons";
import StatePanel from "../components/StatePanel";
import { useLocalPeople } from "../components/PlayerFriends";
import { useAuth } from "../contexts/AuthContext";
import { queryKeys } from "../queryClient";
import { peopleClient } from "../utils/api/clients/people.ts";
import { readApiError } from "../utils/api/errors.ts";
import { BLEND_MIX_PREFIX } from "../../../lib/browsePlaylists.ts";
import { DiscoverPlaylistSection } from "./DiscoverPlaylistSection";
import { FriendNowPlaying, hasTopPlays, TopPlayLists } from "./FriendPage";

export default function PersonPage() {
  const { username = "" } = useParams();
  const { user } = useAuth();
  const profile = useQuery({
    queryKey: queryKeys.person(user?.id, username),
    queryFn: ({ signal }) =>
      parseResponse(
        peopleClient[":username"].$get(
          { param: { username: encodeURIComponent(username) } },
          { init: { signal } },
        ),
      ),
    retry: false,
  });
  const people = useLocalPeople(true, true);
  const person = profile.data;
  const name = person?.username ?? username;
  const playing = people.data?.people.find((each) => each.id === person?.id)?.nowPlaying;
  const playlists = person?.playlists ?? [];
  const hasBlend = playlists.some((playlist) => playlist.id.startsWith(BLEND_MIX_PREFIX));
  const note = !person
    ? null
    : !playlists.length
      ? `Playlists from ${name}'s listening fill in once they play a few more tracks.`
      : !hasBlend
        ? `Your Blend with ${name} fills in once you both play a few more tracks.`
        : playlists.length === 1
          ? `${name}'s tracks fills in once they play a few more tracks.`
          : null;

  return (
    <div className="library-page native-library-page" aria-busy={profile.isPending}>
      <header className="native-library-header">
        <h1 className="page-title">{name}</h1>
        <FriendNowPlaying playing={playing} />
      </header>
      <div className="native-library-content">
        {profile.isError ? (
          readApiError(profile.error).status === 404 ? (
            <StatePanel icon={<Users />} title={`${username} isn't sharing listening with you`} />
          ) : (
            <StatePanel
              icon={<AlertCircle />}
              title={`Couldn't load ${username}`}
              role="alert"
              onRetry={() => profile.refetch()}
              retrying={profile.isFetching}
            />
          )
        ) : person ? (
          <>
            <DiscoverPlaylistSection title="Playlists" playlists={playlists} />
            {note ? <p className="friend-page__empty">{note}</p> : null}
            {hasTopPlays(person.topPlays) ? (
              <TopPlayLists top={person.topPlays} />
            ) : (
              <p className="friend-page__empty">No top plays from {name} yet.</p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
