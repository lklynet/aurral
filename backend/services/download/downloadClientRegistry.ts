import * as v from "valibot";
import { assertDownloadClient, type DownloadClient } from "./downloadClient.ts";

const configSchema = v.record(v.string(), v.unknown());

export class DownloadClientRegistry<Client extends DownloadClient> {
  clients: Client[];
  byKey: Map<string, Client>;

  constructor(clients: Client[] = []) {
    if (!Array.isArray(clients)) {
      throw new TypeError("DownloadClientRegistry requires an array");
    }
    const keys = new Set<string>();
    this.clients = clients.map((client) => {
      assertDownloadClient(client);
      for (const property of ["key", "name"] as const) {
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

  updateConfig(integrations: Record<string, unknown> = {}) {
    for (const client of this.clients) {
      const config = integrations[client.key];
      client.updateConfig(v.is(configSchema, config) ? config : {});
    }
  }

  get(key: unknown) {
    return this.byKey.get(String(key || "")) || null;
  }

  getAll() {
    return [...this.clients];
  }

  getConfigured() {
    return this.clients.filter((client) => client.isConfigured());
  }
}
