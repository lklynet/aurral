import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useParams } from "react-router";
import { AlertCircle, Users } from "../components/icons";
import StatePanel from "../components/StatePanel";
import { FriendButton } from "../components/FriendButton";
import { useFriends, useLocalPeople } from "../components/PlayerFriends";
import { useAuth } from "../contexts/AuthContext";
import { queryKeys } from "../queryClient";
import { peopleClient } from "../utils/api/clients/people.ts";
import { readApiError } from "../utils/api/errors.ts";
import { BLEND_MIX_PREFIX } from "../../../lib/browsePlaylists.ts";
import {
  hasTopPlays,
  ProfileNotes,
  ProfilePage,
  ProfilePlaylists,
  TopPlayLists,
} from "./FriendPage";

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
  const listed = people.data?.people.find((each) => each.id === person?.id);
  const friends = useFriends(!!listed?.handle, true);
  const hubFriend =
    friends.data?.state === "linked"
      ? friends.data.friends.find((friend) => friend.handle === listed?.handle)
      : null;
  const listener = listed?.nowPlaying || !hubFriend?.nowPlaying ? listed : hubFriend;
  const playlists = person?.playlists ?? [];
  const self = !!person && person.id === user?.id;
  const hasBlend = playlists.some((playlist) => playlist.id.startsWith(BLEND_MIX_PREFIX));
  const note = !person
    ? null
    : self
      ? people.data?.sharing === false
        ? "People on this server don't see your listening. Share it in Profile."
        : null
      : !playlists.length
        ? `Playlists from ${name}'s listening fill in once they play a few more tracks.`
        : !hasBlend
          ? `Your Blend with ${name} fills in once you both play a few more tracks.`
          : playlists.length === 1
            ? `${name}'s tracks fills in once they play a few more tracks.`
            : null;

  return (
    <ProfilePage
      title={name}
      action={listed?.handle ? <FriendButton handle={listed.handle} local /> : null}
      listener={listener}
      top={person?.topPlays}
      busy={profile.isPending}
    >
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
          <ProfilePlaylists title="Playlists" name={name} playlists={playlists} />
          <ProfileNotes
            notes={[note, !hasTopPlays(person.topPlays) && `No top plays from ${name} yet.`]}
          />
          {hasTopPlays(person.topPlays) ? (
            <TopPlayLists id={`local:${person.username}`} name={name} top={person.topPlays} />
          ) : null}
        </>
      ) : null}
    </ProfilePage>
  );
}
