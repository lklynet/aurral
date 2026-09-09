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

  async addPlaylistItems(playlistId, itemIds, userId = this.userId) {
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

  async replacePlaylistItems(playlistId, itemIds, userId = this.userId) {
    if (!Array.isArray(itemIds) || itemIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("Jellyfin playlist item IDs must be non-empty strings");
    }
    const desiredIds = itemIds.map((id) => id.trim());
    const readIds = (items, key) => items.map((item) => {
      const id = item?.[key];
      if (typeof id !== "string" || !id.trim()) {
        throw new Error(`Jellyfin playlist entry is missing ${key}`);
      }
      return id.trim();
    });
    const sameIds = (left, right) =>
      left.length === right.length && left.every((id, index) => id === right[index]);

    const original = await this.getPlaylistItems(playlistId, userId);
    const originalIds = readIds(original, "Id");
    if (sameIds(originalIds, desiredIds)) return;
    readIds(original, "PlaylistItemId");

    const replace = async (entries, ids) => {
      // Remove first: Jellyfin can reuse entry IDs for repeated tracks.
      await this.removePlaylistItems(playlistId, readIds(entries, "PlaylistItemId"));
      await this.addPlaylistItems(playlistId, ids, userId);
      const actual = await this.getPlaylistItems(playlistId, userId);
      if (!sameIds(readIds(actual, "Id"), ids)) {
        throw new Error("Jellyfin playlist verification failed");
      }
    };

    try {
      await replace(original, desiredIds);
    } catch (error) {
      try {
        const current = await this.getPlaylistItems(playlistId, userId);
        await replace(current, originalIds);
      } catch (restoreError) {
        throw new Error(
          `Jellyfin playlist update failed: ${error.message}. Restoring previous contents also failed: ${restoreError.message}`,
          { cause: error },
        );
      }
      throw new Error(
        `Jellyfin playlist update failed; previous contents restored: ${error.message}`,
        { cause: error },
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

  async updatePlaylist(playlistId, { name, itemIds, userId = this.userId }) {
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
    await this.replacePlaylistItems(playlistId, itemIds, userId);

    return { Id: String(playlistId) };
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
