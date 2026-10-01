import { randomUUID } from "node:crypto";

const PEER = "lab-peer";

function words(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function includesAll(query, text) {
  const wanted = words(text);
  return wanted.length > 0 && wanted.every((word) => query.has(word));
}

export function createSlskd(catalog, { apiKey }) {
  const state = { searches: new Map(), transfers: [] };
  const albums = catalog.artists.flatMap((artist) => artist.albums.map((album) => ({ artist, album })));

  function responsesFor(searchText) {
    const query = new Set(words(searchText));
    const files = [];
    for (const { artist, album } of albums) {
      if (!includesAll(query, artist.name)) continue;
      const wholeAlbum = includesAll(query, album.title);
      album.tracks.forEach((title, index) => {
        if (!wholeAlbum && !includesAll(query, title)) return;
        files.push({
          filename: `@@lab\\Music\\${artist.name}\\${album.title}\\${String(index + 1).padStart(2, "0")} - ${title}.flac`,
          size: 20_000_000 + index * 1000,
          extension: "flac",
          bitDepth: 16,
          sampleRate: 44100,
          length: 180 + index,
          isLocked: false,
        });
      });
    }
    if (!files.length) return [];
    return [{ username: PEER, fileCount: files.length, lockedFileCount: 0, hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 4_000_000, files }];
  }

  const findTransfer = (username, id) => state.transfers.find((entry) => entry.username === username && entry.id === id);
  const ok = (body, status = 200, headers) => ({ status, body, headers });

  const handler = ({ method, url, headers, body }) => {
    if (!url.pathname.startsWith("/api/v0/")) return null;
    if (headers["x-api-key"] !== apiKey) return { status: 401, body: { message: "Unauthorized" } };
    const segments = url.pathname.slice("/api/v0/".length).split("/").map(decodeURIComponent);

    if (method === "GET" && url.pathname === "/api/v0/application") {
      return ok({ server: { state: "Connected, LoggedIn", isConnected: true, isLoggedIn: true }, version: { full: "lab" } });
    }
    if (method === "GET" && url.pathname === "/api/v0/options") {
      return ok({ directories: { downloads: "/data/slskd/downloads", incomplete: "/data/slskd/incomplete" } });
    }
    if (method === "GET" && url.pathname === "/api/v0/events") return ok([], 200, { "x-total-count": "0" });

    if (segments[0] === "searches") {
      const [, id, part] = segments;
      if (method === "POST" && !id) {
        const searchId = String(body?.id || randomUUID());
        const responses = responsesFor(body?.searchText);
        state.searches.set(searchId, {
          id: searchId,
          searchText: String(body?.searchText || ""),
          state: "Completed",
          isComplete: true,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
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
      if (method === "GET" && !username) {
        const users = [...new Set(state.transfers.map((transfer) => transfer.username))];
        return ok(users.map((user) => {
          const files = state.transfers.filter((transfer) => transfer.username === user);
          const directories = [...new Set(files.map((file) => file.filename.replace(/\\[^\\]*$/, "")))];
          return {
            username: user,
            directories: directories.map((directory) => {
              const directoryFiles = files.filter((file) => file.filename.startsWith(`${directory}\\`));
              return { directory, fileCount: directoryFiles.length, files: directoryFiles };
            }),
          };
        }));
      }
      if (method === "DELETE" && username === "all" && id === "completed") {
        state.transfers = state.transfers.filter((transfer) => !transfer.state.startsWith("Completed"));
        return ok(null, 204);
      }
      if (method === "POST" && username && !id) {
        const requested = Array.isArray(body) ? body : [];
        const enqueued = requested.map((file) => ({
          id: randomUUID(),
          username,
          direction: "Download",
          filename: String(file.filename || ""),
          size: Number(file.size) || 0,
          state: "Queued, Remotely",
          bytesTransferred: 0,
          bytesRemaining: Number(file.size) || 0,
          percentComplete: 0,
          requestedAt: new Date().toISOString(),
          enqueuedAt: new Date().toISOString(),
        }));
        state.transfers.push(...enqueued);
        return ok({ enqueued, failed: [] }, 201);
      }
      if (username && id) {
        const transfer = findTransfer(username, id);
        if (!transfer) return { status: 404, body: { message: "Transfer not found" } };
        if (method === "GET") return ok(transfer);
        if (method === "DELETE") {
          if (url.searchParams.get("remove") === "true") state.transfers = state.transfers.filter((entry) => entry !== transfer);
          else transfer.state = "Completed, Cancelled";
          return ok(null, 204);
        }
      }
    }
    return null;
  };
  handler.state = state;
  return handler;
}
