import type { WrappedRecap } from "../hooks/useWrapped.ts";
import { WRAPPED_DISPLAY, WRAPPED_TEXT } from "../utils/wrappedShare";
import { WRAPPED_DIGITS } from "./wrappedDigits.ts";

export const REEL_WIDTH = 720;
export const REEL_HEIGHT = 1280;
const TAU = Math.PI * 2;
const PAPER = "#efe9dd";
const FOOTAGE_FPS = 24;
const CLIPS = {
  needle: [0, 71],
  singer: [76, 47],
  jukebox: [128, 42],
  spin: [175, 59],
  twirl: [239, 59],
  slowdance: [303, 47],
  cymbal: [355, 37],
  sax: [397, 30],
  couple: [432, 25],
} as const;
const MONTHS = "JFMAMJJASOND";
const WAVE = [
  52, 594, 100, 606, 150, 590, 182, 548, 198, 492, 214, 440, 236, 410, 264, 412, 292, 434, 307, 475,
  311, 560, 314, 636, 334, 690, 365, 706, 397, 690, 414, 648, 420, 600, 428, 548, 446, 506, 472,
  484, 505, 482, 536, 498, 546, 526, 530, 552,
];
const EAR = [
  392, 462, 402, 418, 430, 375, 470, 347, 520, 338, 570, 345, 610, 370, 636, 410, 645, 460, 643,
  510, 625, 558, 596, 598, 568, 638, 550, 685, 540, 728, 515, 755, 480, 762, 450, 750,
];
const LOGO = { x: -200, y: -150, scale: 0.615 };

type Beats = WrappedRecap["topSongs"][number]["beats"];
type Vec = readonly [number, number];
type Point = { x: number; y: number; t: number; up: boolean; dyn: boolean; w: number };
type Line = {
  text: string;
  x: number;
  y: number;
  size: number;
  font: string;
  spacing: number;
  color: string;
  alpha: number;
};
type Box = { x: number; y: number; w: number; h: number };
type Opening = {
  field: string;
  year: Line[];
  covers: { image: HTMLImageElement; box: Box }[];
  foot: Line[];
};
type Piece = {
  clip: keyof typeof CLIPS;
  rate: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  land: number;
  seed: number;
  video?: HTMLVideoElement;
  still?: HTMLCanvasElement;
};
type Word =
  | { text: string; x: number; y: number; size: number; mode: "wipe"; from: number; to: number }
  | { text: string; x: number; y: number; size: number; mode: "pop"; t: number; right?: boolean };
type Stroke = { wob?: number; e?: number; up?: boolean; dyn?: boolean; slow?: number };
type Snap = {
  image: HTMLImageElement;
  slot: Box;
  x: number;
  y: number;
  size: number;
  rot: number;
  land: number;
};

const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const lerp = (from: number, to: number, k: number) => from + (to - from) * k;
const ease = {
  linear: (k: number) => k,
  in: (k: number) => k ** 3,
  out: (k: number) => 1 - (1 - k) ** 3,
  inOut: (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2),
  outBack: (k: number) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2,
  expoOut: (k: number) => (k >= 1 ? 1 : 1 - 2 ** (-10 * k)),
};
const random = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
};

export function beatGrid(beats: Beats) {
  const times = beats?.beats.length ? beats.beats : [0.6];
  const period = 60 / (beats?.bpm ?? 100);
  const last = times.length - 1;
  const beat = (n: number) => {
    if (n <= 0) return times[0] + n * period;
    const i = Math.floor(n);
    return i < last ? lerp(times[i], times[i + 1], n - i) : times[last] + (n - last) * period;
  };
  const beatAt = (t: number) => {
    if (t <= times[0]) return (t - times[0]) / period;
    for (let i = 0; i < last; i++)
      if (t < times[i + 1]) return i + (t - times[i]) / (times[i + 1] - times[i]);
    return last + (t - times[last]) / period;
  };
  const downbeat = beats?.downbeat ?? 0;
  const bar = [0, 1, 2, 3].find((n) => beat(downbeat + n * 4) >= 1.8) ?? 3;
  const zero = downbeat + bar * 4;
  return {
    period,
    at: (n: number) => beat(zero + n),
    since: (t: number) => beatAt(t) - zero,
    pulse: (t: number, decay: number) => {
      const k = beatAt(t);
      return k < 0 ? 0 : Math.exp(-((k - Math.floor(k)) * period) / decay);
    },
  };
}

function textLines(
  element: Element,
  frame: DOMRect,
  scale: number,
  measure: CanvasRenderingContext2D,
) {
  const style = getComputedStyle(element);
  const size = parseFloat(style.fontSize) * scale;
  const font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
  measure.font = font;
  const ascent = measure.measureText("0").fontBoundingBoxAscent;
  const lines: Line[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (!text) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    lines.push({
      text,
      x: (rect.left - frame.left) * scale,
      y: (rect.top - frame.top) * scale + ascent,
      size,
      font,
      spacing: style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing) * scale,
      color: style.color,
      alpha: Number(style.opacity),
    });
  }
  return lines;
}

export function measureOpening(slide: HTMLElement): Opening {
  const frame = slide.getBoundingClientRect();
  const scale = REEL_WIDTH / frame.width;
  const measure = document.createElement("canvas").getContext("2d");
  const year = slide.querySelector(".wrapped-year");
  const lines = (selector: string) =>
    measure
      ? [...slide.querySelectorAll(selector)].flatMap((element) =>
          textLines(element, frame, scale, measure),
        )
      : [];
  return {
    field: getComputedStyle(slide).backgroundColor,
    year: year && measure ? textLines(year, frame, scale, measure) : [],
    covers: [...slide.querySelectorAll<HTMLImageElement>(".wrapped-stack img")].map((image) => {
      const rect = image.getBoundingClientRect();
      return {
        image,
        box: {
          x: (rect.left - frame.left) * scale,
          y: (rect.top - frame.top) * scale,
          w: rect.width * scale,
          h: rect.height * scale,
        },
      };
    }),
    foot: lines(".wrapped-foot p"),
  };
}

