import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Real cover art is downloaded once per machine and kept outside the checkout, so a
// fresh Eden, another worktree, or a CI cache hit does not fetch it again.
export const ART_CACHE =
  process.env.EDEN_ART_CACHE || path.join(homedir(), ".cache", "aurral-eden", "art");

export async function cachedArt(url: string) {
  const file = path.join(ART_CACHE, createHash("sha256").update(url).digest("hex"));
  if (existsSync(file)) return readFileSync(file);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const art = Buffer.from(await response.arrayBuffer());
  mkdirSync(ART_CACHE, { recursive: true });
  writeFileSync(file, art);
  return art;
}
