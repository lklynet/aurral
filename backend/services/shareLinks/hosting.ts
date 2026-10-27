import { getShareInstance, SHARE_ORIGIN } from "./store.ts";
import {
  MAX_SHARE_BYTES,
  getShareCode,
  parseShareManifest,
  withoutShareFiles,
  type ShareManifest,
} from "../../../lib/shareManifest.ts";
import crypto from "node:crypto";

export async function publishShareManifest(
  token: string,
  manifest: ShareManifest | null,
  shareFiles = false,
) {
  const { id, secret } = getShareInstance();
  const response = await fetch(`${SHARE_ORIGIN}/api/shares/${id}/${token}`, {
    method: manifest ? "PUT" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, manifest, shareFiles }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Could not update the share on aurral.org. Try again.");
}

export async function publishDetailsShare(manifest: ShareManifest) {
  const token = crypto.randomBytes(16).toString("base64url");
  await publishShareManifest(token, withoutShareFiles(manifest));
  return { url: `${SHARE_ORIGIN}/s/${getShareCode(token)}`, shareFiles: false, expiresAt: null };
}

export async function createPlainShare(input: unknown) {
  const manifest = parseShareManifest(input);
  if (!manifest || manifest.kind === "playlist")
    throw new Error("Choose a track, album, or artist to share.");
  if (Buffer.byteLength(JSON.stringify(withoutShareFiles(manifest))) > MAX_SHARE_BYTES - 1024)
    throw new Error("This share is too large. Share a smaller selection.");
  return publishDetailsShare(manifest);
}
