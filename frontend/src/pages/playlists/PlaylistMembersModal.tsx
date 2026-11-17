import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { ModalShell } from "../../components/PlaylistModals.tsx";
import { DotLoader } from "../../components/DotLoader";
import { staticPlaylistsClient } from "../../utils/api/clients/staticPlaylists.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { queryKeys } from "../../queryClient.ts";
import type { StaticPlaylist } from "../../utils/playlistStats.ts";
import { friendPath } from "../../../../lib/profilePaths.ts";

const playlistRoutes = staticPlaylistsClient["static-playlists"][":playlistId"];
const members = playlistRoutes.members;

function PersonName({ username, handle }: { username: string; handle?: string | null }) {
  return (
    <span className="playlist-members__name">
      {username}
      {handle ? (
        <Link className="playlist-members__handle" to={friendPath(handle)}>
          @{handle}
        </Link>
      ) : null}
    </span>
  );
}

export function PlaylistMembersModal({
  playlist,
  userId,
  canManage,
  onChanged,
  onLeave,
  onClose,
}: {
  playlist: StaticPlaylist;
  userId: number | null;
  canManage: boolean;
  onChanged: () => Promise<unknown>;
  onLeave: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const param = { playlistId: encodeURIComponent(playlist.id) };
  const typed = query.trim().replace(/^@/, "").toLowerCase();
  const memberIds = (playlist.members ?? []).map((member) => member.id);
  const found = useQuery({
    queryKey: queryKeys.playlistPeople(playlist.id, memberIds),
    queryFn: ({ signal }) =>
      parseResponse(playlistRoutes.people.$get({ param }, { init: { signal } })),
    enabled: canManage,
    staleTime: 0,
  });
  const suggestions = (found.data?.people ?? []).filter(
    (person) =>
      person.username.toLowerCase().startsWith(typed) ||
      !!person.handle?.toLowerCase().startsWith(typed),
  );
  const enterTarget = typed ? suggestions[0] : undefined;

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await action();
      await onChanged();
      return true;
    } catch (err) {
      setError(getApiErrorMessage(err, "Couldn't update collaborators"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async (username: string) => {
    if (busy) return;
    if (
      await run(`add:${username}`, () =>
        parseResponse(members.$post({ param, json: { username } })),
      )
    ) {
      setQuery("");
    }
  };

  const remove = (memberId: number) =>
    run(`remove:${memberId}`, () =>
      parseResponse(members[":userId"].$delete({ param: { ...param, userId: String(memberId) } })),
    );

  const people = [
    ...(playlist.ownerUserId != null && playlist.ownerUsername
      ? [{ id: playlist.ownerUserId, username: playlist.ownerUsername, handle: null, owner: true }]
      : []),
    ...(playlist.members ?? []).map((member) => ({ ...member, owner: false })),
  ];

  return (
    <ModalShell
      open
      className="playlist-modal--edit"
      title="Collaborators"
      onClose={onClose}
      footer={
        canManage ? null : (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy !== null}
            onClick={onLeave}
          >
            Leave playlist
          </button>
        )
      }
    >
      <div className="playlist-modal__fields">
        {canManage ? (
          <form
            className="playlist-members__find"
            role="search"
            aria-busy={found.isFetching}
            onSubmit={(event) => {
              event.preventDefault();
              if (enterTarget) void add(enterTarget.username);
            }}
          >
            <input
              type="search"
              className="input"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (error) setError("");
              }}
              placeholder="Find people on this server"
              aria-label="Find people on this server"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            {suggestions.length ? (
              <div
                className="playlist-members__suggestions"
                onMouseDown={(event) => event.preventDefault()}
              >
                {suggestions.map((person) => (
                  <button
                    type="button"
                    key={person.id}
                    className={`artist-menu-item${person === enterTarget ? " is-active" : ""}`}
                    disabled={busy !== null}
                    onClick={() => void add(person.username)}
                    aria-label={`Add ${person.username}`}
                  >
                    <PersonName username={person.username} handle={person.handle} />
                    {busy === `add:${person.username}` ? (
                      <DotLoader size="sm" label={null} />
                    ) : (
                      <span className="playlist-members__note">Add</span>
                    )}
                  </button>
                ))}
              </div>
            ) : typed && found.isSuccess ? (
              <p className="playlist-members__hint">No one here matches {query.trim()}.</p>
            ) : found.data?.people.length === 0 ? (
              <p className="playlist-members__hint">No one else here can be added.</p>
            ) : null}
          </form>
        ) : null}
        {error || found.error ? (
          <p className="artist-error-text" role="alert">
            {error || getApiErrorMessage(found.error, "Couldn't load people on this server")}
          </p>
        ) : canManage ? (
          <p className="playlist-members__hint">They can add, remove, and reorder tracks.</p>
        ) : null}
        <ul className="playlist-members__list">
          {people.map((person) => (
            <li key={person.id} className="playlist-members__row">
              <PersonName username={person.username} handle={person.handle} />
              {person.owner ? (
                <span className="playlist-members__note">Owner</span>
              ) : canManage ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy !== null}
                  onClick={() => remove(person.id)}
                  aria-label={`Remove ${person.username}`}
                >
                  Remove
                </button>
              ) : person.id === userId ? (
                <span className="playlist-members__note">You</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </ModalShell>
  );
}
