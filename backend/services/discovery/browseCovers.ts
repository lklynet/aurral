import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import PQueue from "p-queue";
import { resolveAurralDataDir } from "../../config/data-dir.ts";
import { writePlaylistArtworkBuffer } from "../playlistArtwork.ts";
import {
  renderPickedPlaylistCover,
  type PlaylistArtworkArtist,
} from "../playlistArtworkGenerator.ts";
import { renderPlaylistCover, type PlaylistCoverTemplate } from "../playlistCoverTemplates.ts";
import type { BrowseProvider } from "../../../lib/browsePlaylists.ts";

const COVER_DIR = path.join(resolveAurralDataDir(), "browse-covers");
const MAX_COVERS = 500;

export type BrowseCover = {
  title: string;
  template: PlaylistCoverTemplate;
  artist: PlaylistArtworkArtist | null;
};

const renders = new Map<string, Promise<string>>();
const queue = new PQueue({ concurrency: 2 });

export function browseCoverTemplate(provider: BrowseProvider, id: string): PlaylistCoverTemplate {
  if (provider === "discovery") return "e1";
  if (id.startsWith("daily-")) return "a2";
  if (id.startsWith("radio-") || id.startsWith("artist-")) return "d1";
  return "b3";
}

const coverKey = ({ title, template, artist }: BrowseCover) =>
  createHash("sha256")
    .update(JSON.stringify([template, title, artist?.artistName ?? "", artist?.artistMbid ?? ""]))
    .digest("hex")
    .slice(0, 20);

export const browseCoverUrl = (provider: BrowseProvider, id: string, cover: BrowseCover) =>
  `/api/discover/playlists/${provider}/${encodeURIComponent(id)}/cover?v=${coverKey(cover)}`;

async function pruneCovers() {
  const names = await fs.readdir(COVER_DIR);
  if (names.length <= MAX_COVERS) return;
  const files = await Promise.all(
    names.map(async (name) => {
      const file = path.join(COVER_DIR, name);
      return { file, mtime: (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0 };
    }),
  );
  files.sort((left, right) => left.mtime - right.mtime);
  await Promise.all(
    files.slice(0, files.length - MAX_COVERS).map(({ file }) => fs.unlink(file).catch(() => {})),
  );
}

async function renderCover(cover: BrowseCover, file: string) {
  const { title, template, artist } = cover;
  const buffer = artist
    ? await renderPickedPlaylistCover({
        title,
        artists: [artist],
        pick: { style: "artist", artistKey: artist.artistName.trim().toLowerCase(), template },
      })
    : await renderPlaylistCover({ title, template });
  await fs.mkdir(COVER_DIR, { recursive: true });
  await writePlaylistArtworkBuffer(buffer, file);
  await pruneCovers();
  return file;
}

export async function browseCoverFile(cover: BrowseCover) {
  const key = coverKey(cover);
  const file = path.join(COVER_DIR, `${key}.webp`);
  if (await fs.stat(file).catch(() => null)) return file;
  let render = renders.get(key);
  if (!render) {
    render = queue.add(() => renderCover(cover, file)).finally(() => renders.delete(key));
    renders.set(key, render);
  }
  return render;
}
