import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createIsolatedLibraryWatcher } from "../../backend/services/libraryWatchProcess.js";

test.beforeEach((t) => {
  // Production watchers intentionally do not keep the parent process alive.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
});

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); };
  child.unref = () => {};
  child.channel = { unref() {} };
  return child;
}

test("slow watcher setup times out once and ignores late messages", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  const errors = [];
  const changes = [];
  const watcher = createIsolatedLibraryWatcher("/slow", {}, (...args) => changes.push(args), { forkImpl: () => child });
  watcher.on("error", (error) => errors.push(error));
  t.mock.timers.tick(10_000);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "LIBRARY_WATCH_STARTUP_TIMEOUT");
  assert.deepEqual(child.signals, ["SIGKILL"]);
  child.emit("message", { type: "ready" });
  child.emit("message", { type: "change", filename: "late.flac" });
  child.emit("error", new Error("late error"));
  child.emit("exit", 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(changes, []);
  watcher.close();
  assert.equal(child.signals.length, 1);
});

test("a ready watcher continues delivering events past the setup deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  const changes = [];
  const watcher = createIsolatedLibraryWatcher("/healthy", {}, (...args) => changes.push(args), { forkImpl: () => child });
  t.after(() => watcher.close());
  watcher.on("error", (error) => assert.fail(error.message));
  child.emit("message", { type: "ready" });
  t.mock.timers.tick(20_000);
  child.emit("message", { type: "change", eventType: "rename", filename: "album/track.flac" });
  assert.deepEqual(changes, [["rename", "album/track.flac", undefined]]);
  assert.deepEqual(child.signals, []);
});

test("closing during startup cancels the deadline without reporting a failure", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  const watcher = createIsolatedLibraryWatcher("/closing", {}, () => assert.fail("closed watcher changed"), { forkImpl: () => child });
  watcher.on("error", (error) => assert.fail(error.message));
  watcher.close();
  t.mock.timers.tick(20_000);
  child.emit("message", { type: "change", filename: null });
  child.emit("exit", null, "SIGKILL");
  assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("watcher failures are surfaced without affecting another root", () => {
  for (const failure of ["spawn", "watch", "exit"]) {
    const child = fakeChild();
    const healthy = fakeChild();
    const errors = [];
    const changes = [];
    const watcher = createIsolatedLibraryWatcher("/bad", {}, () => {}, { forkImpl: () => child });
    const other = createIsolatedLibraryWatcher("/good", {}, (...args) => changes.push(args), { forkImpl: () => healthy });
    watcher.on("error", (error) => errors.push(error));
    other.on("error", (error) => assert.fail(error.message));
    if (failure === "spawn") child.emit("error", new Error("spawn failed"));
    if (failure === "watch") child.emit("message", { type: "error", message: "watch unsupported", code: "ENOSYS" });
    if (failure === "exit") { child.exitCode = 1; child.emit("exit", 1); }
    assert.equal(errors.length, 1);
    healthy.emit("message", { type: "change", eventType: "change", filename: "track.flac" });
    assert.equal(changes.length, 1);
    watcher.close();
    other.close();
  }
});

for (const mapped of [false, true]) {
test(`real recursive watcher reports nested changes and exits on close (mapped: ${mapped})`, { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-watch-"));
  const album = path.join(root, "Artist", "Album");
  await mkdir(album, { recursive: true });
  let child;
  let watcher;
  t.after(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.ref();
      const exited = once(child, "exit");
      watcher.close();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const changes = new EventEmitter();
  const requestedRoot = mapped ? path.join(root, "remote-library") : root;
  watcher = createIsolatedLibraryWatcher(requestedRoot, { pathMappings: [{ remote: requestedRoot, local: root }] }, (_type, filename, watchedRoot) => changes.emit("change", filename, watchedRoot), {
    forkImpl: (...args) => { child = fork(...args); return child; },
  });
  await once(watcher, "ready");
  const changed = once(changes, "change");
  await writeFile(path.join(album, "track.flac"), "test");
  const [filename, watchedRoot] = await changed;
  assert.equal(path.normalize(filename), path.join("Artist", "Album", "track.flac"));
  assert.equal(watchedRoot, root);
});
}

for (const operation of ["watch", "existsSync"]) {
test(`HTTP remains responsive while child ${operation} blocks synchronously`, { timeout: 10_000 }, async (t) => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let child;
  const watcher = createIsolatedLibraryWatcher(operation === "watch" ? "/slow-root" : "/slow-path-mapping", {}, () => {}, {
    startupTimeoutMs: 2000,
    forkImpl: (_module, args, options) => {
      child = fork(new URL("../fixtures/blocking-library-watch-child.js", import.meta.url), args, options);
      return child;
    },
  });
  t.after(() => watcher.close());
  const failure = new Promise((resolve) => watcher.once("error", resolve));
  const exited = once(child, "exit");
  const [message] = await once(child, "message");
  assert.equal(message.operation, operation);
  const result = await fetch(`http://127.0.0.1:${server.address().port}/api/health/live`, { signal: AbortSignal.timeout(1000) });
  assert.equal(await result.text(), "ok");
  assert.equal(child.exitCode, null);
  assert.equal((await failure).code, "LIBRARY_WATCH_STARTUP_TIMEOUT");
  await exited;
});
}

test("a missing root is reported through the child without synchronous filesystem access", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-watch-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const watcher = createIsolatedLibraryWatcher(path.join(root, "absent"), {}, () => {});
  t.after(() => watcher.close());
  const error = await new Promise((resolve) => watcher.once("error", resolve));
  assert.equal(error.code, "ENOENT");
});
