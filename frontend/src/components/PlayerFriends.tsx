import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { AlertCircle, Plus, Users } from "./icons";
import ArtworkImage from "./ArtworkImage";
import RelativeTime from "./RelativeTime";
import StatePanel from "./StatePanel";
import TooltipButton from "./TooltipButton";
import { ModalShell } from "./PlaylistModals";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { SettingsLink } from "../navigation/settingsRoute";
import { queryKeys } from "../queryClient";
import { hubLinkClient } from "../utils/api/clients/hubLink.ts";
import { peopleClient } from "../utils/api/clients/people.ts";
import { mergeFriendRows } from "./friendRows.ts";
import { friendPath } from "../../../lib/profilePaths.ts";
import { resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { readApiError } from "../utils/api/errors.ts";

const SHARING = "Friends see what you play and your top plays from the last 30 days.";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const LIVE_MS = 60_000;

export function useLocalPeople(enabled = true, live = false) {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.people(user?.id),
    queryFn: ({ signal }) => parseResponse(peopleClient.$get({}, { init: { signal } })),
    staleTime: 0,
    refetchInterval: live ? LIVE_MS : false,
    enabled,
  });
}

export function useFriends(enabled = true, live = false) {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.friends(user?.id),
    queryFn: ({ signal }) => parseResponse(hubLinkClient.friends.$get({}, { init: { signal } })),
    staleTime: 0,
    refetchInterval: live ? LIVE_MS : false,
    enabled,
  });
}

export function useHubLink(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.hubLink(user?.id),
    queryFn: ({ signal }) => parseResponse(hubLinkClient.$get({}, { init: { signal } })),
    enabled,
  });
}

const at = (handle: string) => `@${handle.trim().replace(/^@/, "").toLowerCase()}`;

export function useFriendActions() {
  const { user } = useAuth();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const settle = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.friends(user?.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(user?.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.hubProfiles(user?.id) });
  };
  const add = useMutation({
    mutationFn: (handle: string) =>
      parseResponse(
        hubLinkClient.friends[":handle"].$put({ param: { handle: encodeURIComponent(handle) } }),
      ),
    onSuccess: ({ status }, handle) => {
      showSuccess(
        status === "friends"
          ? `You and ${at(handle)} are friends.`
          : `Sent ${at(handle)} a request.`,
      );
      settle();
    },
    onError: (error) => showError(readApiError(error).error || "Couldn't add that friend."),
  });
  const remove = useMutation({
    mutationFn: ({ handle }: { handle: string; done: string }) =>
      parseResponse(
        hubLinkClient.friends[":handle"].$delete({ param: { handle: encodeURIComponent(handle) } }),
      ),
    onSuccess: (_result, { done }) => {
      showSuccess(done);
      settle();
    },
    onError: (error) => showError(readApiError(error).error || "Couldn't reach aurral.org."),
  });
  return { add, remove, busy: add.isPending || remove.isPending };
}

export const friendArtSrc = (src: string) => resolveAuthenticatedApiAssetUrl(`${src}&w=96`);

export function FriendArt({ src, round = false }: { src?: string | null; round?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className={`player-queue__art${round ? " is-round" : ""}`} aria-hidden="true">
      {src && src !== failedSrc ? (
        <ArtworkImage
          src={friendArtSrc(src)}
          thumbnail={false}
          alt=""
          onError={() => setFailedSrc(src)}
        />
      ) : null}
    </span>
  );
}

function FriendRow({
  title,
  note,
  art,
  local = false,
  time,
}: {
  title: string;
  note?: string;
  art?: ReactNode;
  local?: boolean;
  time?: ReactNode;
}) {
  return (
    <span className="player-queue__now">
      {art ?? (
        <span className="player-queue__art" aria-hidden="true">
          <Users />
        </span>
      )}
      <span className="player-queue__copy">
        {local || time ? (
          <span className="player-friends__name">
            <span className="player-queue__name">{title}</span>
            {local ? <span className="player-friends__local">Local</span> : null}
            {time ? <span className="player-friends__time">{time}</span> : null}
          </span>
        ) : (
          <span className="player-queue__name">{title}</span>
        )}
        {note ? <span className="player-queue__artist">{note}</span> : null}
      </span>
    </span>
  );
}

function HubPanel({
  friends,
  onRetry,
}: {
  friends: ReturnType<typeof useFriends>;
  onRetry: () => void;
}) {
  const data = friends.data;
  if (friends.isError && !data) {
    return (
      <StatePanel
        icon={<AlertCircle />}
        title="Couldn't load friends"
        role="alert"
        onRetry={onRetry}
        retrying={friends.isFetching}
      />
    );
  }
  if (!data) return null;
  return data.state === "off" ? (
    <StatePanel
      icon={<Users />}
      title="Friends are off"
      message="An admin turned off aurral.org accounts on this server."
    />
  ) : (
    <StatePanel
      icon={<Users />}
      title={
        data.state === "broken"
          ? "Your aurral.org link stopped working"
          : "Not linked to aurral.org"
      }
      message={
        data.state === "broken"
          ? "Relink to see your friends."
          : "Link an aurral.org account to add friends and see what they're playing."
      }
    >
      <SettingsLink to="profile" className="btn btn-secondary">
        {data.state === "broken" ? "Relink in Profile" : "Link in Profile"}
      </SettingsLink>
    </StatePanel>
  );
}

function HubFooter({ friends }: { friends: ReturnType<typeof useFriends> }) {
  const state = friends.data?.state;
  if (friends.isError && !friends.data) {
    return <p className="player-friends__hint">{"Couldn't load friends on aurral.org."}</p>;
  }
  if (state === "none") {
    return (
      <p className="player-friends__hint">
        <SettingsLink to="profile">Link aurral.org</SettingsLink> to add friends on other servers.
      </p>
    );
  }
  if (state === "broken") {
    return (
      <p className="player-friends__hint">
        {"Your aurral.org link stopped working. "}
        <SettingsLink to="profile">Relink in Profile</SettingsLink>
      </p>
    );
  }
  return null;
}

