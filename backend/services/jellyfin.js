import axios from "../../lib/axiosFetch.js";

const CLIENT_NAME = "Aurral";
const CLIENT_VERSION = "1.0.0";
const JELLYFIN_TIMEOUT_MS = 30_000;

export class JellyfinClient {
  constructor(url, apiKey, userId) {
    this.url = url ? String(url).replace(/\/+$/, "") : null;
    this.apiKey = apiKey || null;
    this.userId = userId ? String(userId).trim() : null;
  }

  isConfigured() {
    return Boolean(this.url && this.apiKey && this.userId);
  }

  headers() {
    return {
      Accept: "application/json",
      Authorization: `MediaBrowser Client="${CLIENT_NAME}", Device="${CLIENT_NAME}", DeviceId="aurral", Version="${CLIENT_VERSION}", Token="${this.apiKey || ""}"`,
    };
  }

  async request(method, endpoint, { params, data } = {}) {
    if (!this.isConfigured()) throw new Error("Jellyfin is not configured");
    const response = await axios({
      method,
      url: `${this.url}${endpoint}`,
      params,
      data,
      headers: this.headers(),
      timeout: JELLYFIN_TIMEOUT_MS,
    });
    return response.data;
  }

  async ping() {
    return this.request("GET", "/System/Info");
  }

  async getUser() {
    return this.request("GET", `/Users/${encodeURIComponent(this.userId)}`);
  }
  async getUsers() {
    return this.request("GET", "/Users");
  }

  async findUserByUsername(username) {
    const wanted = String(username || "").trim().toLowerCase();
    if (!wanted) return null;

    const users = await this.getUsers();
    return (
      users.find(
        (user) =>
          String(user?.Name || "").trim().toLowerCase() === wanted,
      ) || null
    );
  }

  async getAudioItems(userId = this.userId) {
    const items = [];
    const limit = 1_000;
    let startIndex = 0;

    while (true) {
      const page = await this.request("GET", "/Items", {
        params: {
          userId,
          recursive: true,
          includeItemTypes: "Audio",
          fields: "Path,ProviderIds",
          startIndex,
          limit,
          enableTotalRecordCount: true,
        },
      });

      const pageItems = Array.isArray(page?.Items) ? page.Items : [];
      if (!pageItems.length) return items;

      items.push(...pageItems);

      const total = Number(page?.TotalRecordCount);
      if (Number.isFinite(total) && total > 0 && items.length >= total) {
        return items;
      }

      startIndex += pageItems.length;
    }
  }

  async createPlaylist({ name, itemIds, userId = this.userId }) {
    return this.request("POST", "/Playlists", {
      data: {
        Name: name,
        Ids: itemIds,
        UserId: userId,
        MediaType: "Audio",
        IsPublic: false,
      },
    });
  }

  async getPlaylistItems(playlistId, userId = this.userId) {
    const items = [];
    const limit = 200;

    while (true) {
      const page = await this.request(
        "GET",
        `/Playlists/${encodeURIComponent(playlistId)}/Items`,
        { params: { userId, startIndex: items.length, limit, enableImages: false } },
      );
      if (!Array.isArray(page?.Items)) {
        throw new Error("Jellyfin returned an invalid playlist response");
      }
      const total = page.TotalRecordCount;
      const hasTotal = Number.isSafeInteger(total) && total >= 0;
      if (!page.Items.length) {
        if (hasTotal && items.length < total) {
          throw new Error("Jellyfin returned an incomplete playlist");
        }
        return items;
      }
      items.push(...page.Items);
      if (hasTotal && items.length >= total) return items;
    }
  }

  async addPlaylistItems(playlistId, itemIds, userId = this.userId, onBatchAdded = () => {}) {
    const batchSize = 50;
    let start = 0;
    while (start < itemIds.length) {
      const batch = [];
      const seen = new Set();
      // End the batch before a repeat; do not drop it or change its position.
      while (start < itemIds.length && batch.length < batchSize && !seen.has(itemIds[start])) {
        const id = itemIds[start++];
        batch.push(id);
        seen.add(id);
      }
      await this.request(
        "POST",
        `/Playlists/${encodeURIComponent(playlistId)}/Items`,
        { params: { userId, ids: batch.join(",") } },
      );
      await onBatchAdded(batch);
    }
  }

  async removePlaylistItems(playlistId, entryIds) {
    const batchSize = 50;
    for (let start = 0; start < entryIds.length; start += batchSize) {
      await this.request(
        "DELETE",
        `/Playlists/${encodeURIComponent(playlistId)}/Items`,
        { params: { entryIds: entryIds.slice(start, start + batchSize).join(",") } },
      );
    }
  }

  async getPlaylistMetadata(playlistId, userId = this.userId) {
    try {
      return await this.request("GET", `/Items/${encodeURIComponent(playlistId)}`, {
        params: { userId },
      });
    } catch (error) {
      // Before Jellyfin 10.9, the user ID was part of this route's path.
      if (error?.response?.status !== 405) throw error;
      return this.request(
        "GET",
        `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(playlistId)}`,
      );
    }
  }

