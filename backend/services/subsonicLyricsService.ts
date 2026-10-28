import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFile, type ILyricsTag } from "music-metadata";
import type { RequestUser } from "../middleware/requestUser.ts";
import { asAppError } from "../../lib/errors.ts";
import { getSong, resolveStreamPath } from "./subsonicLibraryService.ts";
import { lrclibGetLyrics } from "./apiClients/lrclib.ts";

function textLyrics(text: string | undefined) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  const timed = [];
  let offset = 0;
  for (const line of lines) {
    const offsetTag = /\[offset:([+-]?\d+)\]/i.exec(line);
    if (offsetTag) offset = Number(offsetTag[1]);
    const timestamps = [...line.matchAll(/\[(\d+):([0-5]\d)(?:\.(\d{1,3}))?\]/g)];
    const value = line.replace(/\[(\d+):([0-5]\d)(?:\.(\d{1,3}))?\]/g, "").trim();
    for (const match of timestamps) {
      timed.push({
        start:
          (Number(match[1]) * 60 + Number(match[2])) * 1000 +
          Number((match[3] || "").padEnd(3, "0")),
        value,
      });
    }
  }
  if (timed.length) {
    return { synced: true, offset, line: timed.sort((a, b) => a.start - b.start) };
  }
  const line = lines
    .filter((value) => !/^\s*\[[a-z]+:.*\]\s*$/i.test(value))
    .map((value) => ({ value: value.trim() }));
  while (line.length && !line[0].value) line.shift();
  while (line.length && !line.at(-1)!.value) line.pop();
  return line.length ? { synced: false, line } : null;
}

function embeddedLyrics(tag: ILyricsTag) {
  const synchronized = Array.isArray(tag.syncText) ? tag.syncText : [];
  if (synchronized.length) {
    const synced =
      tag.timeStampFormat === 2 &&
      synchronized.every((entry) => Number.isFinite(entry.timestamp) && entry.timestamp! >= 0);
    const line = synchronized.map((entry) => ({
      ...(synced ? { start: entry.timestamp } : {}),
      value: entry.text,
    }));
    if (synced) line.sort((a, b) => a.start! - b.start!);
    return { synced, line };
  }
  return textLyrics(tag.text);
}

export async function getLyricsBySongId(id: string, user: RequestUser) {
  const song = getSong(id, user);
  const filePath = song && resolveStreamPath(id, user);
  if (!filePath) return [];
  const display = { displayArtist: song.artist, displayTitle: song.title };
  const sidecarPath = path.join(path.dirname(filePath), `${path.parse(filePath).name}.lrc`);
  try {
    const lyrics = textLyrics(await readFile(sidecarPath, "utf8"));
    if (lyrics) return [{ ...display, lang: "und", ...lyrics }];
  } catch (error) {
    const code = asAppError(error)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const embedded = await parseFile(filePath, { skipCovers: true })
    .then((metadata) =>
      (metadata.common.lyrics || []).flatMap((tag) => {
        const lyrics = embeddedLyrics(tag);
        return lyrics ? [{ ...display, lang: tag.language || "und", ...lyrics }] : [];
      }),
    )
    .catch(() => []);
  if (embedded.length) return embedded;
  const online = textLyrics(
    (await lrclibGetLyrics({
      artist: song.artist,
      title: song.title || "",
      album: song.album,
      durationSec: song.duration,
    })) || "",
  );
  return online ? [{ ...display, lang: "und", ...online }] : [];
}
