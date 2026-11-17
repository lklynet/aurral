import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { AlertCircle, Plus, Users } from "./icons";
import ArtworkImage from "./ArtworkImage";
import StatePanel from "./StatePanel";
import TooltipButton from "./TooltipButton";
import { ModalShell } from "./PlaylistModals";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { SettingsLink } from "../navigation/settingsRoute";
import { queryKeys } from "../queryClient";
import { hubLinkClient } from "../utils/api/clients/hubLink.ts";
import { resolveAuthenticatedApiAssetUrl } from "../utils/api/core.ts";
import { readApiError } from "../utils/api/errors.ts";

const SHARING = "Friends see what you're playing and your top plays from the last 30 days.";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const LIVE_MS = 60_000;

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

export const friendPath = (handle: string) => `/friends/${encodeURIComponent(handle)}`;

export function FriendArt({ src, round = false }: { src?: string | null; round?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className={`player-queue__art${round ? " is-round" : ""}`} aria-hidden="true">
      {src && src !== failedSrc ? (
        <ArtworkImage
          src={resolveAuthenticatedApiAssetUrl(`${src}&w=96`)}
          thumbnail={false}
          alt=""
          onError={() => setFailedSrc(src)}
        />
      ) : null}
    </span>
  );
}

function FriendRow({ title, note, art }: { title: string; note?: string; art?: ReactNode }) {
  return (
    <span className="player-queue__now">
      {art ?? (
        <span className="player-queue__art" aria-hidden="true">
          <Users />
        </span>
      )}
      <span className="player-queue__copy">
        <span className="player-queue__name">{title}</span>
        {note ? <span className="player-queue__artist">{note}</span> : null}
      </span>
    </span>
  );
}

export default function PlayerFriends({
  variant,
  onManage,
}: {
  variant: "panel" | "sheet";
  onManage: () => void;
}) {
  const friends = useFriends(true, true);
  const className = `player-friends player-friends--${variant}`;
  const data = friends.data;

  if (friends.isError && !data) {
    return (
      <div className={className}>
        <StatePanel
          icon={<AlertCircle />}
          title="Couldn't load friends"
          role="alert"
          onRetry={() => friends.refetch()}
          retrying={friends.isFetching}
        />
      </div>
    );
  }
  if (!data) return <div className={className} aria-busy="true" />;
  if (data.state === "off") {
    return (
      <div className={className}>
        <StatePanel
          icon={<Users />}
          title="Friends are off"
          message="An admin turned off aurral.org accounts on this server."
        />
      </div>
    );
  }
  if (data.state !== "linked") {
    return (
      <div className={className}>
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
      </div>
    );
  }

  const { incoming, friends: list, sharing } = data;
  const sorted = [...list].sort(
    (a, b) => Number(Boolean(b.nowPlaying)) - Number(Boolean(a.nowPlaying)),
  );
  return (
    <div className={className}>
      {variant === "sheet" ? (
        <div className="player-friends__header">
          <h3 className="player-queue__heading">Friends</h3>
          <TooltipButton
            label="Add friends"
            className="btn btn-ghost btn-icon btn-xs"
            onClick={onManage}
          >
            <Plus className="artist-icon-sm" aria-hidden="true" />
          </TooltipButton>
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
      {sorted.length ? (
        <ul className="player-friends__list">
          {sorted.map(({ handle, nowPlaying }) => (
            <li key={handle}>
              <Link className="player-friends__friend" to={friendPath(handle)}>
                <FriendRow
                  title={`@${handle}`}
                  note={nowPlaying ? `${nowPlaying.title} · ${nowPlaying.artist}` : undefined}
                  art={<FriendArt src={nowPlaying?.artworkUrl} />}
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : incoming.length ? null : (
        <StatePanel icon={<Users />} title="No friends yet" message={SHARING}>
          <button type="button" className="btn btn-secondary" onClick={onManage}>
            Add friends
          </button>
        </StatePanel>
      )}
      {sharing ? null : (
        <p className="player-friends__hint">
          {"Friends can't see what you play. "}
          <SettingsLink to="profile">Share in Profile</SettingsLink>
        </p>
      )}
    </div>
  );
}

export function FriendsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { showError, showSuccess } = useToast();
  const queryClient = useQueryClient();
  const friends = useFriends(open);
  const [handle, setHandle] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.friends(user?.id) });
  const add = useMutation({
    mutationFn: (next: string) =>
      parseResponse(
        hubLinkClient.friends[":handle"].$put({ param: { handle: encodeURIComponent(next) } }),
      ),
    onSuccess: ({ status }, next) => {
      const name = `@${next.trim().replace(/^@/, "").toLowerCase()}`;
      showSuccess(
        status === "friends" ? `You and ${name} are friends.` : `Sent ${name} a request.`,
      );
      setHandle("");
      void refresh();
    },
    onError: (error) => showError(readApiError(error).error || "Couldn't add that friend."),
  });
  const remove = useMutation({
    mutationFn: ({ handle: target }: { handle: string; done: string }) =>
      parseResponse(
        hubLinkClient.friends[":handle"].$delete({ param: { handle: encodeURIComponent(target) } }),
      ),
    onSuccess: (_result, { done }) => {
      showSuccess(done);
      void refresh();
    },
    onError: (error) => showError(readApiError(error).error || "Couldn't reach aurral.org."),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (handle.trim()) add.mutate(handle);
  };
  const lists = friends.data?.state === "linked" ? friends.data : null;
  const busy = add.isPending || remove.isPending;

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
                <FriendRow title={`@${name}`} note="Wants to be friends" />
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
                <FriendRow title={`@${name}`} note="Requested" />
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
                <FriendRow title={`@${name}`} />
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
