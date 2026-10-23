import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ChildProcess } from "node:child_process";
import type { TestContext } from "vite-plus/test";
import type * as HonkerDb from "../../backend/services/honkerDb.ts";
import type { playlistManager } from "../../backend/services/playlists/playlistManager.ts";

type CallableMethod = "schedulePlaybackScan" | "requestPlaylistSync";

export type PlaylistManagerCall = {
  [Method in CallableMethod]: {
    method: Method;
    args: Parameters<(typeof playlistManager)[Method]>;
  };
}[CallableMethod];

const fixture = fileURLToPath(new URL("../fixtures/playlist-manager-caller.mts", import.meta.url));

function nextMessage(caller: ChildProcess, type: string) {
  return new Promise<{ type?: string; jobId?: unknown }>((resolve) => {
    const listener = (message: { type?: string; jobId?: unknown }) => {
      if (message?.type !== type) return;
      caller.off("message", listener);
      resolve(message);
    };
    caller.on("message", listener);
  });
}

export async function callFromProcessesWhileHonkerLocked<Method extends CallableMethod>(
  t: TestContext,
  honker: typeof HonkerDb,
  method: Method,
  argsPerProcess: Parameters<(typeof playlistManager)[Method]>[],
) {
  const callers = argsPerProcess.map(() =>
    fork(fixture, { stdio: ["ignore", "ignore", "inherit", "ipc"] }),
  );
  t.onTestFinished(() => callers.forEach((caller) => caller.kill()));
  await Promise.all(callers.map((caller) => nextMessage(caller, "ready")));

  const writeLock = honker.getHonkerDb().transaction();
  const scheduled = callers.map((caller) => nextMessage(caller, "scheduled"));
  await Promise.all(
    callers.map((caller, index) => {
      const calling = nextMessage(caller, "calling");
      caller.send({ method, args: argsPerProcess[index] });
      return calling;
    }),
  );
  await delay(500);
  writeLock.commit();
  return (await Promise.all(scheduled)).map(({ jobId }) => jobId);
}
