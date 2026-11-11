import * as v from "valibot";
import { LOGIN, paths } from "../state.ts";
import { addPathMapping, json, jsonBody, local, until, type Service } from "./service.ts";

const NEWS_SERVER = {
  "Server1.Active": "yes",
  "Server1.Name": "eden",
  "Server1.Host": "nserv",
  "Server1.Port": "6791",
  "Server1.Encryption": "no",
  "Server1.Username": "",
  "Server1.Password": "",
  "Server1.Connections": "4",
  "Category1.Name": "aurral",
  "Category2.Name": "lidarr",
};

const config = v.object({ result: v.array(v.object({ Name: v.string(), Value: v.string() })) });

export const nzbget: Service = {
  containers: ["nserv", "nzbget"],
  needs: ["prowlarr"],
  about: (ports) => `${local(ports.nzbget)}  ${LOGIN.username} / ${LOGIN.password}`,
  async setup({ ports, api }) {
    const rpc = (method: string, params: unknown[] = []) =>
      json(
        `${local(ports.nzbget)}/jsonrpc`,
        jsonBody(
          "POST",
          { method, params },
          {
            authorization: `Basic ${Buffer.from(`${LOGIN.username}:${LOGIN.password}`).toString("base64")}`,
          },
        ),
      );
    const current = v.parse(config, await until("NZBGet to start", () => rpc("loadconfig"))).result;
    const wanted: Record<string, string> = NEWS_SERVER;
    await rpc("saveconfig", [
      [
        ...current.filter((option) => !Object.hasOwn(wanted, option.Name)),
        ...Object.entries(wanted).map(([Name, Value]) => ({ Name, Value })),
      ],
    ]);
    await rpc("reload");
    await until("NZBGet to reload", () => rpc("version"));

    await addPathMapping(api, {
      source: "nzbget",
      remote: "/downloads",
      local: `${paths.downloads}/nzbget`,
    });
    await api.post("/settings", {
      integrations: {
        nzbget: {
          enabled: true,
          url: local(ports.nzbget),
          username: LOGIN.username,
          password: LOGIN.password,
        },
      },
    });
  },
};