function drawLine(context: CanvasRenderingContext2D, line: Line, alpha = 1) {
  context.font = line.font;
  context.letterSpacing = `${line.spacing}px`;
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = line.color;
  context.globalAlpha = line.alpha * alpha;
  context.fillText(line.text, line.x, line.y);
  context.globalAlpha = 1;
}

function drawCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  box: Box,
) {
  const [width, height] =
    image instanceof HTMLImageElement
      ? [image.naturalWidth, image.naturalHeight]
      : image instanceof HTMLVideoElement
        ? [image.videoWidth, image.videoHeight]
        : [image.width, image.height];
  if (!width || !height) return;
  const scale = Math.max(box.w / width, box.h / height);
  const sw = box.w / scale;
  const sh = box.h / scale;
  context.drawImage(image, (width - sw) / 2, (height - sh) / 2, sw, sh, box.x, box.y, box.w, box.h);
}

function text(
  context: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  {
    family = WRAPPED_DISPLAY,
    weight = 900,
    spacing = -0.03,
    align = "left",
  }: { family?: string; weight?: number; spacing?: number; align?: CanvasTextAlign } = {},
) {
  context.font = `${weight} ${size}px ${family}`;
  context.letterSpacing = `${spacing * size}px`;
  context.textAlign = align;
  context.textBaseline = "alphabetic";
  context.fillStyle = "#fff";
  context.fillText(value, x, y);
}

function grainFrames() {
  return Array.from({ length: 6 }, (_, index) => {
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 640;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    const pixels = context.createImageData(360, 640);
    const next = random(index + 7);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = next() * 255;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  });
}

function contourPoints(path: string) {
  return path.split(/(?=M)/).map((d) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
    element.setAttribute("d", d);
    const length = element.getTotalLength();
    const count = Math.ceil(length / 10);
    return Array.from({ length: count + 1 }, (_, i) => {
      const point = element.getPointAtLength((i * length) / count);
      return [point.x, point.y] as const;
    });
  });
}

