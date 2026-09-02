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

  async updatePlaylist(playlistId, { name, itemIds }) {
    await this.request(
      "POST",
      `/Playlists/${encodeURIComponent(playlistId)}`,
      {
        data: {
          Name: name,
          Ids: itemIds,
          IsPublic: false,
        },
      },
    );

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
