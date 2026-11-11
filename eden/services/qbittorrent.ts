import { LOGIN, paths } from "../state.ts";
import { addPathMapping, local, until, type Service } from "./service.ts";

const FIRST_RUN_USER = "admin";

export const qbittorrent: Service = {
  containers: ["qbittorrent"],
  needs: ["prowlarr"],
  about: (ports) => `${local(ports.qbittorrent)}  ${LOGIN.username} / ${LOGIN.password}`,
  async setup({ ports, api, logs }) {
    const base = local(ports.qbittorrent);
    const form = (fields: Record<string, string>, cookie = "") =>
      fetch(`${base}/api/v2/${fields.path}`, {
        method: "POST",
        headers: { referer: base, ...(cookie && { cookie }) },
        body: new URLSearchParams(Object.entries(fields).filter(([key]) => key !== "path")),
      });

    // qBittorrent prints a one-time password for its first run and takes no other.
    const cookie = await until("qBittorrent to accept its first-run login", async () => {
      const password = /temporary password is provided for this session: (\S+)/.exec(
        logs("qbittorrent"),
      )?.[1];
      if (!password) return null;
      const response = await form({ path: "auth/login", username: FIRST_RUN_USER, password });
      return response.ok && response.headers.getSetCookie()[0]?.split(";")[0];
    });
    const saved = await form(
      {
        path: "app/setPreferences",
        json: JSON.stringify({
          web_ui_username: LOGIN.username,
          web_ui_password: LOGIN.password,
          save_path: "/downloads",
          dht: false,
          pex: false,
          lsd: false,
          max_ratio_enabled: true,
          max_ratio: 0,
        }),
      },
      cookie,
    );
    if (!saved.ok) throw new Error(`qBittorrent did not save its settings: ${saved.status}`);

    await addPathMapping(api, {
      source: "qbittorrent",
      remote: "/downloads",
      local: `${paths.downloads}/qbittorrent`,
    });
    await api.post("/settings", {
      integrations: {
        qbittorrent: {
          enabled: true,
          url: base,
          username: LOGIN.username,
          password: LOGIN.password,
        },
      },
    });
  },
};
