import * as v from "valibot";
import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";

const PLAYS_BEFORE_PROMPT = 50;

const countPlaysStmt = db.prepare<[number, number], { plays: number }>(
  "SELECT COUNT(*) AS plays FROM (SELECT 1 FROM play_events WHERE user_id = ? LIMIT ?)",
);

export const claimStarPrompt = (userId: number) => {
  const key = `user:${userId}:starPromptShown`;
  if (dbOps.getJSONSetting(key, v.boolean())) return false;
  if ((countPlaysStmt.get(userId, PLAYS_BEFORE_PROMPT)?.plays ?? 0) < PLAYS_BEFORE_PROMPT)
    return false;
  dbOps.setJSONSetting(key, true);
  return true;
};
