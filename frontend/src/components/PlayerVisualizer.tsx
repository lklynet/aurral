import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useMediaQuery } from "../hooks/useMediaQuery.ts";
import { useThemeDocument } from "../hooks/useThemeDocument.ts";
import { queryKeys } from "../queryClient";
import { visualizerClient } from "../utils/api/clients/visualizer.ts";
import { extractArtworkAccent } from "../utils/imageColors.ts";
import { hexToOklch, oklchToHex, type HexColor } from "../utils/themeColor.ts";

export type VisualizerMode = "chill" | "beat" | "off";
export type VisualizerScene = "minimal" | "tabbed" | "split";

type PlayerTrack = NonNullable<ReturnType<typeof useAudioQueue>["currentTrack"]>;
type Goo = { x: number; y: number; r: number };

const MAX_GOO = 8;
const FRAME_MS = 1000 / 30;
const PULSE_DECAY_S = 0.18;
const BEAT_SPEED = 1.8;
const GLOW_BLEND_S = 0.3;

const rise = (t: number, speed: number, phase: number) => 0.5 + 0.5 * Math.sin(t * speed + phase);

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 size;
uniform vec3 goo[${MAX_GOO}];
uniform int count;
uniform float pulse;
uniform vec3 edge;
uniform vec3 side;
const vec3 CORE = vec3(243.0, 229.0, 197.0) / 255.0;
void main() {
  vec2 uv = vec2(gl_FragCoord.x / size.x, 1.0 - gl_FragCoord.y / size.y);
  float aspect = size.x / size.y;
  float scale = aspect < 1.0 ? 0.7 : 1.0;
  float field = 0.0;
  for (int i = 0; i < ${MAX_GOO}; i++) {
    if (i >= count) break;
    vec2 d = vec2((uv.x - goo[i].x) * aspect, uv.y - goo[i].y);
    float r = goo[i].z * scale;
    field += r * r / (dot(d, d) + 1e-4);
  }
  float body = smoothstep(0.85, 1.15, field);
  float halo = clamp(field / 0.7, 0.0, 1.0) * (0.22 + pulse * 0.12);
  float alpha = max(body * (0.78 + pulse * 0.2), halo) * 0.7;
  float heat = clamp(smoothstep(0.0, 1.0, 1.0 - 1.0 / max(field, 1.0)) + pulse * 0.25, 0.0, 1.0);
  vec3 base = mix(edge, side, (uv.x * 0.6 + uv.y * 0.4) * 0.5);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  gl_FragColor = vec4(mix(base, CORE, heat) * alpha + noise * min(1.0, alpha * 8.0) / 255.0, 1.0);
}`;

const SCENES: Record<VisualizerScene, (t: number, pulse: number) => Goo[]> = {
  minimal: (t, p) => [
    { x: 0.5, y: 1.22 - p * 0.06, r: 0.42 + p * 0.04 },
    {
      x: 0.32 + 0.06 * Math.sin(t * 0.21),
      y: 0.86 - 0.32 * rise(t, 0.17, 0) - p * 0.08,
      r: 0.13 * (1 + p * 0.3),
    },
    {
      x: 0.62 + 0.05 * Math.sin(t * 0.19 + 2),
      y: 0.9 - 0.42 * rise(t, 0.13, 1.3) - p * 0.05,
      r: 0.11 * (1 + p * 0.35),
    },
    {
      x: 0.48 + 0.08 * Math.sin(t * 0.11 + 4),
      y: 0.82 - 0.24 * rise(t, 0.23, 3) - p * 0.1,
      r: 0.09 * (1 + p * 0.4),
    },
    {
      x: 0.76 + 0.04 * Math.sin(t * 0.27),
      y: 0.95 - 0.2 * rise(t, 0.19, 5) - p * 0.06,
      r: 0.08 * (1 + p * 0.3),
    },
    {
      x: 0.2 + 0.04 * Math.sin(t * 0.3 + 1),
      y: 0.97 - 0.16 * rise(t, 0.21, 2) - p * 0.07,
      r: 0.08 * (1 + p * 0.3),
    },
  ],
  tabbed: (t, p) => [
    { x: -0.02, y: -0.08, r: 0.5 + p * 0.06 },
    {
      x: 0.2 + 0.06 * Math.sin(t * 0.2),
      y: 0.32 + 0.1 * Math.sin(t * 0.16 + 1),
      r: 0.12 * (1 + p * 0.35),
    },
    {
      x: 0.1 + 0.05 * Math.sin(t * 0.14 + 3),
      y: 0.5 + 0.12 * Math.sin(t * 0.12) + p * 0.04,
      r: 0.09 * (1 + p * 0.4),
    },
    {
      x: 0.34 + 0.05 * Math.sin(t * 0.18 + 2) + p * 0.03,
      y: 0.12 + 0.06 * Math.sin(t * 0.22 + 4),
      r: 0.08 * (1 + p * 0.4),
    },
  ],
  split: (t, p) => [
    { x: 0.5, y: 0.4, r: 0.22 + p * 0.03 },
    ...[0, 1, 2, 3, 4].map((i) => {
      const angle = t * (0.07 + i * 0.012) + i * 1.26;
      const reach = 0.2 + 0.05 * Math.sin(t * 0.17 + i) + p * 0.05;
      return {
        x: 0.5 + Math.cos(angle) * reach * 0.62,
        y: 0.4 + Math.sin(angle) * reach,
        r: (0.08 + 0.02 * Math.sin(t * 0.2 + i * 2)) * (1 + p * 0.3),
      };
    }),
  ],
};

function createGooRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: "low-power",
  });
  const program = gl?.createProgram();
  if (!gl || !program) return null;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX_SHADER],
    [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = {
    size: gl.getUniformLocation(program, "size"),
    goo: gl.getUniformLocation(program, "goo"),
    count: gl.getUniformLocation(program, "count"),
    pulse: gl.getUniformLocation(program, "pulse"),
    edge: gl.getUniformLocation(program, "edge"),
    side: gl.getUniformLocation(program, "side"),
  };
  const packed = new Float32Array(MAX_GOO * 3);
  return {
    resize() {
      const density = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * density));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * density));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.size, canvas.width, canvas.height);
    },
    draw(goo: Goo[], pulse: number, glow: Float32Array) {
      const shown = goo.slice(0, MAX_GOO);
      shown.forEach(({ x, y, r }, i) => packed.set([x, y, r], i * 3));
      gl.uniform3fv(uniforms.goo, packed);
      gl.uniform1i(uniforms.count, shown.length);
      gl.uniform1f(uniforms.pulse, pulse);
      gl.uniform3fv(uniforms.edge, glow.subarray(0, 3));
      gl.uniform3fv(uniforms.side, glow.subarray(3));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

const channels = (hex: HexColor) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);

function glowColors(accent: HexColor | null) {
  const tone = accent && hexToOklch(accent);
  const edge = tone ? oklchToHex({ l: 0.6, c: Math.min(tone.c, 0.14), h: tone.h }) : "#a8a598";
  const side = tone ? oklchToHex({ l: 0.75, c: Math.min(tone.c, 0.15), h: tone.h }) : "#d3c8b0";
  return Float32Array.from([...channels(edge), ...channels(side)]);
}

function useArtworkAccent(src: string | null | undefined) {
  const { matchArtwork } = useThemeDocument();
  const artwork = matchArtwork ? src || null : null;
  const [accent, setAccent] = useState<HexColor | null>(null);
  useEffect(() => {
    if (!artwork) return undefined;
    let cancelled = false;
    void extractArtworkAccent(artwork).then((color) => {
      if (!cancelled) setAccent(color);
    });
    return () => {
      cancelled = true;
    };
  }, [artwork]);
  return artwork ? accent : null;
}

function useTrackPulse(track: PlayerTrack, enabled: boolean) {
  const { libraryAlbumId, libraryTrackId } = track;
  const library = libraryAlbumId != null && libraryTrackId != null;
  const { data } = useQuery({
    queryKey: queryKeys.trackPulse(libraryAlbumId, libraryTrackId),
    enabled: enabled && library,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const { pulse } = await parseResponse(
        visualizerClient.pulse.$get(
          {
            query: {
              libraryAlbumId: String(libraryAlbumId),
              libraryTrackId: String(libraryTrackId),
            },
          },
          { init: { signal } },
        ),
      );
      return (
        pulse && {
          fps: pulse.fps,
          levels: Uint8Array.from(atob(pulse.levels), (char) => char.charCodeAt(0)),
        }
      );
    },
  });
  return enabled && library ? (data ?? null) : null;
}

export default function PlayerVisualizer({
  mode,
  scene,
  track,
}: {
  mode: VisualizerMode;
  scene: VisualizerScene;
  track: PlayerTrack;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef(12);
  const glowRef = useRef<Float32Array | null>(null);
  const { isPlaying, getPosition } = useAudioQueue();
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pulse = useTrackPulse(track, mode === "beat");
  const accent = useArtworkAccent(track.artwork);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = canvas && mode !== "off" ? createGooRenderer(canvas) : null;
    if (!canvas || !renderer) return undefined;
    renderer.resize();
    let level = 0;
    let last = 0;
    let frame = 0;
    const animate = isPlaying && !reduceMotion;
    const target = glowColors(accent);
    const glow = !reduceMotion && glowRef.current ? glowRef.current : target.slice();
    glowRef.current = glow;
    const settled = () => glow.every((value, i) => Math.abs((target[i] ?? value) - value) < 0.002);
    const paint = (seconds: number) => {
      if (pulse) {
        const raw = (pulse.levels[Math.floor(getPosition() * pulse.fps)] ?? 0) / 255;
        level = Math.max(raw * raw, level * Math.exp(-seconds / PULSE_DECAY_S));
      }
      if (animate) clockRef.current += seconds * (pulse ? BEAT_SPEED : 1);
      const blend = 1 - Math.exp(-seconds / GLOW_BLEND_S);
      glow.set(glow.map((value, i) => value + ((target[i] ?? value) - value) * blend));
      renderer.draw(SCENES[scene](clockRef.current, level), level, glow);
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (last && now - last < FRAME_MS) return;
      paint(last ? Math.min(now - last, 100) / 1000 : 0);
      last = now;
      if (!animate && settled()) cancelAnimationFrame(frame);
    };
    const observer = new ResizeObserver(() => {
      renderer.resize();
      if (!animate) paint(0);
    });
    observer.observe(canvas);
    if (animate || !settled()) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.dispose();
    };
  }, [accent, getPosition, isPlaying, mode, pulse, reduceMotion, scene]);

  return mode === "off" ? null : (
    <canvas ref={canvasRef} className="fullscreen-player__visualizer" aria-hidden="true" />
  );
}