export function createReel({
  beats,
  summary,
  logo,
  opening,
  footage,
}: {
  beats: Beats;
  summary: WrappedRecap;
  logo: Path2D;
  opening: Opening;
  footage: string | null;
}) {
  const grid = beatGrid(beats);
  const { at, period } = grid;
  const points: Point[] = [];
  const pen = { x: 0, y: 0, dx: 1, dy: 0, t: 0 };
  let arc = 0;

  const resample = (raw: readonly Vec[], step = 5) => {
    const result: Vec[] = [raw[0]];
    let carry = 0;
    for (let i = 1; i < raw.length; i++) {
      const [ax, ay] = raw[i - 1];
      const [bx, by] = raw[i];
      const length = Math.hypot(bx - ax, by - ay);
      let d = step - carry;
      for (; d <= length; d += step)
        result.push([ax + ((bx - ax) * d) / length, ay + ((by - ay) * d) / length]);
      carry = length - (d - step);
    }
    const last = raw[raw.length - 1];
    const end = result[result.length - 1];
    if (Math.hypot(last[0] - end[0], last[1] - end[1]) > 0.5) result.push(last);
    return result;
  };

  const add = (
    raw: readonly Vec[],
    t0: number,
    t1: number,
    { wob = 1, e = 0.5, up = false, dyn = false, slow = 1.4 }: Stroke = {},
  ) => {
    const sampled = resample(raw);
    const path = sampled.map(([x, y], i): Vec => {
      const a = sampled[Math.max(0, i - 1)];
      const b = sampled[Math.min(sampled.length - 1, i + 1)];
      const nx = -(b[1] - a[1]);
      const ny = b[0] - a[0];
      const length = Math.hypot(nx, ny) || 1;
      const s = arc + i * 5;
      const offset = up
        ? 0
        : wob *
          (1.6 * Math.sin(s / 17 + 1.3) + 0.9 * Math.sin(s / 41 + 4.1) + 0.35 * Math.sin(s / 5.3));
      return [x + (nx / length) * offset, y + (ny / length) * offset];
    });
    arc += sampled.length * 5;
    const cost = [0];
    for (let i = 1; i < path.length; i++) {
      let turn = 0;
      if (i > 1) {
        const before = Math.atan2(path[i - 1][1] - path[i - 2][1], path[i - 1][0] - path[i - 2][0]);
        const after = Math.atan2(path[i][1] - path[i - 1][1], path[i][0] - path[i - 1][0]);
        turn = Math.abs(((after - before + 3 * Math.PI) % TAU) - Math.PI);
      }
      cost.push(cost[i - 1] + 1 + slow * Math.min(1, turn / 0.2));
    }
    const total = cost[cost.length - 1] || 1;
    const curve = (u: number) => (1 - e) * u + e * u * u * (3 - 2 * u);
    const invert = (c: number) => {
      let low = 0;
      let high = 1;
      for (let k = 0; k < 24; k++) {
        const middle = (low + high) / 2;
        if (curve(middle) < c) low = middle;
        else high = middle;
      }
      return (low + high) / 2;
    };
    path.forEach(([x, y], i) => {
      if (i === 0 && points.length) return;
      points.push({
        x,
        y,
        t: t0 + (t1 - t0) * invert(cost[i] / total),
        up: up && i > 0,
        dyn,
        w: 1,
      });
    });
    const [ex, ey] = path[path.length - 1];
    const [px, py] = path[Math.max(0, path.length - 4)];
    const length = Math.hypot(ex - px, ey - py) || 1;
    Object.assign(pen, { x: ex, y: ey, dx: (ex - px) / length, dy: (ey - py) / length, t: t1 });
  };

  const bezier = (p0: Vec, p1: Vec, p2: Vec, p3: Vec, n = 60) =>
    Array.from({ length: n + 1 }, (_, i): Vec => {
      const u = i / n;
      const v = 1 - u;
      return [
        v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
        v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1],
      ];
    });
  const to = (
    x: number,
    y: number,
    direction: Vec,
    t1: number,
    { k = 0.42, ...options }: Stroke & { k?: number } = {},
  ) => {
    const d = Math.hypot(x - pen.x, y - pen.y);
    const length = Math.hypot(direction[0], direction[1]) || 1;
    add(
      bezier(
        [pen.x, pen.y],
        [pen.x + pen.dx * d * k, pen.y + pen.dy * d * k],
        [x - (direction[0] / length) * d * k, y - (direction[1] / length) * d * k],
        [x, y],
      ),
      pen.t,
      t1,
      options,
    );
  };
  const spline = (P: readonly Vec[], n = 14) => {
    const result: Vec[] = [];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)];
      const p1 = P[i];
      const p2 = P[i + 1];
      const p3 = P[Math.min(P.length - 1, i + 2)];
      for (let j = 0; j < n; j++) {
        const u = j / n;
        const axis = (c: 0 | 1) =>
          0.5 *
          (2 * p1[c] +
            (-p0[c] + p2[c]) * u +
            (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u * u +
            (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u * u * u);
        result.push([axis(0), axis(1)]);
      }
    }
    result.push(P[P.length - 1]);
    return result;
  };
  type Oval = { tilt?: number; grow?: number; dy?: number; seed?: number };
  const ellipse = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    a0: number,
    sweep: number,
    { tilt = 0, grow = 0.06, dy = 0, seed = 1 }: Oval = {},
  ) =>
    Array.from({ length: 160 }, (_, i): Vec => {
      const u = i / 159;
      const a = a0 + sweep * u;
      const r = 1 + grow * u + 0.035 * Math.sin(2 * a + seed);
      const x = Math.cos(a) * rx * r;
      const y = Math.sin(a) * ry * r;
      return [
        cx + x * Math.cos(tilt) - y * Math.sin(tilt),
        cy + dy * u + x * Math.sin(tilt) + y * Math.cos(tilt),
      ];
    });
  const tangent = (rx: number, ry: number, a: number, sweep: number, tilt = 0): Vec => {
    const s = Math.sign(sweep);
    const x = -Math.sin(a) * rx * s;
    const y = Math.cos(a) * ry * s;
    return [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt)];
  };
  const onEllipse = (cx: number, cy: number, rx: number, ry: number, a: number, tilt = 0): Vec => {
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    return [
      cx + x * Math.cos(tilt) - y * Math.sin(tilt),
      cy + x * Math.sin(tilt) + y * Math.cos(tilt),
    ];
  };
  const loop = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    a0: number,
    sweep: number,
    t1: number,
    options: Oval & { at?: number } = {},
  ) => {
    const [sx, sy] = onEllipse(cx, cy, rx, ry, a0, options.tilt);
    to(
      sx,
      sy,
      tangent(rx, ry, a0, sweep, options.tilt),
      options.at ?? pen.t + (t1 - pen.t) * 0.25,
      { e: 0.6 },
    );
    add(ellipse(cx, cy, rx, ry, a0, sweep, options), pen.t, t1, { e: 0.35, slow: 0.3 });
  };
  const swoosh = (x: number, y: number, width: number, lift: number): Vec[] => [
    [x, y],
    [x + width * 0.35, y + 4],
    [x + width * 0.7, y + 3],
    [x + width, y - lift],
  ];
  const curl = (r: number, t1: number) => {
    const cx = pen.x - pen.dy * r;
    const cy = pen.y + pen.dx * r;
    const a0 = Math.atan2(pen.y - cy, pen.x - cx);
    add(
      Array.from({ length: 90 }, (_, i): Vec => {
        const u = i / 89;
        const a = a0 + TAU * u;
        const g = 1 + 0.18 * u;
        return [cx + Math.cos(a) * r * g, cy + Math.sin(a) * r * g + u * r * 0.5];
      }),
      pen.t,
      t1,
      { e: 0.3, slow: 0.2 },
    );
  };

  const onLogo = (flat: number[]) =>
    Array.from({ length: flat.length / 2 }, (_, i): Vec => [
      LOGO.x + (flat[i * 2] - 35) * LOGO.scale,
      LOGO.y + (flat[i * 2 + 1] - 300) * LOGO.scale,
    ]);
  const wave = spline(onLogo(WAVE));
  const ear = spline(onLogo(EAR));
  const logoStart = 0.12;
  const logoEnd = at(0) - 0.03;
  const waveLength = resample(wave).length;
  const split =
    logoStart + ((logoEnd - logoStart - 0.12) * waveLength) / (waveLength + resample(ear).length);
  pen.x = wave[0][0];
  pen.y = wave[0][1];
  add(wave, logoStart, split, { e: 0.35, wob: 0.5 });
  add([[pen.x, pen.y], ear[0]], split, split + 0.12, { up: true, e: 1 });
  add(ear, split + 0.12, logoEnd, { e: 0.35, wob: 0.5 });
  const logoPoints = points.length;

  const pieces: Piece[] = [];
  const words: Word[] = [];
  const snaps: Snap[] = [];
  const S1 = { x: -330, y: 1050 };
  const S2 = { x: 330, y: 2050 };
  const S3 = { x: -330, y: 3050 };

  to(LOGO.x + 20, 205, [1, 0.04], at(1), { e: 0.7 });
  add(
    spline([
      [pen.x, pen.y],
      [-20, 214],
      [120, 208],
      [220, 192],
      [258, 170],
    ]),
    at(1),
    at(2),
    { e: 0.6 },
  );

  const face: Vec = [S1.x - 34, S1.y - 322];
  const faceAngle = Math.PI * 0.95;
  const faceStart = onEllipse(face[0], face[1], 66, 78, faceAngle, -0.2);
  pieces.push({
    clip: "needle",
    rate: 1,
    x: -40,
    y: 470,
    w: 270,
    h: 203,
    rot: -0.08,
    land: at(2),
    seed: 13,
  });
  to(60, 400, [-0.3, 1], at(2.9), { e: 0.55 });
  curl(58, at(3.4));
  to(faceStart[0], faceStart[1], tangent(66, 78, faceAngle, 1, -0.2), at(4), { e: 0.45 });
  add(
    ellipse(face[0], face[1], 66, 78, faceAngle, TAU * 1.12, { tilt: -0.2, grow: 0.12, seed: 2 }),
    at(4),
    at(5.25),
    { e: 0.35, slow: 0.3 },
  );
  pieces.push({
    clip: "jukebox",
    rate: 0.7,
    x: S1.x + 265,
    y: S1.y + 20,
    w: 290,
    h: 218,
    rot: 0.11,
    land: at(4.5),
    seed: 3,
  });
  pieces.push({
    clip: "singer",
    rate: 0.62,
    x: S1.x - 10,
    y: S1.y - 200,
    w: 560,
    h: 420,
    rot: -0.05,
    land: at(3),
    seed: 1,
  });
  const your = {
    text: "Your",
    x: S1.x - 300,
    y: S1.y + 290,
    size: 230,
    mode: "wipe",
    from: at(5.5),
    to: at(6.5),
  } as const;
  words.push(your);
  to(your.x - 12, your.y + 34, [1, 0.02], at(5.5), { e: 0.55 });
  add(swoosh(pen.x, pen.y, 360, 26), at(5.5), at(6.5), { e: 0.45 });
  pieces.push({
    clip: "spin",
    rate: 0.9,
    x: -20,
    y: 1590,
    w: 250,
    h: 188,
    rot: 0.08,
    land: at(6),
    seed: 15,
  });
  to(-60, 1500, [1, 0.6], at(7), { e: 0.5 });

  pieces.push({
    clip: "slowdance",
    rate: 0.6,
    x: S2.x - 235,
    y: S2.y + 20,
    w: 300,
    h: 225,
    rot: -0.1,
    land: at(8.5),
    seed: 5,
  });
  pieces.push({
    clip: "twirl",
    rate: 0.7,
    x: S2.x + 10,
    y: S2.y - 210,
    w: 560,
    h: 420,
    rot: 0.055,
    land: at(7),
    seed: 4,
  });
  loop(S2.x - 20, S2.y - 180, 150, 46, Math.PI * 1.05, -TAU * 1.75, at(9.25), {
    at: at(8),
    tilt: -0.08,
    grow: 0.08,
    dy: 120,
    seed: 4,
  });
  words.push({
    text: "year",
    x: S2.x + 290,
    y: S2.y + 330,
    size: 230,
    mode: "pop",
    right: true,
    t: at(9.5),
  });
  loop(S2.x + 130, S2.y + 252, 215, 118, Math.PI * 0.85, TAU * 1.08, at(10.75), {
    at: at(9.5),
    tilt: -0.06,
    grow: 0.1,
    seed: 6,
  });

  pieces.push({
    clip: "cymbal",
    rate: 0.8,
    x: -170,
    y: 2400,
    w: 250,
    h: 188,
    rot: -0.07,
    land: at(10),
    seed: 14,
  });
  pieces.push({
    clip: "couple",
    rate: 0.5,
    x: S3.x + 330,
    y: S3.y - 330,
    w: 290,
    h: 218,
    rot: 0.1,
    land: at(12.5),
    seed: 8,
  });
  pieces.push({
    clip: "sax",
    rate: 0.55,
    x: S3.x + 40,
    y: S3.y - 190,
    w: 540,
    h: 405,
    rot: -0.04,
    land: at(11),
    seed: 7,
  });
  const corner: Vec = [S3.x - 270, S3.y - 410];
  to(corner[0], corner[1], [-0.25, 1], at(12), { e: 0.5, k: 0.45 });
  add(
    spline(
      [
        corner,
        [S3.x - 268, S3.y - 250],
        [S3.x - 262, S3.y - 90],
        [S3.x - 300, S3.y + 10],
        [S3.x - 330, S3.y + 60],
      ],
      12,
    ),
    at(12),
    at(12.8),
    { e: 0.5 },
  );
  words.push({ text: "in", x: S3.x - 300, y: S3.y + 165, size: 140, mode: "pop", t: at(13) });
  const music = {
    text: "music.",
    x: S3.x - 300,
    y: S3.y + 390,
    size: 230,
    mode: "wipe",
    from: at(13.5),
    to: at(14.1),
  } as const;
  words.push(music);
  to(music.x - 14, music.y + 30, [1, 0.03], at(13.5), { e: 0.5, k: 0.5 });
  add(swoosh(pen.x, pen.y, 580, 20), at(13.5), at(14.1), { e: 0.4 });
  const tip: Vec = [S3.x + 150, S3.y - 180];
  add(
    bezier([pen.x, pen.y], [pen.x + 90, pen.y - 120], [tip[0] + 110, tip[1] + 170], tip, 50),
    at(14.1),
    at(14.65),
    { e: 0.55 },
  );
  const angle = Math.atan2(pen.dy, pen.dx) + Math.PI;
  const barb = (a: number): Vec => [tip[0] + Math.cos(a) * 80, tip[1] + Math.sin(a) * 80];
  add([tip, barb(angle + 0.5), tip, barb(angle - 0.5)], at(14.65), at(15), { e: 0.3, slow: 0.2 });
  loop(S3.x + 300, S3.y + 330, 110, 100, -Math.PI * 0.6, TAU * 1.35, at(15.85), {
    at: at(15.3),
    grow: 0.5,
    tilt: 0.2,
    seed: 9,
  });

  const months =
    summary.months.length > 1
      ? summary.months
      : [
          { month: "", plays: 0 },
          { month: "", plays: 0 },
        ];
  const values = months.map((month) => month.plays);
  const low = Math.min(...values);
  const range = Math.max(...values) - low;
  const top = S3.y + 900;
  const gap = 190;
  const chart = values.map((value, m): Vec => [
    range ? -225 + (450 * (value - low)) / range : 0,
    top + m * gap,
  ]);
  to(chart[0][0], chart[0][1], [0.2, 1], at(16.5), { e: 0.25, k: 0.5 });
  add(spline(chart, 24), at(16.5), at(22), { e: 0.12, slow: 0.4, wob: 0.8, dyn: true });
  const span = (chart.length - 1) / 11;
  for (const [m, i, side] of [
    [1, 0, 1],
    [5, 1, -1],
    [7, 2, 1],
    [9, 3, -1],
  ] as const) {
    const cover = opening.covers[i];
    const row = chart[Math.round(m * span)];
    if (cover?.image.naturalWidth)
      snaps.push({
        image: cover.image,
        slot: cover.box,
        x: row[0] + side * 330,
        y: row[1] - 10,
        size: 330,
        rot: side * 0.07 + (i % 2 ? 0.03 : -0.02),
        land: at(16.5 + (m * span) / 2 - 1),
      });
  }
  const letters = months.flatMap(({ month }, m) => {
    const letter = MONTHS[Number(month.slice(5, 7)) - 1];
    return letter ? [{ letter, x: -640, y: chart[m][1] + 18, t: at(16.7 + m * 0.12) }] : [];
  });

  const plays = {
    value: summary.totalPlays.toLocaleString(),
    label: summary.totalPlays === 1 ? "play" : "plays",
    y: top + (chart.length - 1) * gap + 360,
    t: at(22),
  };
  loop(0, plays.y - 118, 380, 235, -Math.PI * 0.6, TAU * 1.06, at(23.25), {
    at: at(22),
    tilt: 0.04,
    grow: 0.08,
    seed: 12,
  });

  const slide = { x: -360, y: plays.y + 260 };
  const glyphs = opening.year.flatMap((line) => {
    const k = line.size / 1000;
    let x = line.x;
    return [...line.text].flatMap((digit) => {
      const glyph = WRAPPED_DIGITS[digit];
      if (!glyph) return [];
      const origin = x;
      x += glyph.advance * k + line.spacing;
      return [
        contourPoints(glyph.path).map((contour) =>
          contour.map(([gx, gy]): Vec => [slide.x + origin + gx * k, slide.y + line.y - gy * k]),
        ),
      ];
    });
  });
  const nearest = (contour: Vec[]) => {
    let best = 0;
    contour.forEach(([x, y], i) => {
      if (
        Math.hypot(x - pen.x, y - pen.y) <
        Math.hypot(contour[best][0] - pen.x, contour[best][1] - pen.y)
      )
        best = i;
    });
    const turned = [...contour.slice(best), ...contour.slice(1, best + 1)];
    return [...turned, ...turned.slice(1, 5)];
  };
  glyphs.forEach((contours, g) => {
    const lengths = contours.map((contour) => contour.length);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let share = 0;
    contours.forEach((contour, j) => {
      const s0 = 24 + g + share;
      share += lengths[j] / total;
      const s1 = 24 + g + share;
      const path = nearest(contour);
      const hop = g === 0 && j === 0 ? 0.14 : 0.08;
      if (g === 0 && j === 0)
        to(
          path[0][0],
          path[0][1],
          [path[2][0] - path[0][0], path[2][1] - path[0][1]],
          at(s0 + hop),
          { e: 0.5, k: 0.35 },
        );
      else add([[pen.x, pen.y], path[0]], at(s0), at(s0 + hop), { up: true, e: 1 });
      add(path, at(s0 + hop), at(s1) - 0.01, { e: 0.25, slow: 0.5, wob: 0.6 });
    });
  });
  const flood = { x: pen.x, y: pen.y, t: at(28) };

  const speeds = points.map((point, i) =>
    i && !point.up
      ? Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y) /
        Math.max(1e-3, point.t - points[i - 1].t)
      : 0,
  );
  const sorted = speeds.filter(Boolean).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 1;
  const pressure = speeds.map((speed) => clamp(1.28 - (0.42 * speed) / median, 0.72, 1.3));
  points.forEach((point, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(points.length - 1, i + 4); j++, count++)
      sum += pressure[j];
    point.w = sum / count;
  });

  const key = (
    t: number,
    x: number,
    y: number,
    z: number,
    r: number,
    curve: keyof typeof ease,
    dip = 0,
  ) => ({ t, x, y, z, r, curve, dip });
  const cameras = [
    key(0, 0, 20, 1.42, 0, "inOut"),
    key(at(0), 0, 10, 1.2, 0, "out"),
    key(at(2), 0, 70, 1.12, 0, "inOut"),
    key(at(4), S1.x + 20, S1.y - 90, 1.1, -0.014, "inOut", 0.36),
    key(at(6.5), S1.x + 30, S1.y + 90, 1.13, -0.014, "inOut"),
    key(at(8), S2.x - 20, S2.y - 90, 1.1, 0.014, "inOut", 0.36),
    key(at(10.75), S2.x - 30, S2.y + 90, 1.13, 0.014, "inOut"),
    key(at(12), S3.x + 10, S3.y - 90, 1.1, -0.01, "inOut", 0.36),
    key(at(14.5), S3.x + 40, S3.y + 80, 1.12, -0.01, "inOut"),
    key(at(16), S3.x + 120, S3.y + 160, 1.2, 0, "in"),
    key(at(16.85), 0, 1880, 0.305, 0, "expoOut"),
    key(at(17.6), 0, 2150, 0.32, 0, "linear"),
    key(at(19), 0, top + 1030, 0.5, 0, "inOut"),
    key(at(21.4), 0, top + 1110, 0.52, 0, "inOut"),
    key(at(22.3), 0, plays.y - 130, 0.62, 0, "inOut"),
    key(at(23.25), 0, plays.y - 110, 0.68, 0, "linear"),
    key(at(24.3), 0, slide.y + 640, 1.035, 0, "inOut"),
    key(at(28), 0, slide.y + 640, 1, 0, "out"),
  ];
  const FOLLOW = [
    [1.5, 0, 0],
    [2.6, 0.85, 0.85],
    [15.2, 0.85, 0.85],
    [16, 0.3, 0.3],
    [16.3, 0, 0],
    [23.2, 0, 0],
    [23.6, 0.5, 0.85],
    [24.2, 0.5, 0.85],
    [24.9, 0, 0],
  ] as const;

  const head = (t: number) => {
    if (t < points[0].t) return -1;
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (points[middle].t <= t) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const penAt = (t: number, stretch: number) => {
    const i = head(t);
    if (i < 0) return { x: points[0].x, y: points[0].y, up: false };
    const a = points[i];
    const b = points[Math.min(points.length - 1, i + 1)];
    const u = b.t > a.t ? clamp((t - a.t) / (b.t - a.t)) : 0;
    return {
      x: lerp(a.dyn ? a.x * stretch : a.x, b.dyn ? b.x * stretch : b.x, u),
      y: lerp(a.y, b.y, u),
      up: b.up && u > 0,
    };
  };
  const follow = (t: number) => {
    const b = grid.since(t);
    if (b <= FOLLOW[0][0]) return [0, 0] as const;
    for (let i = 1; i < FOLLOW.length; i++)
      if (b < FOLLOW[i][0]) {
        const u = ease.inOut((b - FOLLOW[i - 1][0]) / (FOLLOW[i][0] - FOLLOW[i - 1][0]));
        return [
          lerp(FOLLOW[i - 1][1], FOLLOW[i][1], u),
          lerp(FOLLOW[i - 1][2], FOLLOW[i][2], u),
        ] as const;
      }
    return [0, 0] as const;
  };
  const camera = (t: number) => {
    if (t <= cameras[0].t) return cameras[0];
    for (let i = 1; i < cameras.length; i++) {
      if (t >= cameras[i].t) continue;
      const a = cameras[i - 1];
      const b = cameras[i];
      const e = ease[b.curve]((t - a.t) / (b.t - a.t));
      const z =
        Math.exp(lerp(Math.log(a.z), Math.log(b.z), e)) * (1 - b.dip * Math.sin(Math.PI * e));
      let x = lerp(a.x, b.x, e);
      let y = lerp(a.y, b.y, e);
      const [fx, fy] = follow(t);
      if (fx || fy) {
        let px = 0;
        let py = 0;
        let sum = 0;
        for (let j = -24; j <= 10; j++) {
          const d = j * 0.05;
          const weight = Math.exp(-((d + 0.1) ** 2) / 0.32);
          const q = penAt(t + d, 1);
          px += q.x * weight;
          py += q.y * weight;
          sum += weight;
        }
        x = lerp(x, px / sum, fx);
        y = lerp(y, py / sum + 40, fy);
      }
      return { x, y, z, r: lerp(a.r, b.r, e) };
    }
    return cameras[cameras.length - 1];
  };

  const torn = new Map<string, Path2D>();
  const tornPath = (w: number, h: number, seed: number, jag: number, grow = 0) => {
    const id = `${w}:${h}:${seed}:${grow}`;
    const cached = torn.get(id);
    if (cached) return cached;
    const next = random(seed * 97 + grow);
    const W = w / 2 + grow;
    const H = h / 2 + grow;
    const corners = [
      [-W, -H],
      [W, -H],
      [W, H],
      [-W, H],
    ] as const;
    const path = new Path2D();
    corners.forEach(([ax, ay], c) => {
      const [bx, by] = corners[(c + 1) % 4];
      const length = Math.hypot(bx - ax, by - ay);
      const n = Math.ceil(length / 11);
      const nx = (by - ay) / length;
      const ny = -(bx - ax) / length;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        const d = (next() - 0.5) * jag + (next() < 0.06 ? -jag * 1.6 * next() : 0);
        const x = ax + (bx - ax) * u + nx * d;
        const y = ay + (by - ay) * u + ny * d;
        if (c === 0 && i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
    });
    path.closePath();
    torn.set(id, path);
    return path;
  };

  const prepare = (piece: Piece, t: number) => {
    if (!footage || piece.still || piece.video || t < piece.land - period * 2) return;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = footage;
    video.currentTime = CLIPS[piece.clip][0] / FOOTAGE_FPS;
    video.playbackRate = piece.rate;
    piece.video = video;
  };
  const release = (video: HTMLVideoElement) => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
  const frameOf = (piece: Piece, t: number) => {
    const video = piece.video;
    if (piece.still || !video) return piece.still ?? null;
    if (t >= piece.land && video.paused && !video.ended) {
      video.playbackRate = piece.rate;
      video.play().catch(() => {});
    }
    const [start, length] = CLIPS[piece.clip];
    if (
      video.readyState >= 2 &&
      (video.ended || video.currentTime >= (start + length) / FOOTAGE_FPS)
    ) {
      const still = document.createElement("canvas");
      still.width = video.videoWidth;
      still.height = video.videoHeight;
      still.getContext("2d")?.drawImage(video, 0, 0);
      piece.still = still;
      piece.video = undefined;
      release(video);
      return still;
    }
    return video.readyState >= 2 ? video : null;
  };

  const grain = grainFrames();

  const drawTrail = (
    context: CanvasRenderingContext2D,
    t: number,
    z: number,
    stretch: number,
    view: { x0: number; x1: number; y0: number; y1: number },
    {
      from = 0,
      to: end = Infinity,
      grow,
    }: { from?: number; to?: number; grow?: (index: number) => number } = {},
  ) => {
    const widen = grow ?? (() => 1);
    const last = Math.min(head(t), end - 1);
    if (last < from + 1) return;
    const base = Math.max(5.2, 2.3 / z);
    const X = (point: Point) => (point.dyn ? point.x * stretch : point.x);
    context.save();
    context.strokeStyle = "#fff";
    context.lineCap = context.lineJoin = "round";
    for (let i = from + 1; i <= last;) {
      const stop = Math.min(last, i + 7);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let w = 0;
      for (let j = i - 1; j <= stop; j++) {
        const x = X(points[j]);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, points[j].y);
        maxY = Math.max(maxY, points[j].y);
        w += points[j].w;
      }
      if (maxX > view.x0 && minX < view.x1 && maxY > view.y0 && minY < view.y1) {
        context.lineWidth = (base * widen(i) * w) / (stop - i + 2);
        context.beginPath();
        context.moveTo(X(points[i - 1]), points[i - 1].y);
        for (let j = i; j <= stop; j++)
          if (points[j].up) context.moveTo(X(points[j]), points[j].y);
          else context.lineTo(X(points[j]), points[j].y);
        context.stroke();
      }
      i = stop + 1;
    }
    const current = penAt(t, stretch);
    if (last + 1 < Math.min(points.length, end) && !points[last + 1].up) {
      context.lineWidth = base * widen(last) * points[last].w;
      context.beginPath();
      context.moveTo(X(points[last]), points[last].y);
      context.lineTo(current.x, current.y);
      context.stroke();
    }
    context.restore();
  };

  const drawTip = (context: CanvasRenderingContext2D, t: number, z: number, stretch: number) => {
    const fade = clamp((points[points.length - 1].t + 0.15 - t) / 0.15);
    if (t < points[0].t || fade <= 0) return;
    const current = penAt(t, stretch);
    const r = Math.max(5, 2.6 / z);
    context.save();
    context.globalAlpha = fade;
    const glow = context.createRadialGradient(current.x, current.y, 0, current.x, current.y, r * 5);
    glow.addColorStop(0, "rgba(255,255,255,0.35)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = glow;
    context.beginPath();
    context.arc(current.x, current.y, r * 5, 0, TAU);
    context.fill();
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(current.x, current.y, r * (current.up ? 0.7 : 1), 0, TAU);
    context.fill();
    context.restore();
  };

  const swellAt = (t: number) => clamp((t - at(0)) / (at(1) - at(0)));
  const toLogo = (context: CanvasRenderingContext2D) => {
    context.translate(LOGO.x, LOGO.y);
    context.scale(LOGO.scale, LOGO.scale);
  };

  const drawPiece = (context: CanvasRenderingContext2D, piece: Piece, t: number) => {
    if (t < piece.land - 0.02) return;
    const k = clamp((t - piece.land) / (period * 0.5));
    const s = lerp(1.1, 1, ease.outBack(k));
    context.save();
    context.globalAlpha = clamp(k * 14);
    context.translate(piece.x, piece.y + (1 - ease.out(k)) * -18);
    context.rotate(piece.rot + (1 - ease.out(k)) * 0.09 * Math.sign(piece.rot));
    context.scale(s, s);
    context.fillStyle = PAPER;
    context.fill(tornPath(piece.w, piece.h, piece.seed, 7, 9));
    context.clip(tornPath(piece.w, piece.h, piece.seed + 40, 3));
    const frame = frameOf(piece, t);
    if (frame)
      drawCover(context, frame, { x: -piece.w / 2, y: -piece.h / 2, w: piece.w, h: piece.h });
    context.restore();
  };

  const drawWord = (context: CanvasRenderingContext2D, word: Word, t: number, penX: number) => {
    context.save();
    if (word.mode === "wipe") {
      if (t >= word.from) {
        context.font = `900 ${word.size}px ${WRAPPED_DISPLAY}`;
        context.letterSpacing = `${-0.03 * word.size}px`;
        const width = context.measureText(word.text).width;
        const reveal = t >= word.to ? width + 40 : clamp(penX - word.x + 10, 0, width + 40);
        context.beginPath();
        context.rect(word.x - 20, word.y - word.size, reveal + 20, word.size * 1.3);
        context.clip();
        text(context, word.text, word.x, word.y, word.size);
      }
    } else {
      const k = clamp((t - word.t) / (period * 0.4));
      if (k > 0) {
        const e = ease.outBack(k);
        context.globalAlpha = clamp(k * 3);
        context.translate(word.x, word.y);
        context.scale(lerp(0.86, 1, e), lerp(0.86, 1, e));
        context.translate(0, (1 - e) * 30);
        text(context, word.text, 0, 0, word.size, { align: word.right ? "right" : "left" });
      }
    }
    context.restore();
  };

  const drawSnap = (context: CanvasRenderingContext2D, snap: Snap, t: number, scale: number) => {
    if (t < snap.land - 0.02) return;
    const k = clamp((t - snap.land) / (period * 0.6));
    const z = lerp(1.3, 1, ease.outBack(k)) * scale;
    const half = snap.size / 2;
    context.save();
    context.globalAlpha = clamp(k * 5);
    context.translate(snap.x, snap.y);
    context.rotate(snap.rot + (1 - ease.out(k)) * 0.22 * Math.sign(snap.rot));
    context.scale(z, z);
    context.fillStyle = PAPER;
    context.fillRect(-half - 14, -half - 14, snap.size + 28, snap.size + 60);
    drawCover(context, snap.image, { x: -half, y: -half, w: snap.size, h: snap.size });
    context.restore();
  };

  const drawYear = (context: CanvasRenderingContext2D) => {
    context.fillStyle = opening.field;
    context.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
    for (const line of opening.year) drawLine(context, line);
  };

  const draw = (context: CanvasRenderingContext2D, t: number) => {
    for (const piece of pieces) prepare(piece, t);
    const settled = t >= at(28);
    const scale = context.canvas.width / REEL_WIDTH;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = "#000";
    context.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);
    const view = camera(t);
    const kick = settled
      ? 1
      : 1 +
        0.012 * grid.pulse(t, 0.1) +
        (t > at(16) && t < at(17) ? 0.05 * grid.pulse(t, 0.25) : 0);
    const z = view.z * kick;
    const chartPulse = grid.pulse(t, 0.16);
    const stretch = 1 + 0.2 * chartPulse * clamp((t - at(16.5)) / period);
    const reach = { x: REEL_WIDTH / 2 / z + 200, y: REEL_HEIGHT / 2 / z + 200 };
    const bounds = {
      x0: view.x - reach.x,
      x1: view.x + reach.x,
      y0: view.y - reach.y,
      y1: view.y + reach.y,
    };
    const current = penAt(t, stretch);

    context.save();
    context.translate(REEL_WIDTH / 2, REEL_HEIGHT / 2);
    context.rotate(view.r);
    context.scale(z, z);
    context.translate(-view.x, -view.y);

    const swell = swellAt(t);
    const fill = ease.inOut(clamp((swell - 0.7) / 0.3));
    if (fill > 0) {
      const s = 1 + 0.025 * (swell >= 1 && t < at(4) ? grid.pulse(t, 0.14) : 0);
      context.save();
      context.scale(s, s);
      toLogo(context);
      context.globalAlpha = fill;
      context.fillStyle = "#fff";
      context.fill(logo);
      context.restore();
    }
    for (const piece of pieces) drawPiece(context, piece, t);
    for (const word of words) drawWord(context, word, t, current.x);
    for (const letter of letters) {
      const k = clamp((t - letter.t) / (period * 0.5));
      if (k <= 0) continue;
      context.globalAlpha = 0.5 * k;
      text(context, letter.letter, letter.x, letter.y, 54, {
        family: WRAPPED_TEXT,
        weight: 600,
        spacing: 0,
      });
      context.globalAlpha = 1;
    }
    snaps.forEach((snap, i) => {
      if (t < at(29 + i * 0.5)) drawSnap(context, snap, t, 1 + 0.025 * chartPulse);
    });
    const shown = clamp((t - plays.t) / (period * 0.45));
    if (shown > 0) {
      context.save();
      context.globalAlpha = clamp(shown * 3);
      context.translate(0, plays.y);
      const e = lerp(0.8, 1, ease.outBack(shown));
      context.scale(e, e);
      context.font = `900 340px ${WRAPPED_DISPLAY}`;
      context.letterSpacing = "-10.2px";
      const size = Math.min(340, (900 / context.measureText(plays.value).width) * 340);
      text(context, plays.value, 0, 0, size, { align: "center" });
      text(context, plays.label, 0, 96, 72, {
        family: WRAPPED_TEXT,
        weight: 700,
        spacing: 0,
        align: "center",
      });
      context.restore();
    }
    if (swell > 0 && swell < 1) {
      const band = logoPoints * 0.45;
      const front = (0.5 - 0.5 * Math.cos(Math.PI * swell)) * (logoPoints + band);
      context.save();
      toLogo(context);
      context.clip(logo);
      context.scale(1 / LOGO.scale, 1 / LOGO.scale);
      context.translate(-LOGO.x, -LOGO.y);
      drawTrail(context, t, z, stretch, bounds, {
        to: logoPoints,
        grow: (i) => 1 + 22 * ease.inOut(clamp((front - i) / band)),
      });
      context.restore();
    }
    drawTrail(context, t, z, stretch, bounds, { to: swell >= 1 ? 0 : logoPoints });
    drawTrail(context, t, z, stretch, bounds, { from: logoPoints - 1 });
    if (t >= flood.t) {
      const k = ease.out(clamp((t - flood.t) / (period * 0.7)));
      context.save();
      context.beginPath();
      context.arc(flood.x, flood.y, k * 1700, 0, TAU);
      context.clip();
      context.translate(slide.x, slide.y);
      drawYear(context);
      context.restore();
    }
    if (!settled) drawTip(context, t, z, stretch);
    context.restore();

    if (settled) {
      snaps.forEach((snap, i) => {
        const start = at(29 + i * 0.5);
        const slot = snap.slot;
        if (t < start) return;
        const k = clamp((t - start) / (period * 0.8));
        const e = ease.expoOut(k);
        const from = { x: 360 + (i % 2 ? -1 : 1) * 120, y: -380 };
        const w = lerp(snap.size, slot.w, e);
        const h = lerp(snap.size, slot.h, e);
        const frame = 1 - clamp((k - 0.55) / 0.3);
        context.save();
        context.beginPath();
        context.rect(lerp(-200, slot.x, clamp(k * 1.6)), -400, 2000, 2400);
        context.clip();
        context.translate(
          lerp(from.x, slot.x + slot.w / 2, e),
          lerp(from.y, slot.y + slot.h / 2, e),
        );
        context.rotate(snap.rot * (1 - e));
        if (frame > 0) {
          context.globalAlpha = frame;
          context.fillStyle = PAPER;
          context.fillRect(-w / 2 - 14, -h / 2 - 14, w + 28, h + 60);
          context.globalAlpha = 1;
        }
        drawCover(context, snap.image, { x: -w / 2, y: -h / 2, w, h });
        context.restore();
      });
      const k = clamp((t - at(31)) / (period * 0.6));
      if (k > 0) {
        context.save();
        context.translate(0, (1 - ease.out(k)) * 24);
        for (const line of opening.foot) drawLine(context, line, ease.out(k));
        context.restore();
      }
    }
    const amount =
      t < at(16) ? 0.11 : t < at(28) ? 0.07 : 0.07 * (1 - clamp((t - at(28)) / (period * 3)));
    if (amount > 0.002) {
      context.save();
      context.globalAlpha = amount;
      context.globalCompositeOperation = "overlay";
      context.drawImage(grain[Math.floor(t * 24) % grain.length], 0, 0, REEL_WIDTH, REEL_HEIGHT);
      context.restore();
    }
  };

  return {
    draw,
    drop: flood.t,
    end: at(35),
    dispose: () => {
      for (const piece of pieces) if (piece.video) release(piece.video);
    },
  };
}