  async syncPlaylistItems(playlistId, itemIds, {
    userId = this.userId,
    managedItemIds = [],
    onManagedItemsChange = () => {},
  } = {}) {
    const validIds = (ids) => Array.isArray(ids)
      && ids.every((id) => typeof id === "string" && id.length > 0 && id === id.trim());
    if (!validIds(itemIds) || !validIds(managedItemIds)) {
      throw new Error("Jellyfin playlist item IDs must be non-empty strings");
    }
    const counts = (ids) => {
      const result = new Map();
      for (const id of ids) result.set(id, (result.get(id) || 0) + 1);
      return result;
    };
    const read = async () => {
      const entries = await this.getPlaylistItems(playlistId, userId);
      if (!validIds(entries.map((entry) => entry?.Id))) {
        throw new Error("Jellyfin playlist entry is missing Id");
      }
      return entries;
    };
    const desired = counts(itemIds);
    const managed = counts(managedItemIds);
    let lastCheckpoint = managedItemIds;
    const checkpoint = async () => {
      const ids = [...managed].flatMap(([id, count]) => Array(count).fill(id));
      if (ids.length !== lastCheckpoint.length || ids.some((id, index) => id !== lastCheckpoint[index])) {
        await onManagedItemsChange(ids);
        lastCheckpoint = ids;
      }
      return ids;
    };
    let entries = await read();
    let current = counts(entries.map((entry) => entry.Id));
    // Missing ownership history means existing entries belong to Jellyfin.
    // Never acquire ownership of a pre-existing matching track by guessing.
    for (const [id, count] of managed) managed.set(id, Math.min(count, current.get(id) || 0));
    await checkpoint();

    const missing = [];
    const available = new Map(current);
    for (const id of itemIds) {
      if (available.get(id)) available.set(id, available.get(id) - 1);
      else missing.push(id);
    }
    // Add first, without clearing the playlist. Checkpoint confirmed batches so
    // a later failed request or restart cannot turn them into untracked extras.
    await this.addPlaylistItems(playlistId, missing, userId, async (batch) => {
      for (const id of batch) managed.set(id, (managed.get(id) || 0) + 1);
      await checkpoint();
    });
    if (missing.length) {
      entries = await read();
      current = counts(entries.map((entry) => entry.Id));
      for (const [id, count] of managed) managed.set(id, Math.min(count, current.get(id) || 0));
      await checkpoint();
      if ([...desired].some(([id, count]) => (current.get(id) || 0) < count)) {
        throw new Error("Jellyfin playlist addition verification failed");
      }
    }

    const groups = new Map();
    for (const entry of entries) {
      const group = groups.get(entry.PlaylistItemId) || [];
      group.push(entry.Id);
      groups.set(entry.PlaylistItemId, group);
    }
    const removableGroups = new Map();
    for (const [entryId, ids] of groups) {
      const id = ids[0];
      if (typeof entryId !== "string" || !entryId.trim()
        || ids.some((candidate) => candidate !== id)) continue;
      const candidates = removableGroups.get(id) || [];
      candidates.push({ entryId, id, count: ids.length });
      removableGroups.set(id, candidates);
    }
    const removals = [];
    for (const [id, ownedCount] of managed) {
      let surplus = ownedCount - (desired.get(id) || 0);
      if (surplus <= 0) continue;
      // Repeated tracks may share an entry ID. If there are user copies of the
      // same track, leave all copies alone rather than risk deleting theirs.
      if ((current.get(id) || 0) > ownedCount) {
        managed.set(id, ownedCount - surplus);
        continue;
      }
      for (const group of removableGroups.get(id) || []) {
        if (group.count > surplus) continue;
        removals.push(group);
        surplus -= group.count;
      }
      // An inseparable duplicate group must stay; relinquish its surplus.
      if (surplus > 0) managed.set(id, ownedCount - surplus);
    }
    await checkpoint();
    if (removals.length) {
      await this.removePlaylistItems(playlistId, removals.map(({ entryId }) => entryId));
      // Verify before recording a deletion as complete. A failed/partial
      // deletion retains its ownership for the next attempt.
      const remaining = await read();
      const remainingEntryIds = new Set(remaining.map((entry) => entry.PlaylistItemId));
      for (const { entryId, id, count } of removals) {
        if (!remainingEntryIds.has(entryId)) managed.set(id, managed.get(id) - count);
      }
      await checkpoint();
      if (removals.some(({ entryId }) => remainingEntryIds.has(entryId))) {
        throw new Error("Jellyfin playlist removal verification failed");
      }
    }
    return checkpoint();
  }

  async updatePlaylist(playlistId, {
    name, itemIds, userId = this.userId, managedItemIds = [], onManagedItemsChange,
  }) {
    // The playlist metadata endpoint expects a logged-in user, not an API key.
    const endpoint = `/Items/${encodeURIComponent(playlistId)}`;
    const playlist = await this.getPlaylistMetadata(playlistId, userId);
    if (playlist?.Type !== "Playlist" || String(playlist.Id) !== String(playlistId)) {
      throw new Error("Jellyfin returned unexpected playlist metadata");
    }
    if (playlist.Name !== name) {
      await this.request("POST", endpoint, { data: { ...playlist, Name: name } });
      const renamed = await this.getPlaylistMetadata(playlistId, userId);
      if (renamed?.Name !== name) {
        throw new Error("Jellyfin playlist rename verification failed");
      }
    }
    const managed = await this.syncPlaylistItems(playlistId, itemIds, {
      userId, managedItemIds, onManagedItemsChange,
    });

    return { Id: String(playlistId), managedItemIds: managed };
  }

  async deletePlaylist(playlistId, userId = this.userId) {
    return this.request("DELETE", `/Items/${encodeURIComponent(playlistId)}`, {
      params: { userId },
    });
  }

  async scanLibrary() {
    return this.request("POST", "/Library/Refresh");
  }
}
