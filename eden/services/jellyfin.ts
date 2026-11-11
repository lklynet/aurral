import * as v from "valibot";
import { LOGIN, paths } from "../state.ts";
import { json, jsonBody, local, until, type Service } from "./service.ts";

const PLAYBACK_REPORTING = {
  name: "Playback Reporting",
  guid: "5c53438191a343cb907a35aa02eb9d2c",
  version: "19.0.0.0",
};
const API_KEY_NAME = "Aurral";
const PLAYS = 12;

const client = (token = "") =>
  `MediaBrowser Client="Eden", Device="Eden", DeviceId="eden", Version="1"${token ? `, Token="${token}"` : ""}`;

const session = v.looseObject({ AccessToken: v.string(), User: v.looseObject({ Id: v.string() }) });
const keys = v.looseObject({
  Items: v.array(v.looseObject({ AccessToken: v.string(), AppName: v.string() })),
});
const items = v.looseObject({
  Items: v.array(v.looseObject({ Id: v.string(), RunTimeTicks: v.optional(v.number(), 0) })),
});
const plugins = v.array(v.looseObject({ Name: v.string(), Status: v.optional(v.string()) }));

export const jellyfin: Service = {
  containers: ["jellyfin"],
  about: (ports) => `${local(ports.jellyfin)}  ${LOGIN.username} / ${LOGIN.password}`,
  async setup({ ports, api, restart }) {
    const base = local(ports.jellyfin);
    const ready = () =>
      until("Jellyfin to start", () => json(`${base}/System/Info/Public`).then(() => true));
    const post = (path: string, body: unknown = {}, token = "") =>
      json(`${base}${path}`, jsonBody("POST", body, { authorization: client(token) }));

    await ready();
    await post("/Startup/Configuration", {
      UICulture: "en-US",
      MetadataCountryCode: "US",
      PreferredMetadataLanguage: "en",
    });
    await json(`${base}/Startup/User`);
    await post("/Startup/User", { Name: LOGIN.username, Password: LOGIN.password });
    await post("/Startup/RemoteAccess", { EnableRemoteAccess: true });
    await post("/Startup/Complete");

    // Jellyfin answers its public endpoints a moment before it accepts logins.
    const signIn = () =>
      until("Jellyfin to accept a login", async () =>
        v.parse(
          session,
          await post("/Users/AuthenticateByName", { Username: LOGIN.username, Pw: LOGIN.password }),
        ),
      );
    let { AccessToken: token } = await signIn();
    const authorized = { headers: { authorization: client(token) } };

    await post(
      `/Packages/Installed/${encodeURIComponent(PLAYBACK_REPORTING.name)}?assemblyGuid=${PLAYBACK_REPORTING.guid}&version=${PLAYBACK_REPORTING.version}`,
      {},
      token,
    );
    await until("the Playback Reporting plugin to install", async () =>
      v
        .parse(plugins, await json(`${base}/Plugins`, authorized))
        .some((plugin) => plugin.Name === PLAYBACK_REPORTING.name),
    );
    restart("jellyfin");
    await ready();
    const signedIn = await signIn();
    token = signedIn.AccessToken;
    const userId = signedIn.User.Id;
    const withToken = { headers: { authorization: client(token) } };

    await post(
      `/Library/VirtualFolders?${new URLSearchParams({
        name: "Music",
        collectionType: "music",
        paths: paths.library,
        refreshLibrary: "true",
      })}`,
      { LibraryOptions: {} },
      token,
    );
    const tracks = await until(
      "Jellyfin to scan the Library",
      async () => {
        const found = v.parse(
          items,
          await json(
            `${base}/Items?${new URLSearchParams({
              userId,
              includeItemTypes: "Audio",
              recursive: "true",
              sortBy: "SortName",
              limit: String(PLAYS),
            })}`,
            withToken,
          ),
        );
        return found.Items.length >= PLAYS && found.Items;
      },
      300_000,
    );

    // Jellyfin gets plays of its own, so Aurral has history to import.
    for (const track of tracks) {
      await post("/Sessions/Playing", { ItemId: track.Id, PlayMethod: "DirectPlay" }, token);
      await post(
        "/Sessions/Playing/Stopped",
        { ItemId: track.Id, PositionTicks: track.RunTimeTicks },
        token,
      );
    }

    await post(`/Auth/Keys?app=${API_KEY_NAME}`, {}, token);
    const key = v
      .parse(keys, await json(`${base}/Auth/Keys`, withToken))
      .Items.find((entry) => entry.AppName === API_KEY_NAME);
    if (!key) throw new Error("Jellyfin did not create an API key");
    await api.put("/history-servers/jellyfin", {
      url: base,
      username: LOGIN.username,
      secret: key.AccessToken,
    });
  },
};
