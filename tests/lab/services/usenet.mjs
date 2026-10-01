import path from "node:path";
import { copyInto, includesAllWords, searchWords } from "./runtime.mjs";

const INDEXER = {
  id: 1,
  name: "Lab Usenet Indexer",
  protocol: "usenet",
  enable: true,
  supportsSearch: true,
  priority: 25,
  capabilities: { categories: [{ id: 3000, name: "Audio" }, { id: 3040, name: "Audio/Lossless" }] },
};



export function createUsenet(catalog, { mediaRoot, downloads, tracks, prowlarrApiKey, sabnzbdApiKey, nzbgetUsername, nzbgetPassword }) {
  const completeDir = path.join(mediaRoot, "usenet", "complete");
  const albums = new Map(catalog.artists.flatMap((artist) => artist.albums.map((album) => [album.id, { artist, album }])));
  const jobs = [];
  let nextNzbgetId = 1;
  let nextSabId = 1;

  const releaseTitle = ({ artist, album }) => `${artist.name} - ${album.title} (${album.date.slice(0, 4)}) [FLAC]`;
  const albumFiles = (entry) => entry.album.tracks.map((_title, index) => tracks.file(entry.artist, entry.album, index));

  function addJob(client, downloadUrl, name) {
    let releaseId = null;
    try {
      releaseId = new URL(downloadUrl).searchParams.get("release");
    } catch {}
    const entry = albums.get(releaseId);
    if (!entry) return null;
    const folder = path.join(completeDir, releaseTitle(entry).replace(/[\\/:*?"<>|]/g, ""));
    const files = albumFiles(entry);
    const job = downloads.add({
      client,
      sabId: `SABnzbd_nzo_lab${nextSabId++}`,
      nzbgetId: nextNzbgetId++,
      name: name || releaseTitle(entry),
      folder,
      size: files.reduce((total, file) => total + file.size, 0),
      complete: () => {
        entry.album.tracks.forEach((title, index) => {
          copyInto(files[index].path, path.join(folder, `${String(index + 1).padStart(2, "0")} - ${title}.flac`));
        });
      },
    });
    jobs.push(job);
    return job;
  }

  const live = (client) => jobs.filter((job) => job.client === client && !job.deleted);
  const stageOf = (job) => downloads.progress(job);

  const prowlarr = ({ method, url, headers }) => {
    if (!url.pathname.startsWith("/api/v1/")) return null;
    if (headers["x-api-key"] !== prowlarrApiKey) return { status: 401, body: { message: "Unauthorized" } };
    if (method === "GET" && url.pathname === "/api/v1/system/status") {
      return { status: 200, body: { appName: "Prowlarr", instanceName: "Aurral Lab Prowlarr", version: "1.0.0.0-lab" } };
    }
    if (method === "GET" && url.pathname === "/api/v1/indexer") return { status: 200, body: [INDEXER] };
    if (method === "GET" && url.pathname === "/api/v1/search") {
      const query = new Set(searchWords(url.searchParams.get("query")));
      const found = [...albums.values()].filter(
        (entry) => includesAllWords(query, entry.artist.name) && (includesAllWords(query, entry.album.title) || query.size === searchWords(entry.artist.name).length),
      );
      return {
        status: 200,
        body: found.map((entry) => {
          const files = albumFiles(entry);
          return {
            guid: `lab-release-${entry.album.id}`,
            title: releaseTitle(entry),
            size: files.reduce((total, file) => total + file.size, 0),
            files: files.length,
            grabs: 12,
            indexerId: INDEXER.id,
            indexer: INDEXER.name,
            publishDate: `${entry.album.date}T00:00:00Z`,
            downloadUrl: `http://fixtures:9696/1/download?release=${entry.album.id}`,
            infoUrl: `http://fixtures:9696/1/info?release=${entry.album.id}`,
            protocol: "usenet",
            categories: [{ id: 3040, name: "Audio/Lossless" }],
          };
        }),
      };
    }
    return null;
  };

  function sabSlot(job) {
    const { stage, fraction } = stageOf(job);
    const mb = job.size / 1_000_000;
    return {
      nzo_id: job.sabId,
      filename: job.name,
      cat: "aurral",
      status: stage === "downloading" ? "Downloading" : "Queued",
      percentage: String(Math.round(fraction * 100)),
      mb: mb.toFixed(2),
      mbleft: (mb * (1 - fraction)).toFixed(2),
    };
  }

  const sabnzbd = ({ method, url }) => {
    if (url.pathname !== "/api" && url.pathname !== "/sabnzbd/api") return null;
    if (method !== "GET") return null;
    const params = url.searchParams;
    if (params.get("apikey") !== sabnzbdApiKey) return { status: 200, body: { status: false, error: "API Key Incorrect" } };
    const mode = params.get("mode");
    const ids = new Set(String(params.get("nzo_ids") || "").split(",").filter(Boolean));
    const ok = (body) => ({ status: 200, body });
    if (mode === "version") return ok({ version: "4.0.0-lab" });
    if (mode === "server_stats") return ok({ total: 0, month: 0, week: 0, day: 0, paused: false, kbpersec: "0" });
    if (mode === "get_config") return ok({ config: { misc: { complete_dir: completeDir, download_dir: path.join(mediaRoot, "usenet", "incomplete") } } });
    if (mode === "addurl") {
      const job = addJob("sabnzbd", params.get("name"), params.get("nzbname"));
      return ok(job ? { status: true, nzo_ids: [job.sabId] } : { status: false, nzo_ids: [] });
    }
    const matching = live("sabnzbd").filter((job) => !ids.size || ids.has(job.sabId));
    if ((mode === "queue" || mode === "history") && params.get("name") === "delete") {
      const target = live("sabnzbd").find((job) => job.sabId === params.get("value"));
      if (target) {
        target.deleted = true;
        downloads.remove(target);
      }
      return ok({ status: Boolean(target) });
    }
    if (mode === "queue") {
      return ok({ queue: { paused: false, slots: matching.filter((job) => stageOf(job).stage !== "completed").map(sabSlot) } });
    }
    if (mode === "history") {
      return ok({
        history: {
          slots: matching
            .filter((job) => stageOf(job).stage === "completed")
            .map((job) => ({ nzo_id: job.sabId, name: job.name, category: "aurral", status: "Completed", storage: job.folder, bytes: job.size })),
        },
      });
    }
    return null;
  };

  function nzbgetResult(method, params) {
    const items = live("nzbget");
    if (method === "version") return "21.0-lab";
    if (method === "status") return { DownloadPaused: false, DownloadRateLo: 0, RemainingSizeMB: 0 };
    if (method === "config") {
      return [
        { Name: "MainDir", Value: path.join(mediaRoot, "usenet") },
        { Name: "DestDir", Value: completeDir },
        { Name: "InterDir", Value: path.join(mediaRoot, "usenet", "incomplete") },
      ];
    }
    if (method === "append") {
      const [name, downloadUrl] = params;
      return addJob("nzbget", downloadUrl, String(name || "").replace(/\.nzb$/i, ""))?.nzbgetId ?? 0;
    }
    if (method === "listgroups") {
      return items
        .filter((job) => stageOf(job).stage !== "completed")
        .map((job) => {
          const { stage, fraction } = stageOf(job);
          const sizeMb = Math.round(job.size / 1_000_000);
          return {
            NZBID: job.nzbgetId,
            NZBName: job.name,
            Category: "aurral",
            Status: stage === "downloading" ? "DOWNLOADING" : "QUEUED",
            FileSizeMB: sizeMb,
            RemainingSizeMB: Math.round(sizeMb * (1 - fraction)),
          };
        });
    }
    if (method === "history") {
      return items
        .filter((job) => stageOf(job).stage === "completed")
        .map((job) => ({ NZBID: job.nzbgetId, Name: job.name, Category: "aurral", Status: "SUCCESS/ALL", DestDir: job.folder, FinalDir: "" }));
    }
    if (method === "editqueue") {
      const [, , ids] = params;
      const targets = items.filter((job) => (ids || []).includes(job.nzbgetId));
      for (const job of targets) {
        job.deleted = true;
        downloads.remove(job);
      }
      return targets.length > 0;
    }
    return undefined;
  }

  const nzbget = ({ method, url, headers, body }) => {
    if (method !== "POST" || !/\/jsonrpc$/.test(url.pathname)) return null;
    const expected = `Basic ${Buffer.from(`${nzbgetUsername}:${nzbgetPassword}`).toString("base64")}`;
    if (headers.authorization !== expected) return { status: 401, body: { error: "Unauthorized" } };
    const result = nzbgetResult(body?.method, Array.isArray(body?.params) ? body.params : []);
    if (result === undefined) return null;
    return { status: 200, body: { version: "1.1", id: body?.id ?? null, result } };
  };

  return { prowlarr, sabnzbd, nzbget, jobs };
}
