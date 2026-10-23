import assert from "node:assert/strict";
import { test, beforeEach, vi } from "vite-plus/test";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createIsolatedLibraryWatcher } from "../../backend/services/libraryWatchProcess.ts";

beforeEach((t: import("vite-plus/test").TestContext) => {
  // Production watchers intentionally do not keep the parent process alive.
  const keepAlive = setInterval(() => {}, 1000);
  t.onTestFinished(() => clearInterval(keepAlive));
});

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    signals: [] as (NodeJS.Signals | number | undefined)[],
    kill(signal?: NodeJS.Signals | number) {
      this.signals.push(signal);
      return true;
    },
    unref() {},
    channel: { unref() {} },
  });
  return child;
}

type StartupOutcome =
  | { type: "ready"; root: string }
  | { type: "error"; error: NodeJS.ErrnoException };

function waitForWatcherStartup(watcher: ReturnType<typeof createIsolatedLibraryWatcher>) {
  return new Promise<StartupOutcome>((resolve) => {
    const finish = (outcome: StartupOutcome) => {
      watcher.off("ready", onReady);
      watcher.off("error", onError);
      resolve(outcome);
    };
    const onReady = (root: string) => finish({ type: "ready", root });
    const onError = (error: NodeJS.ErrnoException) => finish({ type: "error", error });
    watcher.once("ready", onReady);
    watcher.once("error", onError);
  });
}

test("a slow watcher setup is kept until it becomes ready", (t: import("vite-plus/test").TestContext) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], now: 0 });
  const child = fakeChild();
  const changes: [eventType: string, filename: string | null, root: string][] = [];
  const readyRoots: string[] = [];
  const watcher = createIsolatedLibraryWatcher("/slow", {}, (...args) => changes.push(args), {
    forkImpl: () => child as unknown as ReturnType<typeof fork>,
  });
  t.onTestFinished(() => watcher.close());
  watcher.on("ready", (root) => readyRoots.push(root));
  watcher.on("error", (error) => assert.fail(error.message));
  vi.advanceTimersByTime(10 * 60_000);
  assert.deepEqual([...child.signals], []);
  child.emit("message", { type: "ready", root: "/resolved-library" });
  child.emit("message", { type: "change", eventType: "rename", filename: "album/track.flac" });
  assert.deepEqual(readyRoots, ["/resolved-library"]);
  assert.deepEqual(changes, [["rename", "album/track.flac", undefined]]);
  assert.deepEqual([...child.signals], []);
});

