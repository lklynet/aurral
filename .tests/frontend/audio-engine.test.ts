import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { createAudioEngine, levelingGain } from "../../frontend/src/utils/audioEngine.ts";

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
  isConnected = true;
  buffered = emptyRanges;
  played = emptyRanges;
  error = null;
  playCalls = 0;
  playRejections: (() => void)[] = [];

  load() {
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    return new Promise<void>((_resolve, reject) => {
      this.playRejections.push(() => reject(new DOMException("Interrupted", "AbortError")));
    });
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  start() {
    this.readyState = 4;
    this.dispatchEvent(new Event("canplay"));
    this.dispatchEvent(new Event("playing"));
  }

  finish() {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }
}

function setup() {
  const nodes: FakeAudio[] = [];
  const engine = createAudioEngine(() => {
    const node = new FakeAudio();
    nodes.push(node);
    return node as unknown as HTMLAudioElement;
  });
  engine.setLeveling(false);
  return { engine, nodes };
}

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

const state = (engine: ReturnType<typeof createAudioEngine>) => {
  const { isPlaying, isStarting } = engine.getSnapshot();
  if (isPlaying) return "playing";
  return isStarting ? "starting" : "idle";
};

test("the active audio element stays mounted when the next track starts", () => {
  const { engine, nodes } = setup();
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
  active.start();

  engine.load({
    src: "/api/tracks/second",
    format: ["flac"],
    onStart: () => {
      secondStarted += 1;
    },
  });
  active.start();

  assert.equal(nodes.length, 1);
  assert.equal(active.src, "/api/tracks/second");
  assert.equal(active.playCalls, 2);
  assert.equal(firstStarted, 1);
  assert.equal(secondStarted, 1);
});

test("preloading the next track adds no audio element", () => {
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
  active.start();
  engine.preload({ src: "/api/tracks/second", format: ["flac"] });

  active.finish();

  assert.equal(nodes.length, 1);
  assert.equal(active.src, "/api/tracks/second");
  assert.equal(active.playCalls, 2);
});

test("the persistent element keeps normal pause, resume, seek, volume, and mute behavior", () => {
  const { engine, nodes } = setup();
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
  assert.equal(state(engine), "idle");

  engine.play();
  active.dispatchEvent(new Event("playing"));
  assert.equal(state(engine), "playing");
  engine.seek(75);
  assert.equal(active.currentTime, 75);
  engine.pause();
  assert.equal(state(engine), "idle");
});

test("playback state stays truthful through every kind of pause", async () => {
  const { engine, nodes } = setup();
  const seen: string[] = [];
  engine.subscribe(() => {
    if (seen.at(-1) !== state(engine)) seen.push(state(engine));
  });
  let next: string | null = "/api/tracks/second";
  const loadTrack = (src: string) =>
    engine.load({
      src,
      format: ["flac"],
      onEnd: () => {
        if (!next) return;
        const upcoming = next;
        next = null;
        loadTrack(upcoming);
      },
    });

  loadTrack("/api/tracks/first");
  const active = nodes[0];
  assert.ok(active);
  active.start();
  seen.length = 0;

  active.finish();
  active.dispatchEvent(new Event("canplay"));
  active.dispatchEvent(new Event("playing"));
  assert.deepEqual(seen, ["starting", "playing"]);

  active.pause();
  assert.equal(state(engine), "idle");
  engine.play();
  assert.equal(state(engine), "starting");
  active.dispatchEvent(new Event("pause"));
  active.playRejections.at(-2)?.();
  await flushPromises();
  assert.equal(state(engine), "starting");
  active.dispatchEvent(new Event("playing"));
  assert.equal(state(engine), "playing");

  active.finish();
  assert.equal(state(engine), "idle");
});

test("a queued track is levelled only when its loudness arrives before it plays", async (t) => {
  vi.stubGlobal("window", {
    location: { href: "https://aurral.test/", origin: "https://aurral.test" },
  });
  const answers: (() => void)[] = [];
  vi.stubGlobal(
    "fetch",
    (_url: string, { signal }: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        answers.push(() =>
          resolve(new Response(null, { headers: { "X-Aurral-Loudness": "-6.0" } })),
        );
      }),
  );
  t.onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const levelled = 0.5 * levelingGain(-6);

  for (const [answeredAt, volume] of [
    ["before the track loads", levelled],
    ["while it is starting", levelled],
    ["after it started", 0.5],
  ] as const) {
    answers.length = 0;
    const { engine, nodes } = setup();
    engine.setLeveling(true);
    engine.setVolume(0.5);
    engine.load({ src: "https://aurral.test/api/tracks/first", format: ["flac"] });
    const active = nodes[0];
    assert.ok(active);
    active.start();
    engine.preload({ src: "https://aurral.test/api/tracks/second", format: ["flac"] });
    const answerSecond = answers[1];
    assert.ok(answerSecond);

    if (answeredAt === "before the track loads") answerSecond();
    await flushPromises();
    engine.load({ src: "https://aurral.test/api/tracks/second", format: ["flac"] });
    if (answeredAt === "while it is starting") answerSecond();
    await flushPromises();
    active.start();
    if (answeredAt === "after it started") answerSecond();
    await flushPromises();

    assert.equal(answers.length, 2, answeredAt);
    assert.equal(active.volume, volume, answeredAt);
  }
});

test("Deezer preview URLs skip loudness HEAD checks and loudness fetches do not follow redirects", async (t) => {
  vi.stubGlobal("window", {
    location: { href: "https://aurral.test/", origin: "https://aurral.test" },
  });
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null));
  });
  t.onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  const { engine } = setup();
  engine.setLeveling(true);
  engine.load({
    src: "https://aurral.test/api/deezer/preview?artist=Illiterates&track=Chip+Away",
    format: ["mp3"],
  });
  engine.preload({
    src: "https://aurral.test/api/deezer/preview/12345",
    format: ["mp3"],
  });
  assert.equal(calls.length, 0);

  engine.load({ src: "https://aurral.test/api/library/stream/1/2", format: ["flac"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.redirect, "manual");
});
