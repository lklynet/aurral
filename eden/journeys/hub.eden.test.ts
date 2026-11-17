import assert from "node:assert/strict";
import * as v from "valibot";
import { test } from "vite-plus/test";
import { AurralApi } from "../aurral.ts";
import { local } from "../services/service.ts";
import { LISTENER } from "../state.ts";
import { api, has, ports, until } from "./eden.ts";

const status = v.variant("state", [
  v.object({ state: v.literal("none") }),
  v.object({ state: v.literal("pending"), code: v.string() }),
  v.object({ state: v.literal("linked"), handle: v.string() }),
  v.object({ state: v.literal("broken"), handle: v.string() }),
]);

// A browser on aurral.org: follows redirects by hand so it keeps the hub's cookies.
function browser(hub: string) {
  const cookies = new Map<string, string>();
  const send = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        ...init.headers,
        ...(url.startsWith(hub) && {
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        }),
      },
    });
    if (url.startsWith(hub)) {
      for (const cookie of response.headers.getSetCookie()) {
        const [name = "", value = ""] = (cookie.split(";")[0] ?? "").split("=");
        if (value) cookies.set(name, value);
        else cookies.delete(name);
      }
    }
    return response;
  };
  const follow = async (url: string, init?: RequestInit): Promise<Response> => {
    const response = await send(url, init);
    const location = response.headers.get("location");
    return location ? follow(new URL(location, url).href) : response;
  };
  const post = (path: string, fields: Record<string, string>) =>
    follow(`${hub}${path}`, {
      method: "POST",
      headers: { origin: hub, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  return { send, follow, post };
}

test.skipIf(!has("hub"))(
  "a listener links to an aurral.org account, publishes a playlist, and unlinking removes both there",
  async () => {
    const hub = local(ports.hub);
    const listener = new AurralApi(ports);
    await listener.login(LISTENER);
    await listener.request("DELETE", "/hub-link");

    const pending = v.parse(status, await listener.post("/hub-link"));
    assert.equal(pending.state, "pending");
    const code = pending.state === "pending" ? pending.code.replace("-", "") : "";

    const aurralOrg = browser(hub);
    const start = await aurralOrg.send(`${hub}/account/sign-in/eden?code=${code}`);
    const authorize = new URL(start.headers.get("location") ?? "");
    authorize.pathname = "/approve";
    authorize.searchParams.set("person", "grace");
    const handlePage = await aurralOrg.follow(authorize.href);
    assert.match(await handlePage.text(), /Pick a handle/);

    const confirm = await aurralOrg.post("/account/handle", { handle: "grace_eden", code });
    assert.match(await confirm.text(), /Link Aurral user listener to @grace_eden\?/);
    const account = await aurralOrg.post("/link", { code });
    assert.match(await account.text(), /Aurral user listener/);

    assert.deepEqual(v.parse(status, await listener.get("/hub-link")), {
      state: "linked",
      handle: "grace_eden",
    });

    const users = v.parse(
      v.array(
        v.object({
          id: v.number(),
          username: v.string(),
          permissions: v.record(v.string(), v.boolean()),
        }),
      ),
      await api.get("/users"),
    );
    const member = users.find((user) => user.username === LISTENER.username);
    assert.ok(member);
    await api.request("PATCH", `/users/${member.id}`, {
      permissions: { ...member.permissions, accessPlaylists: true },
    });
    const { playlistId } = v.parse(
      v.object({ playlistId: v.string() }),
      await listener.post("/playlists/static-playlists", {
        name: "Eden night",
        tracks: [{ artistName: "Radiohead", trackName: "Reckoner" }],
        downloadMissing: false,
      }),
    );
    await until("the playlist to be public", () =>
      listener.put(`/hub-link/public-playlists/${playlistId}`),
    );
    const shelf = async () => JSON.stringify(await (await fetch(`${hub}/v1/playlists`)).json());
    assert.match(await shelf(), /"title":"Eden night".*"handle":"grace_eden"/);

    await listener.request("DELETE", "/hub-link");
    await until("aurral.org to forget the link", async () =>
      (await (await aurralOrg.follow(`${hub}/account`)).text()).includes("None yet"),
    );
    assert.doesNotMatch(await shelf(), /Eden night/);
    await api.request("PATCH", `/users/${member.id}`, { permissions: member.permissions });
    await aurralOrg.post("/account/delete", {});
  },
);
