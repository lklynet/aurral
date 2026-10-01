import path from "node:path";
import { copyInto, includesAllWords, numericId, searchWords, trackDurationSeconds } from "./runtime.mjs";

export function deezerIds(artist, album, index) {
  return {
    artistId: numericId(`deezer-artist:${artist.id}`),
    albumId: album && numericId(`deezer-album:${album.id}`),
    trackId: album && index != null && numericId(`deezer-track:${album.id}:${index}`),
  };
}

export function createDeemix(catalog, { mediaRoot, downloads, tracks }) {
  const downloadDir = path.join(mediaRoot, "deemix");
  const entries = catalog.artists.flatMap((artist) =>
    artist.albums.flatMap((album) => album.tracks.map((title, index) => ({ artist, album, title, index, ...deezerIds(artist, album, index) }))));
  const queue = new Map();
  const order = [];

  const trackJson = (entry) => ({
    id: entry.trackId,
    readable: true,
    title: entry.title,
    duration: trackDurationSeconds(entry.index),
    link: `https://www.deezer.com/track/${entry.trackId}`,
    artist: { id: entry.artistId, name: entry.artist.name },
    album: { id: entry.albumId, title: entry.album.title, link: `https://www.deezer.com/album/${entry.albumId}` },
  });

  function addToQueue(link, bitrate) {
    const match = /\/(track|album)\/(\d+)/.exec(String(link || ""));
    if (!match) return null;
    const [, type, idText] = match;
    const id = Number(idText);
    const items = entries.filter((entry) => (type === "album" ? entry.albumId === id : entry.trackId === id));
    if (!items.length) return null;
    const uuid = `${type}_${id}_${bitrate}`;
    if (queue.has(uuid)) return queue.get(uuid);
    const folder = path.join(downloadDir, `${items[0].artist.name} - ${items[0].album.title}`);
    const files = [];
    const job = downloads.add({
      uuid,
      type,
      title: type === "album" ? items[0].album.title : items[0].title,
      artist: items[0].artist.name,
      size: items.length,
      complete: () => {
        for (const entry of items) {
          const source = tracks.file(entry.artist, entry.album, entry.index);
          files.push({ path: copyInto(source.path, path.join(folder, `${String(entry.index + 1).padStart(2, "0")} - ${entry.title}.flac`)) });
        }
      },
    });
    job.files = files;
    queue.set(uuid, job);
    order.push(uuid);
    return job;
  }

  function queueJson(job) {
    const { stage, fraction } = downloads.progress(job);
    return {
      uuid: job.uuid,
      type: job.type,
      title: job.title,
      artist: job.artist,
      size: job.size,
      downloaded: stage === "completed" ? job.size : Math.floor(job.size * fraction),
      failed: 0,
      progress: Math.round(fraction * 100),
      status: { queued: "inQueue", downloading: "downloading", completed: "completed" }[stage],
      files: stage === "completed" ? job.files : [],
      errors: [],
    };
  }

  return ({ method, url, body }) => {
    const ok = (data, headers) => ({ status: 200, body: data, headers });
    if (method === "GET" && url.pathname === "/api/connect") {
      return ok(
        {
          autologin: false,
          deezerAvailable: true,
          currentUser: { id: 1, name: "Lab Deezer User", can_stream_lossless: true, can_stream_hq: true },
          singleUser: { arl: "" },
          update: { deemixVersion: "lab" },
        },
        { "set-cookie": "connect.sid=aurral-lab; Path=/; HttpOnly" },
      );
    }
    if (method === "POST" && url.pathname === "/api/loginArl") return ok({ status: 1 });
    if (method === "GET" && url.pathname === "/api/search") {
      const query = new Set(searchWords(url.searchParams.get("term")));
      const found = entries.filter((entry) => includesAllWords(query, entry.title) && includesAllWords(query, entry.artist.name));
      const limit = Number(url.searchParams.get("nb")) || 25;
      return ok({ data: found.slice(0, limit).map(trackJson), total: found.length });
    }
    if (method === "POST" && url.pathname === "/api/addToQueue") {
      const job = addToQueue(body?.url, body?.bitrate ?? 9);
      if (!job) return ok({ result: false, errid: "NotFound" });
      return ok({ result: true, data: { obj: { uuid: job.uuid, type: job.type, title: job.title } } });
    }
    if (method === "GET" && url.pathname === "/api/getQueue") {
      return ok({ queue: Object.fromEntries([...queue.values()].map((job) => [job.uuid, queueJson(job)])), queueOrder: order });
    }
    if (method === "POST" && url.pathname === "/api/removeFromQueue") {
      const uuid = url.searchParams.get("uuid") || body?.uuid;
      const job = queue.get(uuid);
      if (job) downloads.remove(job);
      queue.delete(uuid);
      order.splice(order.indexOf(uuid), order.includes(uuid) ? 1 : 0);
      return ok({ result: true });
    }
    return null;
  };
}
