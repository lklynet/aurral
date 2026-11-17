import { IMPORT_PROVIDER_LABELS, isNativeImportProvider } from "../../../lib/importProviders.ts";
import { db } from "../../config/db-sqlite.ts";
import { userOps } from "../../db/helpers/index.ts";
import type { UserRecord } from "../../db/helpers/users.ts";
import { hasPermission } from "../auth.ts";
import { withPlaylistMutationLock } from "../downloadJobs/downloadLocks.ts";
import {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
  type StaticPlaylist,
} from "./flowPlaylistConfig.ts";

const memberError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

const refuseSyncing = (playlist: Pick<StaticPlaylist, "importSource">) => {
  const provider = playlist.importSource?.syncEnabled ? playlist.importSource.provider : null;
  if (!provider) return;
  const source = isNativeImportProvider(provider)
    ? IMPORT_PROVIDER_LABELS[provider]
    : "another service";
  throw memberError(`This playlist syncs from ${source}, so it can't have collaborators.`, 409);
};

const handleStmt = db.prepare<[number], { handle: string | null }>(
  "SELECT handle FROM hub_links WHERE user_id = ? AND linked_at IS NOT NULL AND broken = 0",
);

const peopleStmt = db.prepare<[], { id: number; handle: string | null }>(`
  SELECT users.id, link.handle
  FROM users
  LEFT JOIN hub_links AS link
    ON link.user_id = users.id AND link.linked_at IS NOT NULL AND link.broken = 0
  WHERE users.status = 'active'
  ORDER BY users.username COLLATE NOCASE
`);

export const listPlaylistMembers = (playlist: Pick<StaticPlaylist, "memberUserIds">) =>
  (playlist.memberUserIds ?? []).flatMap((id) => {
    const username = userOps.getUserById(id)?.username;
    return username ? [{ id, username, handle: handleStmt.get(id)?.handle ?? null }] : [];
  });

const cantJoin = (playlist: StaticPlaylist, user: UserRecord) =>
  user.id === playlist.ownerUserId
    ? `${user.username} owns this playlist.`
    : playlist.memberUserIds?.includes(user.id)
      ? `${user.username} is already on this playlist.`
      : user.status !== "active" || !hasPermission(user, "accessPlaylists")
        ? `${user.username} can't use playlists on this server.`
        : null;

export function peopleToAdd(playlist: StaticPlaylist) {
  refuseSyncing(playlist);
  return peopleStmt.all().flatMap(({ id, handle }) => {
    const user = userOps.getUserById(id);
    return user && !cantJoin(playlist, user) ? [{ id, username: user.username, handle }] : [];
  });
}

const editFreshPlaylist = (
  playlistId: string,
  edit: (playlist: StaticPlaylist) => StaticPlaylist | null,
) =>
  withPlaylistMutationLock(playlistId, () => {
    invalidateFlowPlaylistConfigCache();
    const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
    const next = playlist && edit(playlist);
    if (!next) throw memberError("Playlist not found", 404);
    return listPlaylistMembers(next);
  });

export const addStaticPlaylistMember = (playlistId: string, username: string) =>
  editFreshPlaylist(playlistId, (playlist) => {
    refuseSyncing(playlist);
    const name = username.trim();
    const user = name ? userOps.getUserByUsername(name) : null;
    if (!user) throw memberError(`No one on this server is called ${name}.`, 404);
    const refusal = cantJoin(playlist, user);
    if (refusal) throw memberError(refusal, 409);
    return flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
      memberUserIds: [...(playlist.memberUserIds ?? []), user.id],
    });
  });

export const removeStaticPlaylistMember = (playlistId: string, userId: number) =>
  editFreshPlaylist(playlistId, (playlist) =>
    flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
      memberUserIds: (playlist.memberUserIds ?? []).filter((id) => id !== userId),
    }),
  );

export async function releaseDeletedUserFromPlaylists(userId: number) {
  const touches = (playlist: StaticPlaylist) =>
    !!playlist.memberUserIds &&
    (playlist.ownerUserId === userId || playlist.memberUserIds.includes(userId));
  const ids = flowPlaylistConfig
    .getStaticPlaylists()
    .filter(touches)
    .map(({ id }) => id);
  if (!ids.length) return;
  await withPlaylistMutationLock(ids, () => {
    invalidateFlowPlaylistConfigCache();
    for (const playlist of flowPlaylistConfig.getStaticPlaylists().filter(touches)) {
      const members = (playlist.memberUserIds ?? []).filter((id) => id !== userId);
      if (playlist.ownerUserId !== userId) {
        flowPlaylistConfig.updateStaticPlaylist(playlist.id, { memberUserIds: members });
        continue;
      }
      flowPlaylistConfig.updateStaticPlaylist(playlist.id, {
        ownerUserId: members.shift()!,
        memberUserIds: members,
        tracks: playlist.tracks.map((track) => ({
          ...track,
          addedByUserId: track.addedByUserId ?? userId,
        })),
      });
    }
  });
}

export function trackAdders(playlist: StaticPlaylist) {
  const usernames = new Map<number, string | null>();
  const usernameOf = (userId: number) => {
    if (!usernames.has(userId))
      usernames.set(userId, userOps.getUserById(userId)?.username ?? null);
    return usernames.get(userId) ?? null;
  };
  return new Map(
    playlist.tracks.map((track) => {
      const userId = track.addedByUserId ?? playlist.ownerUserId;
      return [track.canonicalJobId, userId == null ? null : usernameOf(userId)] as const;
    }),
  );
}
