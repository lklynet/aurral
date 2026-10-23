import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { websocketService } from "../../backend/services/websocketService.ts";

test("disconnectUser immediately revokes every websocket for a user", () => {
  type Client = Parameters<typeof websocketService.clients.add>[0];
  const closed: { id: string; code?: number; reason?: string | Buffer }[] = [];
  const makeClient = (id: string, userId: number): Client => ({
    id,
    user: { id: userId } as NonNullable<Client["user"]>,
    authSource: "session",
    connectedAt: Date.now(),
    subscriptions: new Set(["status", "weekly-flow"]),
    ws: {
      readyState: 1,
      close(code?: number, reason?: string | Buffer) {
        Object.defineProperty(this, "readyState", { value: 2 });
        closed.push({ id, code, reason });
      },
    } as Client["ws"],
  });
  const first = makeClient("first", 41);
  const second = makeClient("second", 41);
  const other = makeClient("other", 42);
  websocketService.clients.add(first);
  websocketService.clients.add(second);
  websocketService.clients.add(other);

  try {
    assert.equal(websocketService.disconnectUser(41), 2);
    assert.deepEqual(closed, [
      { id: "first", code: 4403, reason: "Account inactive" },
      { id: "second", code: 4403, reason: "Account inactive" },
    ]);
    assert.equal(websocketService.clients.has(first), false);
    assert.equal(websocketService.clients.has(second), false);
    assert.equal(websocketService.clients.has(other), true);
    assert.equal(first.user, null);
    assert.equal(first.subscriptions.size, 0);
  } finally {
    websocketService.clients.clear();
  }
});
