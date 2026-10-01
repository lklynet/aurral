import { randomUUID } from "node:crypto";
import path from "node:path";
import { copyInto, includesAllWords, searchWords } from "./runtime.mjs";

const PEER = "lab-peer";



function remoteName(artist, album, index) {
  return `@@lab\\Music\\${artist.name}\\${album.title}\\${String(index + 1).padStart(2, "0")} - ${album.tracks[index]}.flac`;
}

export function createSlskd(catalog, { apiKey, mediaRoot, downloads, tracks }) {
  const downloadsDir = path.join(mediaRoot, "slskd", "downloads");
  const state = { searches: new Map(), transfers: [] };
  const sources = new Map();
  const albums = catalog.artists.flatMap((artist) => artist.albums.map((album) => ({ artist, album })));

  function responsesFor(searchText) {
    const query = new Set(searchWords(searchText));
    const files = [];
    for (const { artist, album } of albums) {
      if (!includesAllWords(query, artist.name)) continue;
      const wholeAlbum = includesAllWords(query, album.title);
      album.tracks.forEach((title, index) => {
        if (!wholeAlbum && !includesAllWords(query, title)) return;
        const source = tracks.file(artist, album, index);
        const filename = remoteName(artist, album, index);
        sources.set(filename, source.path);
        files.push({
          filename,
          size: source.size,
          extension: "flac",
          bitDepth: 16,
          sampleRate: 44100,
          length: 30 + index,
          isLocked: false,
        });
      });
    }
    if (!files.length) return [];
    return [{ username: PEER, fileCount: files.length, lockedFileCount: 0, hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 4_000_000, files }];
  }

  function view(transfer) {
    const { stage, fraction } = downloads.progress(transfer);
    const bytesTransferred = Math.round(transfer.size * fraction);
    return {
      id: transfer.id,
      username: transfer.username,
      direction: "Download",
      filename: transfer.filename,
      size: transfer.size,
      state: transfer.cancelled
        ? "Completed, Cancelled"
        : { queued: "Queued, Remotely", downloading: "InProgress", completed: "Completed, Succeeded" }[stage],
      bytesTransferred,
      bytesRemaining: transfer.size - bytesTransferred,
      percentComplete: Math.round(fraction * 100),
      requestedAt: transfer.requestedAt,
      ...(stage === "completed" ? { endedAt: new Date(transfer.completedAt).toISOString() } : {}),
    };
  }

  const find = (username, id) => state.transfers.find((entry) => entry.username === username && entry.id === id);
  const ok = (body, status = 200, headers) => ({ status, body, headers });
  const remove = (transfer) => {
    downloads.remove(transfer);
    state.transfers = state.transfers.filter((entry) => entry !== transfer);
  };

  const handler = ({ method, url, headers, body }) => {
    if (!url.pathname.startsWith("/api/v0/")) return null;
    if (headers["x-api-key"] !== apiKey) return { status: 401, body: { message: "Unauthorized" } };
    const segments = url.pathname.slice("/api/v0/".length).split("/").map(decodeURIComponent);

    if (method === "GET" && url.pathname === "/api/v0/application") {
      return ok({ server: { state: "Connected, LoggedIn", isConnected: true, isLoggedIn: true }, version: { full: "lab" } });
    }
    if (method === "GET" && url.pathname === "/api/v0/options") {
      return ok({ directories: { downloads: downloadsDir, incomplete: path.join(mediaRoot, "slskd", "incomplete") } });
    }
    if (method === "GET" && url.pathname === "/api/v0/events") return ok([], 200, { "x-total-count": "0" });

    if (segments[0] === "searches") {
      const [, id, part] = segments;
      if (method === "POST" && !id) {
        const searchId = String(body?.id || randomUUID());
        const responses = responsesFor(body?.searchText);
        const now = new Date().toISOString();
        state.searches.set(searchId, {
          id: searchId,
          searchText: String(body?.searchText || ""),
          state: "Completed",
          isComplete: true,
          startedAt: now,
          endedAt: now,
          responseCount: responses.length,
          fileCount: responses.reduce((total, response) => total + response.fileCount, 0),
          lockedFileCount: 0,
          responses,
        });
        const { responses: _responses, ...summary } = state.searches.get(searchId);
        return ok(summary);
      }
      if (method === "GET" && !id) {
        return ok([...state.searches.values()].map(({ responses: _responses, ...summary }) => summary));
      }
      const search = state.searches.get(id);
      if (!search) return { status: 404, body: { message: "Search not found" } };
      if (method === "GET" && part === "responses") return ok(search.responses);
      if (method === "GET" && !part) return ok(search);
      if (method === "DELETE" && !part) {
        state.searches.delete(id);
        return ok(null, 204);
      }
    }

    if (segments[0] === "transfers" && segments[1] === "downloads") {
      const [, , username, id] = segments;
      if (method === "GET" && (!username || !id)) {
        const users = [...new Set(state.transfers.map((transfer) => transfer.username))].filter((user) => !username || user === username);
        const groups = users.map((user) => {
          const files = state.transfers.filter((transfer) => transfer.username === user).map(view);
          const directories = [...new Set(files.map((file) => file.filename.replace(/\\[^\\]*$/, "")))];
          return {
            username: user,
            directories: directories.map((directory) => {
              const directoryFiles = files.filter((file) => file.filename.startsWith(`${directory}\\`));
              return { directory, fileCount: directoryFiles.length, files: directoryFiles };
            }),
          };
        });
        return ok(username ? groups[0] || { username, directories: [] } : groups);
      }
      if (method === "DELETE" && username === "all" && id === "completed") {
        for (const transfer of [...state.transfers]) if (view(transfer).state.startsWith("Completed")) remove(transfer);
        return ok(null, 204);
      }
      if (method === "POST" && username && !id) {
        const requested = Array.isArray(body) ? body : [];
        const enqueued = requested.map((file) => {
          const filename = String(file.filename || "");
          const source = sources.get(filename);
          const local = filename.replace(/\\/g, "/").split("/");
          const transfer = downloads.add({
            id: randomUUID(),
            username,
            filename,
            size: Number(file.size) || 0,
            requestedAt: new Date().toISOString(),
            complete: () => {
              if (source) copyInto(source, path.join(downloadsDir, local.at(-2) || "", local.at(-1)));
            },
          });
          state.transfers.push(transfer);
          return view(transfer);
        });
        return ok({ enqueued, failed: [] }, 201);
      }
      if (username && id) {
        const transfer = find(username, id);
        if (!transfer) return { status: 404, body: { message: "Transfer not found" } };
        if (method === "GET") return ok(view(transfer));
        if (method === "DELETE") {
          if (url.searchParams.get("remove") === "true") remove(transfer);
          else {
            transfer.cancelled = true;
            downloads.remove(transfer);
          }
          return ok(null, 204);
        }
      }
    }
    return null;
  };
  handler.state = state;
  return handler;
}
