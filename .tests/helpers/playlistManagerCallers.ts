import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../fixtures/playlist-manager-caller.mts", import.meta.url));

function nextMessage(caller, type) {
  return new Promise((resolve) => {
    const listener = (message) => {
      if (message?.type !== type) return;
      caller.off("message", listener);
      resolve(message);
    };
    caller.on("message", listener);
  });
}

export async function callFromProcessesWhileHonkerLocked(t, honker, method, argsPerProcess) {
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
