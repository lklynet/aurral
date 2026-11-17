import { IMPORT_PROVIDER_LABELS, isNativeImportProvider } from "../../../lib/importProviders.ts";
import { userOps } from "../../db/helpers/index.ts";
import { hasPermission } from "../auth.ts";
import { withPlaylistMutationLock } from "../downloadJobs/downloadLocks.ts";
import {
  flowPlaylistConfig,
  invalidateFlowPlaylistConfigCache,
  type StaticPlaylist,
} from "./flowPlaylistConfig.ts";

const memberError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

const syncingFrom = (playlist: Pick<StaticPlaylist, "importSource">) => {
  const provider = playlist.importSource?.syncEnabled ? playlist.importSource.provider : null;
  if (!provider) return null;
  return isNativeImportProvider(provider) ? IMPORT_PROVIDER_LABELS[provider] : "another service";
};

export const listPlaylistMembers = (playlist: Pick<StaticPlaylist, "memberUserIds">) =>
  (playlist.memberUserIds ?? []).flatMap((id) => {
    const username = userOps.getUserById(id)?.username;
    return username ? [{ id, username }] : [];
  });

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
    const source = syncingFrom(playlist);
    if (source) {
      throw memberError(`This playlist syncs from ${source}, so it can't have collaborators.`, 409);
    }
    const name = username.trim();
    const user = name ? userOps.getUserByUsername(name) : null;
    if (!user) throw memberError(`No one on this server is called ${name}.`, 404);
    if (user.id === playlist.ownerUserId) {
      throw memberError(`${user.username} owns this playlist.`, 409);
    }
    if (playlist.memberUserIds?.includes(user.id)) {
      throw memberError(`${user.username} is already on this playlist.`, 409);
    }
    if (user.status !== "active" || !hasPermission(user, "accessPlaylists")) {
      throw memberError(`${user.username} can't use playlists on this server.`, 409);
    }
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
