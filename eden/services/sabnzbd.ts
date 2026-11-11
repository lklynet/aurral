import { paths } from "../state.ts";
import { addPathMapping, json, local, until, type Service } from "./service.ts";

export const sabnzbd: Service = {
  containers: ["nserv", "sabnzbd"],
  needs: ["prowlarr"],
  about: (ports) => `${local(ports.sabnzbd)}  no login; the API key is in its settings`,
  async setup({ ports, api, exec }) {
    const base = local(ports.sabnzbd);
    const apiKey = await until(
      "SABnzbd to write its API key",
      async () => /^api_key = (\w+)/m.exec(exec("sabnzbd", "cat", "/config/sabnzbd.ini"))?.[1],
    );
    const call = (params: Record<string, string>) =>
      json(`${base}/api?${new URLSearchParams({ ...params, apikey: apiKey, output: "json" })}`);
    const set = (section: string, keyword: string, values: Record<string, string>) =>
      call({ mode: "set_config", section, keyword, ...values });

    await until("SABnzbd to start", () => call({ mode: "version" }));
    await set("servers", "eden", {
      name: "eden",
      host: "nserv",
      port: "6791",
      connections: "4",
      ssl: "0",
      enable: "1",
    });
    await set("misc", "complete_dir", { value: "/downloads/complete" });
    await set("misc", "download_dir", { value: "/downloads/incomplete" });
    await set("categories", "aurral", { name: "aurral", dir: "aurral" });

    await addPathMapping(api, {
      source: "sabnzbd",
      remote: "/downloads",
      local: `${paths.downloads}/sabnzbd`,
    });
    await api.post("/settings", {
      integrations: { sabnzbd: { enabled: true, url: base, apiKey, category: "aurral" } },
    });
  },
};
