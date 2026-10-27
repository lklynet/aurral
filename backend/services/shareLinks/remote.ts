import {
  MAX_SHARE_BYTES,
  parseShareManifest,
  parseShareTrack,
} from "../../../lib/shareManifest.ts";
import { SHARE_ORIGIN } from "./store.ts";

export function normalizeShareUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("Enter an Aurral share link or code.");
  const input = value.trim();
  const url = URL.canParse(input) ? new URL(input) : new URL(`/s/${input}`, SHARE_ORIGIN);
  if (
    url.origin !== new URL(SHARE_ORIGIN).origin ||
    url.username ||
    url.password ||
    !/^\/s\/[A-Za-z0-9_.~-]{4,800}$/.test(url.pathname)
  )
    throw new Error("Enter an Aurral share link or code from aurral.org.");
  return `${SHARE_ORIGIN}${url.pathname}`;
}

export async function loadRemoteShare(value: unknown) {
  const url = normalizeShareUrl(value);
  const segment = new URL(url).pathname.slice(3);
  const response = await fetch(
    `${SHARE_ORIGIN}/api/shares/resolve?share=${encodeURIComponent(segment)}`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This share was stopped or could not be found."
        : "Could not load this share. Try again.",
    );
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_SHARE_BYTES * 2) throw new Error("This share is too large.");
  const body: unknown = JSON.parse(raw);
  if (!body || typeof body !== "object" || !("manifest" in body))
    throw new Error("This share is incomplete.");
  const manifest = parseShareManifest(body.manifest);
  if (!manifest) throw new Error("This share is incomplete.");
  const files = "files" in body ? body.files : null;
  const fileInfo =
    files &&
    typeof files === "object" &&
    "base" in files &&
    typeof files.base === "string" &&
    /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/share\/[A-Za-z0-9_-]{22}$/.test(files.base) &&
    "allowDownload" in files &&
    files.allowDownload === true &&
    "tracks" in files &&
    Array.isArray(files.tracks)
      ? {
          base: files.base,
          tracks: files.tracks
            .map((track: unknown) => parseShareTrack(track))
            .filter((track) => track !== null)
            .filter((track) => track.path !== null),
        }
      : null;
  if (!manifest.tracks.length && fileInfo) manifest.tracks = fileInfo.tracks;
  return { url, manifest, files: fileInfo };
}
