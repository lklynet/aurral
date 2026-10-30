import * as v from "valibot";
import { dbOps } from "../../db/helpers/index.ts";
import { genreKey } from "../musicGenres.ts";

type UserId = number | string;

const storageKey = (userId: UserId) => `user:${userId}:blockedTags`;

export const getBlockedTags = (userId: UserId | null | undefined) => {
  if (userId == null) return [];
  return (dbOps.getJSONSetting(storageKey(userId), v.array(v.unknown())) ?? []).filter(
    (tag) => typeof tag === "string",
  );
};

const saveBlockedTags = (userId: UserId, tags: string[]) => {
  dbOps.setJSONSetting(storageKey(userId), tags);
  return tags;
};

export const blockTag = (userId: UserId, tag: string) => {
  const name = tag.trim().toLowerCase().replace(/\s+/g, " ");
  const current = getBlockedTags(userId);
  if (!name || current.some((entry) => genreKey(entry) === genreKey(name))) return current;
  return saveBlockedTags(userId, [name, ...current]);
};

export const unblockTag = (userId: UserId, tag: string) =>
  saveBlockedTags(
    userId,
    getBlockedTags(userId).filter((entry) => genreKey(entry) !== genreKey(tag)),
  );

export const getBlockedTagKeys = (userId: UserId | null | undefined) =>
  new Set(getBlockedTags(userId).map(genreKey));

export const hasBlockedTag = (tags: unknown, blocked: ReadonlySet<string>) =>
  blocked.size > 0 && Array.isArray(tags) && tags.some((tag) => blocked.has(genreKey(tag)));

export const withoutBlockedTags = <T>(tags: T[], blocked: ReadonlySet<string>) =>
  blocked.size === 0 ? tags : tags.filter((tag) => !blocked.has(genreKey(tag)));
