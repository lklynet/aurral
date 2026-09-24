import test from "node:test";
import assert from "node:assert/strict";

import { websocketService } from "../../backend/services/websocketService.js";

test("disconnectUser immediately revokes every websocket for a user", () => {
  const closed = [];
  const makeClient = (id, userId) => ({
    id,
    user: { id: userId },
    subscriptions: new Set(["status", "weekly-flow"]),
    ws: {
      readyState: 1,
      close(code, reason) {
        this.readyState = 2;
        closed.push({ id, code, reason });
      },
    },
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
