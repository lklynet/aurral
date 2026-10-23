import { requireFixture } from "./fixtures.ts";
import assert from "node:assert/strict";
import { on, once } from "node:events";
import { test, afterAll } from "vite-plus/test";
import bcrypt from "bcrypt";
import { WebSocket } from "ws";
import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  startServerProcess,
} from "../helpers/backendTestHarness.ts";

const [state, { dbOps, userOps }, { flowPlaylistConfig }] = await setupIsolatedBackend(
  "playlist-websocket",
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
);
let server: {
  child: import("node:child_process").ChildProcessByStdio<
    null,
    import("node:stream").Readable,
    import("node:stream").Readable
  >;
  port: number;
  logs: () => string;
  stop(): Promise<void>;
};
afterAll(async () => {
  await server?.stop();
  await cleanupIsolatedState(state);
});

test(
  "playlist sockets deliver initial state, persisted changes, and a fresh state after resubscribing",
  { timeout: 15000 },
  async (t: import("vite-plus/test").TestContext) => {
    dbOps.updateSettings({
      integrations: {},
      onboardingComplete: true,
      flows: [],
      sharedPlaylists: [],
    });
    const user = userOps.createUser("test", bcrypt.hashSync("password", 4), "admin");
    assert.ok(user != null);
    const playlist = flowPlaylistConfig.createStaticPlaylist({
      name: "Before",
      ownerUserId: user.id,
    });
    server = await startServerProcess();
    const login = await fetch(`http://127.0.0.1:${server.port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "test", password: "password" }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws?token=${encodeURIComponent(token)}`,
    );
    const messages = on(socket, "message");
    t.onTestFinished(async () => {
      socket.terminate();
      await messages.return?.();
    });
    type Message = {
      type: string;
      channel?: string;
      status: Awaited<
        ReturnType<
          typeof import("../../backend/services/playlists/playlistStatusSnapshot.ts").getPlaylistStatusSnapshot
        >
      >;
    };
    const next = async (predicate: (message: Message) => boolean) => {
      for (;;) {
        const { value } = await messages.next();
        const message: Message = JSON.parse(requireFixture(value)[0].toString());
        if (predicate(message)) return message;
      }
    };
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", channels: ["playlists"] }));
    const initial = await next((message) => message.type === "playlist_status");
    assert.equal(
      initial.status.sharedPlaylists.find((entry) => entry.id === playlist.id)?.name,
      "Before",
    );
    dbOps.updateSettings({ sharedPlaylists: [{ ...playlist, name: "After" }] });
    const updated = await next(
      (message) =>
        message.type === "playlist_status" &&
        message.status.sharedPlaylists.some((entry) => entry.name === "After"),
    );
    assert.equal(updated.channel, "playlists");
    socket.send(JSON.stringify({ type: "unsubscribe", channels: ["playlists"] }));
    await next((message) => message.type === "unsubscribed");
    socket.send(JSON.stringify({ type: "subscribe", channels: ["playlists"] }));
    const resubscribed = await next((message) => message.type === "playlist_status");
    assert.equal(resubscribed.status.sharedPlaylists[0].name, "After");
  },
);
