import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { db } from "../../config/db-sqlite.js";
import { dbOps } from "../../db/helpers/index.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { downloadDestinationForJob } from "./weeklyFlowDownloadOwnership.js";
import { isPathInsideRoot, resolvePlaylistRoot } from "../playlistPaths.js";
import { joinUnderRoot } from "../playlistDownloadUtils.js";
import { createPlaybackDeletionGuard } from "../playback/playbackFileRetention.js";

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareRetainedPlaylistFile({ jobId, sourcePlaylistId, targetPlaylistId, weeklyFlowRoot = resolvePlaylistRoot() }) {
  const job = downloadTracker.getJob(jobId);
  if (!job?.finalPath || job.status !== "done" || job.externalPath || job.managedBy !== "aurral") return { finalPath: job?.finalPath || null };
  const root = path.resolve(weeklyFlowRoot);
  const key = `playlistMediaRelocation:${jobId}`;
  let intent = dbOps.getJSONSetting(key);
  if (!intent || intent.sourcePlaylistId !== sourcePlaylistId) {
    const from = path.resolve(job.finalPath);
    if (!["_flows", "aurral-weekly-flow", "aurral-playlists"].some((directory) => isPathInsideRoot(from, path.join(root, directory, sourcePlaylistId)))) return { finalPath: job.finalPath };
    const source = await fs.lstat(from);
    if (!source.isFile() || !isPathInsideRoot(await fs.realpath(from), await fs.realpath(root))) {
      throw new Error("Retained media must be a file inside the candidate playlist root");
    }
    const parsed = path.parse(from);
    const destination = downloadDestinationForJob({ ...job, playlistId: targetPlaylistId, playlistType: targetPlaylistId });
    const to = joinUnderRoot(root, destination, `${parsed.name}-${randomUUID()}${parsed.ext}`);
    intent = { sourcePlaylistId, from, to, hash: await digest(from), state: "copying" };
    dbOps.setJSONSetting(key, intent);
  }
  if (!isPathInsideRoot(intent.from, root) || !isPathInsideRoot(intent.to, root)) throw new Error("Retained media is outside the candidate playlist root");
  await fs.mkdir(path.dirname(intent.to), { recursive: true });
  if (!isPathInsideRoot(await fs.realpath(path.dirname(intent.to)), await fs.realpath(root))) {
    throw new Error("Retained media destination is outside the candidate playlist root");
  }
  const target = await fs.lstat(intent.to).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!target) {
    const temporary = `${intent.to}.tmp`;
    await fs.copyFile(intent.from, temporary);
    if (await digest(temporary) !== intent.hash) throw new Error("Retained media copy did not match its source");
    const handle = await fs.open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, intent.to);
    const directory = await fs.open(path.dirname(intent.to), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } else if (!target.isFile() || await digest(intent.to) !== intent.hash) {
    throw new Error("Retained media destination did not match its recorded source");
  }
  return { finalPath: intent.to, key, intent };
}

export function commitRetainedPlaylistRelocationInTransaction(prepared) {
  if (!prepared?.intent) return;
  if (!db.inTransaction) throw new Error("Retained media paths must change inside the membership transaction");
  const { key, intent } = prepared;
  db.prepare("UPDATE playlist_download_jobs SET final_path = ? WHERE status = 'done' AND final_path = ? AND external_path IS NULL").run(intent.to, intent.from);
  dbOps.setJSONSetting(key, { ...intent, state: "paths-committed" });
}

export async function finalizeRetainedPlaylistRelocations(sourcePlaylistId, { weeklyFlowRoot = resolvePlaylistRoot() } = {}) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'playlistMediaRelocation:%'").all();
  const root = path.resolve(weeklyFlowRoot);
  const guard = createPlaybackDeletionGuard({ excludeEntityIds: [sourcePlaylistId], playlistRoot: root });
  for (const row of rows) {
    const intent = JSON.parse(row.value);
    if (intent.sourcePlaylistId !== sourcePlaylistId || intent.state !== "paths-committed") continue;
    if (!isPathInsideRoot(intent.from, root) || !isPathInsideRoot(intent.to, root)) continue;
    if (db.prepare("SELECT 1 FROM playlist_download_jobs WHERE final_path = ? LIMIT 1").get(intent.from)) continue;
    if (!(await guard.canDelete(intent.from))) continue;
    const old = await fs.lstat(intent.from).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (old && (!old.isFile() || !isPathInsideRoot(await fs.realpath(intent.from), await fs.realpath(root)))) continue;
    if (await digest(intent.to) !== intent.hash) throw new Error("Retained media destination changed before cleanup");
    await fs.rm(intent.from, { force: true });
    db.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
  }
}