test("closing during startup stops the child without reporting a failure", () => {
  const child = fakeChild();
  const watcher = createIsolatedLibraryWatcher(
    "/closing",
    {},
    () => assert.fail("closed watcher changed"),
    { forkImpl: () => child as unknown as ReturnType<typeof fork> },
  );
  let closed = 0;
  watcher.on("close", () => {
    closed++;
  });
  watcher.on("error", (error) => assert.fail(error.message));
  watcher.close();
  child.emit("message", { type: "ready" });
  child.emit("message", { type: "change", filename: null });
  child.emit("exit", null, "SIGKILL");
  watcher.close();
  assert.equal(closed, 1);
  assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("watcher failures are surfaced without affecting another root", () => {
  for (const failure of ["spawn", "watch", "exit"]) {
    const child = fakeChild();
    const healthy = fakeChild();
    const errors: Error[] = [];
    const changes: [eventType: string, filename: string | null, root: string][] = [];
    const watcher = createIsolatedLibraryWatcher("/bad", {}, () => {}, {
      forkImpl: () => child as unknown as ReturnType<typeof fork>,
    });
    const other = createIsolatedLibraryWatcher("/good", {}, (...args) => changes.push(args), {
      forkImpl: () => healthy as unknown as ReturnType<typeof fork>,
    });
    watcher.on("error", (error) => errors.push(error));
    other.on("error", (error) => assert.fail(error.message));
    if (failure === "spawn") child.emit("error", new Error("spawn failed"));
    if (failure === "watch")
      child.emit("message", { type: "error", message: "watch unsupported", code: "ENOSYS" });
    if (failure === "exit") {
      child.exitCode = 1;
      child.emit("exit", 1);
    }
    assert.equal(errors.length, 1);
    healthy.emit("message", { type: "change", eventType: "change", filename: "track.flac" });
    assert.equal(changes.length, 1);
    watcher.close();
    other.close();
  }
});

for (const mapped of [false, true]) {
  test(
    `real recursive watcher reports nested changes and exits on close (mapped: ${mapped})`,
    { timeout: 10_000 },
    async (t: import("vite-plus/test").TestContext) => {
      const root = await mkdtemp(path.join(tmpdir(), "aurral-watch-"));
      const album = path.join(root, "Artist", "Album");
      await mkdir(album, { recursive: true });
      let child: import("node:child_process").ChildProcess | undefined;
      let watcher: ReturnType<typeof createIsolatedLibraryWatcher> | undefined;
      t.onTestFinished(async () => {
        if (child && child.exitCode == null && child.signalCode == null) {
          child.ref();
          const exited = once(child, "exit");
          watcher?.close();
          await exited;
        }
        await rm(root, { recursive: true, force: true });
      });
      const changes = new EventEmitter();
      const requestedRoot = mapped ? path.join(root, "remote-library") : root;
      watcher = createIsolatedLibraryWatcher(
        requestedRoot,
        { pathMappings: [{ source: "all", remote: requestedRoot, local: root }] },
        (_type, filename, watchedRoot) => changes.emit("change", filename, watchedRoot),
        {
          forkImpl: ((...args: Parameters<typeof fork>) => {
            child = fork(...args);
            return child;
          }) as typeof fork,
        },
      );
      const [readyRoot] = await once(watcher, "ready");
      assert.equal(readyRoot, root);
      const changed = once(changes, "change");
      await writeFile(path.join(album, "track.flac"), "test");
      const [filename, watchedRoot] = await changed;
      assert.equal(path.normalize(filename), path.join("Artist", "Album", "track.flac"));
      assert.equal(watchedRoot, root);
    },
  );
}

for (const operation of ["watch", "existsSync"]) {
  test(
    `HTTP remains responsive while child ${operation} blocks synchronously`,
    { timeout: 10_000 },
    async (t: import("vite-plus/test").TestContext) => {
      const server = http.createServer((_req, res) => res.end("ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.onTestFinished(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      let child: import("node:child_process").ChildProcess | undefined;
      const watcher = createIsolatedLibraryWatcher(
        operation === "watch" ? "/slow-root" : "/slow-path-mapping",
        {},
        () => {},
        {
          forkImpl: ((...[_module, args, options]: Parameters<typeof fork>) => {
            child = fork(
              new URL("../fixtures/blocking-library-watch-child.ts", import.meta.url),
              args,
              options,
            );
            return child;
          }) as typeof fork,
        },
      );
      t.onTestFinished(() => watcher.close());
      watcher.on("error", (error) => assert.fail(error.message));
      assert.ok(child);
      const exited = once(child, "exit");
      const [message] = await once(child, "message");
      assert.equal(message.operation, operation);
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const result = await fetch(`http://127.0.0.1:${address.port}/api/health/live`, {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(await result.text(), "ok");
      assert.equal(child.exitCode, null);
      watcher.close();
      const [, signal] = await exited;
      assert.equal(signal, "SIGKILL");
    },
  );
}

test(
  "a missing root reports ENOENT instead of becoming ready",
  { timeout: 5_000 },
  async (t: import("vite-plus/test").TestContext) => {
    const root = await mkdtemp(path.join(tmpdir(), "aurral-watch-missing-"));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const watcher = createIsolatedLibraryWatcher(path.join(root, "absent"), {}, () => {});
    t.onTestFinished(() => watcher.close());
    const outcome = await waitForWatcherStartup(watcher);
    assert.equal(outcome.type, "error", `Missing library root unexpectedly became ready`);
    assert.equal(
      outcome.error.code,
      "ENOENT",
      `Missing library root reported ${outcome.error.code}: ${outcome.error.message}`,
    );
  },
);
