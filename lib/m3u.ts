export type M3uTrack = {
  artistName: string;
  trackName: string;
  albumName: string | null;
  durationMs: number | null;
};

type EntryInfo = { display?: string; durationMs?: number | null; artist?: string; album?: string };

const TRACK_NUMBER = /^(?:\d{1,2}[-.])?\d{1,3}\s*(?:[-._]\s*|\s+)/;
const EXTENSION = /\.[a-z0-9]{2,5}$/i;

function splitDisplay(display: string) {
  const index = display.indexOf(" - ");
  if (index <= 0) return null;
  const artistName = display.slice(0, index).trim();
  const trackName = display.slice(index + 3).trim();
  return artistName && trackName ? { artistName, trackName } : null;
}

function decodePath(location: string) {
  if (!/^file:/i.test(location)) return location;
  try {
    return decodeURIComponent(location.replace(/^file:\/*/i, "/"));
  } catch {
    return location;
  }
}

function fromPath(location: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location) && !/^file:/i.test(location)) return null;
  const segments = decodePath(location)
    .split(/[\\/]+/)
    .filter(Boolean);
  const base = segments.at(-1)?.replace(EXTENSION, "").trim();
  if (!base) return null;
  const title = base.replace(TRACK_NUMBER, "").trim() || base;
  const artist = segments.length >= 3 ? segments.at(-3) : undefined;
  const album = segments.length >= 3 ? segments.at(-2) : undefined;
  const named = splitDisplay(title);
  if (named && (!artist || named.artistName.toLowerCase() === artist.toLowerCase())) {
    return { ...named, albumName: album ?? null };
  }
  if (artist) return { artistName: artist, trackName: title, albumName: album ?? null };
  return named && { ...named, albumName: null };
}

export function parseM3u(content: string) {
  const tracks: M3uTrack[] = [];
  const seen = new Set<string>();
  let name: string | null = null;
  let info: EntryInfo = {};
  let skipped = 0;
  for (const raw of content.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const extinf = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)[^,]*,(.*)$/i.exec(line);
      if (extinf) {
        const seconds = Number(extinf[1]);
        info = {
          ...info,
          display: (extinf[2] ?? "").trim(),
          durationMs: seconds > 0 ? Math.round(seconds * 1000) : null,
        };
      } else if (/^#PLAYLIST:/i.test(line)) name = line.slice(10).trim() || name;
      else if (/^#EXTART:/i.test(line)) info = { ...info, artist: line.slice(8).trim() };
      else if (/^#EXTALB:/i.test(line)) info = { ...info, album: line.slice(8).trim() };
      continue;
    }
    const path = fromPath(line);
    const display = info.display ? splitDisplay(info.display) : null;
    const artistName = info.artist || display?.artistName || path?.artistName;
    const displayTitle =
      info.artist && display?.artistName.toLowerCase() !== info.artist.toLowerCase()
        ? info.display
        : display?.trackName;
    const trackName = displayTitle || path?.trackName;
    const entry = { durationMs: info.durationMs ?? null, album: info.album };
    info = {};
    if (!artistName || !trackName) {
      skipped += 1;
      continue;
    }
    const key = `${artistName.toLowerCase()}\u0000${trackName.toLowerCase()}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    tracks.push({
      artistName,
      trackName,
      albumName: entry.album || path?.albumName || null,
      durationMs: entry.durationMs,
    });
  }
  return { name, tracks, skipped };
}