export default function PlayerFriends({
  variant,
  onManage,
}: {
  variant: "panel" | "sheet";
  onManage: () => void;
}) {
  const friends = useFriends(true, true);
  const people = useLocalPeople(true, true);
  const className = `player-friends player-friends--${variant}`;
  const linked = friends.data?.state === "linked" ? friends.data : null;
  const rows = mergeFriendRows(people.data?.people ?? [], linked?.friends ?? []);
  const localHint =
    people.isError && !people.data ? (
      <p className="player-friends__hint">{"Couldn't load people on this server."}</p>
    ) : people.data?.sharing === false ? (
      <p className="player-friends__hint">
        {"To see people on this server, turn on "}
        <SettingsLink to="profile">Share listening on this server</SettingsLink>
        {" in Profile."}
      </p>
    ) : null;

  if (people.isPending || (!rows.length && !linked && friends.isPending)) {
    return <div className={className} aria-busy="true" />;
  }
  if (!rows.length && !linked) {
    return (
      <div className={className}>
        <HubPanel
          friends={friends}
          onRetry={() => {
            void friends.refetch();
            void people.refetch();
          }}
        />
        {localHint}
      </div>
    );
  }

  const incoming = linked?.incoming ?? [];
  return (
    <div className={className}>
      {variant === "sheet" ? (
        <div className="player-friends__header">
          <h3 className="player-queue__heading">Friends</h3>
          {linked ? (
            <TooltipButton
              label="Add friends"
              className="btn btn-ghost btn-icon btn-xs"
              onClick={onManage}
            >
              <Plus className="artist-icon-sm" aria-hidden="true" />
            </TooltipButton>
          ) : null}
        </div>
      ) : null}
      {incoming.length ? (
        <button type="button" className="player-friends__requests" onClick={onManage}>
          <FriendRow
            title={plural(incoming.length, "friend request")}
            note={incoming.map((friend) => `@${friend.handle}`).join(", ")}
          />
        </button>
      ) : null}
      {rows.length ? (
        <ul className="player-friends__list">
          {rows.map((row) => {
            const track = row.nowPlaying ?? row.lastPlayed;
            return (
              <li key={row.key}>
                <Link className="player-friends__friend" to={row.to}>
                  <FriendRow
                    title={row.name}
                    local={row.local}
                    note={track ? `${track.title} · ${track.artist}` : undefined}
                    time={
                      !row.nowPlaying && row.lastPlayed ? (
                        <RelativeTime value={row.lastPlayed.at} />
                      ) : undefined
                    }
                    art={<FriendArt src={track?.artworkUrl} />}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : incoming.length ? null : (
        <StatePanel icon={<Users />} title="No friends yet" message={SHARING}>
          <button type="button" className="btn btn-secondary" onClick={onManage}>
            Add friends
          </button>
        </StatePanel>
      )}
      {linked && !linked.sharing ? (
        <p className="player-friends__hint">
          {"Friends can't see what you play. "}
          <SettingsLink to="profile">Share in Profile</SettingsLink>
        </p>
      ) : null}
      <HubFooter friends={friends} />
      {localHint}
    </div>
  );
}

export function FriendsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const friends = useFriends(open);
  const [handle, setHandle] = useState("");
  const { add, remove, busy } = useFriendActions();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (handle.trim()) add.mutate(handle, { onSuccess: () => setHandle("") });
  };
  const lists = friends.data?.state === "linked" ? friends.data : null;
  const profile = (name: string, note?: string) => (
    <Link className="player-friends__friend" to={friendPath(name)} onClick={onClose}>
      <FriendRow title={`@${name}`} note={note} />
    </Link>
  );

  return (
    <ModalShell open={open} title="Friends" description={SHARING} onClose={onClose}>
      <div className="friends-dialog">
        <form className="friends-dialog__add" onSubmit={submit}>
          <input
            type="text"
            className="input"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="@handle"
            aria-label="Friend's handle"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={21}
            autoFocus
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !handle.trim()}>
            Add
          </button>
        </form>
        {friends.isError ? (
          <p className="artist-error-text" role="alert">
            {"Couldn't load friends."}
          </p>
        ) : null}
        {lists?.incoming.length || lists?.outgoing.length ? (
          <section className="friends-dialog__section" aria-label="Requests">
            <h4 className="player-queue__heading">Requests</h4>
            {lists.incoming.map(({ handle: name }) => (
              <div key={name} className="friends-dialog__row">
                {profile(name, "Wants to be friends")}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy}
                  onClick={() => add.mutate(name)}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => remove.mutate({ handle: name, done: `Declined @${name}.` })}
                >
                  Decline
                </button>
              </div>
            ))}
            {lists.outgoing.map(({ handle: name }) => (
              <div key={name} className="friends-dialog__row">
                {profile(name, "Requested")}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() =>
                    remove.mutate({ handle: name, done: `Canceled your request to @${name}.` })
                  }
                >
                  Cancel
                </button>
              </div>
            ))}
          </section>
        ) : null}
        {lists?.friends.length ? (
          <section className="friends-dialog__section" aria-label="Friends">
            <h4 className="player-queue__heading">Friends</h4>
            {lists.friends.map(({ handle: name }) => (
              <div key={name} className="friends-dialog__row">
                {profile(name)}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={busy}
                  onClick={() => remove.mutate({ handle: name, done: `Removed @${name}.` })}
                >
                  Remove
                </button>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </ModalShell>
  );
}
