import { useState } from "react";
import { parseResponse } from "hono/client";
import { ModalShell } from "../../components/PlaylistModals.tsx";
import { DotLoader } from "../../components/DotLoader";
import { staticPlaylistsClient } from "../../utils/api/clients/staticPlaylists.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import type { StaticPlaylist } from "../../utils/playlistStats.ts";

const members = staticPlaylistsClient["static-playlists"][":playlistId"].members;

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
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const param = { playlistId: encodeURIComponent(playlist.id) };

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

  const add = async () => {
    const name = username.trim();
    if (!name || busy) return;
    if (await run("add", () => parseResponse(members.$post({ param, json: { username: name } })))) {
      setUsername("");
    }
  };

  const remove = (memberId: number) =>
    run(`remove:${memberId}`, () =>
      parseResponse(members[":userId"].$delete({ param: { ...param, userId: String(memberId) } })),
    );

  const people = [
    ...(playlist.ownerUserId != null && playlist.ownerUsername
      ? [{ id: playlist.ownerUserId, username: playlist.ownerUsername, owner: true }]
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
            className="playlist-members__add"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <input
              type="text"
              className="input"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
                if (error) setError("");
              }}
              placeholder="Username"
              aria-label="Username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
            <button type="submit" className="btn btn-primary" disabled={!username.trim() || !!busy}>
              {busy === "add" ? <DotLoader size="sm" label={null} /> : null}
              Add
            </button>
          </form>
        ) : null}
        {error ? (
          <p className="artist-error-text" role="alert">
            {error}
          </p>
        ) : canManage ? (
          <p className="playlist-members__hint">They can add, remove, and reorder tracks.</p>
        ) : null}
        <ul className="playlist-members__list">
          {people.map((person) => (
            <li key={person.id} className="playlist-members__row">
              <span className="playlist-members__name">{person.username}</span>
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
