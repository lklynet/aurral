import { assertDownloadClient } from "./downloadClient.js";

export class DownloadClientRegistry {
  constructor(clients = []) {
    if (!Array.isArray(clients)) {
      throw new TypeError("DownloadClientRegistry requires an array");
    }
    const keys = new Set();
    this.clients = clients.map((client) => {
      assertDownloadClient(client);
      for (const property of ["key", "name"]) {
        if (typeof client[property] !== "string" || !client[property].trim()) {
          throw new TypeError(`DownloadClient.${property} must be a non-empty string`);
        }
      }
      if (keys.has(client.key)) {
        throw new TypeError(`DownloadClient.key must be unique: ${client.key}`);
      }
      keys.add(client.key);
      return client;
    });
    this.byKey = new Map(this.clients.map((client) => [client.key, client]));
  }

  updateConfig(integrations = {}) {
    for (const client of this.clients) {
      client.updateConfig(integrations[client.key] || {});
    }
  }

  get(key) {
    return this.byKey.get(String(key || "")) || null;
  }

  getAll() {
    return [...this.clients];
  }

  getConfigured() {
    return this.clients.filter((client) => client.isConfigured());
  }
}
