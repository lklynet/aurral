import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../frontend/dist/", import.meta.url));
const user = { id: 1, username: "Preview", role: "admin", permissions: {} };
const tracks = [
  ["Midnight City", "M83", "Hurry Up, We’re Dreaming", "done", 244000],
  ["Intro", "The xx", "xx", "done", 127000],
  ["Dreams", "Fleetwood Mac", "Rumours", "downloading", 257000],
  ["Something About Us", "Daft Punk", "Discovery", "done", 232000],
  ["Teardrop", "Massive Attack", "Mezzanine", "failed", 330000],
  ["Space Song", "Beach House", "Depression Cherry", "pending", 320000],
  ["Everything In Its Right Place", "Radiohead", "Kid A", "blocked", 251000],
  ["Nightcall", "Kavinsky", "OutRun", "done", 258000],
].map(([trackName, artistName, albumName, status, durationMs], i) => ({
  id: `demo-track-${i}`,
  trackName,
  artistName,
  albumName,
  status,
  durationMs,
  playlistType: "night-drive",
  createdAt: Date.now() - i * 1000,
  qualityOwned: true,
  qualityState: "preferred",
  artworkUrl: "/preview-cover.svg",
}));
const playlists = [
  {
    id: "night-drive",
    name: "Night Drive",
    trackCount: tracks.length,
    importSource: {
      provider: "spotify-playlist",
      syncIntervalHours: 24,
      syncEnabled: true,
      keepRemovedTracks: true,
    },
  },
  { id: "weekend", name: "Weekend Mix", trackCount: 3, importSource: null },
].map((p) => ({
  ...p,
  ownerUserId: 1,
  ownerUsername: "Preview",
  showTrackAvailability: true,
  createdAt: Date.now(),
  tracks: [],
}));
const jobsFor = (id) =>
  id === "night-drive"
    ? tracks
    : tracks.slice(0, 3).map((t) => ({ ...t, id: `weekend-${t.id}`, playlistType: "weekend" }));
const statsFor = (jobs) =>
  jobs.reduce(
    (stats, job) => {
      stats[job.status]++;
      stats.total++;
      return stats;
    },
    { total: 0, done: 0, failed: 0, pending: 0, blocked: 0, downloading: 0 },
  );
const json = (res, data, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = url.pathname;
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/health/bootstrap")
        return json(res, {
          status: "ok",
          authRequired: false,
          onboardingRequired: false,
          rootFolderConfigured: true,
          user,
          appVersion: "2.0.0",
          integrations: {},
        });
      if (pathname.startsWith("/api/health")) return json(res, { status: "ok" });
      if (pathname === "/api/playlists/status")
        return json(res, {
          flows: [],
          sharedPlaylists: playlists,
          sharedPlaylistStats: Object.fromEntries(
            playlists.map((p) => [p.id, statsFor(jobsFor(p.id))]),
          ),
          flowStats: {},
          worker: { running: false },
          playlists: {},
          enabled: true,
        });
      if (pathname.startsWith("/api/playlists/jobs/"))
        return json(res, jobsFor(pathname.split("/").at(-1)));
      if (pathname.endsWith("/track-availability") && req.method === "PUT") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const playlist = playlists.find((p) => p.id === pathname.split("/").at(-2));
        playlist.showTrackAvailability = JSON.parse(body).enabled;
        return json(res, { success: true, showTrackAvailability: playlist.showTrackAvailability });
      }
      if (pathname.endsWith("/research") && req.method === "POST") {
        const track = tracks.find((t) => t.id === pathname.split("/").at(-2));
        if (track) {
          track.status = "pending";
          setTimeout(() => {
            track.status = "downloading";
          }, 5000);
          setTimeout(() => {
            track.status = "done";
          }, 12000);
        }
        return json(res, { success: true, queued: true });
      }
      if (pathname === "/api/library/favorites")
        return json(res, { song: [], album: [], artist: [] });
      if (pathname === "/api/notifications" || pathname === "/api/inbox")
        return json(res, { items: [], unreadCount: 0 });
      if (req.method !== "GET")
        return json(res, { error: "This action is unavailable in the sample preview" }, 400);
      return json(res, {});
    }
    if (pathname === "/preview-cover.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      return res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#274c77"/><stop offset="1" stop-color="#8059b5"/></linearGradient></defs><rect width="256" height="256" fill="url(#a)"/><circle cx="175" cy="78" r="42" fill="#f2c9a0"/><path d="M0 220 90 95 145 172 195 130 256 205V256H0" fill="#19263c"/></svg>',
      );
    }
    let target = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (!target.startsWith(root)) {
      res.writeHead(403);
      return res.end();
    }
    if (!path.extname(pathname)) target = path.join(root, "index.html");
    const data = await fs.readFile(target);
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webmanifest": "application/manifest+json",
      ".woff2": "font/woff2",
    };
    res.writeHead(200, {
      "Content-Type": types[path.extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(4173, "127.0.0.1", () =>
  console.log("Playlist availability preview: http://127.0.0.1:4173/playlists"),
);
