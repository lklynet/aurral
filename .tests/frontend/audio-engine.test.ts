import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createAudioEngine } from "../../frontend/src/utils/audioEngine.ts";

const emptyRanges = {
  length: 0,
  start: () => 0,
  end: () => 0,
};

class FakeAudio extends EventTarget {
  src = "";
  preload = "";
  currentTime = 0;
  duration = 180;
  paused = true;
  ended = false;
  seeking = false;
  volume = 1;
  muted = false;
  readyState = 0;
  buffered = emptyRanges;
  played = emptyRanges;
  error = null;
  playCalls = 0;
  loadCalls = 0;

  load() {
    this.loadCalls += 1;
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    this.readyState = 4;
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  finish() {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("ended"));
  }
}

function setup() {
  const nodes: FakeAudio[] = [];
  const mounted: FakeAudio[] = [];
  const engine = createAudioEngine(
    () => {
      const node = new FakeAudio();
      nodes.push(node);
      return node as unknown as HTMLAudioElement;
    },
    (node) => {
      mounted.push(node as unknown as FakeAudio);
    },
  );
  engine.setLeveling(false);
  return { engine, mounted, nodes };
}

test("the active audio element stays mounted when the next track starts", () => {
  const { engine, mounted, nodes } = setup();
  let firstStarted = 0;
  let secondStarted = 0;

  engine.load({
    src: "/api/tracks/first",
    format: ["flac"],
    onStart: () => {
      firstStarted += 1;
    },
  });
  const active = nodes[0];
  assert.ok(active);

  engine.load({
    src: "/api/tracks/second",
    format: ["flac"],
    onStart: () => {
      secondStarted += 1;
    },
  });

  assert.equal(nodes.length, 1);
  assert.deepEqual(mounted, [active]);
  assert.equal(nodes[0], active);
  assert.equal(active.src, "/api/tracks/second");
  assert.equal(active.playCalls, 2);
  assert.equal(firstStarted, 1);
  assert.equal(secondStarted, 1);
});

test("a preloaded track still starts on the persistent active element", () => {
  const { engine, nodes } = setup();

  engine.load({
    src: "/api/tracks/first",
    format: ["flac"],
    onEnd: () => {
      engine.load({ src: "/api/tracks/second", format: ["flac"] });
    },
  });
  const active = nodes[0];
  assert.ok(active);
  engine.preload({ src: "/api/tracks/second", format: ["flac"] });
  const preloader = nodes[1];
  assert.ok(preloader);

  active.finish();

  assert.equal(nodes[0], active);
  assert.equal(active.src, "/api/tracks/second");
  assert.equal(active.playCalls, 2);
  assert.equal(preloader.playCalls, 0);
  assert.equal(preloader.src, "");
});

test("the persistent element keeps normal pause, resume, seek, volume, and mute behavior", () => {
  const { engine, nodes } = setup();
  const snapshots: ReturnType<typeof engine.getSnapshot>[] = [];
  engine.subscribe(() => snapshots.push(engine.getSnapshot()));
  engine.setVolume(0.4);
  engine.setMuted(true);

  engine.load({
    src: "/api/tracks/first",
    format: ["flac"],
    autoplay: false,
    startAt: 42,
  });
  const active = nodes[0];
  assert.ok(active);
  active.readyState = 1;
  active.dispatchEvent(new Event("loadedmetadata"));
  active.dispatchEvent(new Event("canplay"));

  assert.equal(active.currentTime, 42);
  assert.equal(active.volume, 0.4);
  assert.equal(active.muted, true);
  assert.equal(engine.getSnapshot().isPlaying, false);

  engine.play();
  assert.equal(engine.getSnapshot().isPlaying, true);
  engine.seek(75);
  assert.equal(active.currentTime, 75);
  engine.pause();
  assert.equal(engine.getSnapshot().isPlaying, false);
  assert.ok(snapshots.some((snapshot) => snapshot.isPlaying));
});
