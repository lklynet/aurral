const REQUIRED_METHODS = ["isConfigured", "testConnection", "getStatus", "updateConfig"];

export interface DownloadClient {
  key: string;
  name: string;
  isConfigured(): boolean;
  testConnection(options: { force: boolean }): unknown;
  getStatus(): unknown;
  updateConfig(config: Record<string, unknown> | null): void;
}

export function assertDownloadClient<Client>(client: Client) {
  if (!client || (typeof client !== "object" && typeof client !== "function")) {
    throw new TypeError("DownloadClient must be an object");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof Reflect.get(client, method) !== "function") {
      throw new TypeError(`DownloadClient.${method} must be a function`);
    }
  }
  return client;
}
