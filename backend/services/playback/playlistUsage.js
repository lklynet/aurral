import path from "node:path";

// Deletion checks must not turn malformed or truncated responses into "unused".
export async function readPlaylistPages(fetchPage) {
  const result = [];
  let previousPage = null;
  for (let page = 0; page < 10_000; page += 1) {
    const { items, total } = await fetchPage(result.length);
    if (!Array.isArray(items) || (total != null && (!Number.isSafeInteger(total) || total < 0))) {
      throw new Error("Invalid playlist usage response");
    }
    if (!items.length) {
      if (total != null && result.length < total) throw new Error("Incomplete playlist usage response");
      return result;
    }
    const signature = JSON.stringify(items);
    if (signature === previousPage) throw new Error("Playlist pagination did not advance");
    previousPage = signature;
    result.push(...items);
    if (total != null && result.length >= total) return result;
  }
  throw new Error("Playlist usage response exceeded the page limit");
}

export function requirePlaylistPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Playlist track has no file path; usage cannot be verified");
  }
  return value.replace(/\\/g, "/");
}

export function localFileKey(value) {
  const resolved = path.resolve(requirePlaylistPath(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isAbsoluteMediaPath(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}
