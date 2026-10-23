import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const callbackPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../frontend/public/spotify-oauth-callback.js",
);

type CallbackMessage = { type: string; payload: { access_token: string } };
type CallbackEnvironment = {
  location: { search: string; hash: string };
  opener: { onCompleteOauth(query: string, onComplete: () => void): void } | null;
  close(): void;
  BroadcastChannel?: new (name: string) => {
    postMessage(message: CallbackMessage): void;
    close(): void;
  };
  setTimeout?: (callback: () => void) => unknown;
};

function runCallback(env: CallbackEnvironment) {
  const execute = new Function(
    "window",
    "location",
    "BroadcastChannel",
    "setTimeout",
    readFileSync(callbackPath, "utf8"),
  );
  execute(env, env.location, env.BroadcastChannel, env.setTimeout ?? ((fn: () => void) => fn()));
}

test("spotify oauth callback forwards search to opener", () => {
  let captured = null;
  let closed = false;
  runCallback({
    location: { search: "?access_token=a&refresh_token=b&expires_in=3600", hash: "" },
    opener: {
      onCompleteOauth(query, onComplete) {
        captured = query;
        onComplete();
      },
    },
    close() {
      closed = true;
    },
  });
  assert.equal(captured, "?access_token=a&refresh_token=b&expires_in=3600");
  assert.equal(closed, true);
});

test("spotify oauth callback broadcasts tokens when opener is missing", () => {
  const messages: CallbackMessage[] = [];
  runCallback({
    location: { search: "?access_token=a&refresh_token=b&expires_in=3600", hash: "" },
    opener: null,
    close() {},
    BroadcastChannel: class {
      postMessage(message: CallbackMessage) {
        messages.push(message);
      }
      close() {}
    },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "ready");
  assert.equal(messages[0].payload.access_token, "a");
});
