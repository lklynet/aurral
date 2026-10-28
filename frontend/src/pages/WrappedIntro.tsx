import { useEffect, useRef, type RefObject } from "react";
import type { WrappedRecap } from "../hooks/useWrapped.ts";
import {
  WRAPPED_DISPLAY,
  loadWrappedFonts,
  loadWrappedImage,
  loadWrappedLogo,
  wrappedCovers,
} from "../utils/wrappedShare";
import footage from "./wrapped-intro.mp4?url";

const WIDTH = 540;
const HEIGHT = 960;
const LOGO_END = 6.2;
const WORDS = [
  ["Your", 6.2, 0.75, 46],
  ["year", 6.95, 0.75, 50],
  ["in", 7.7, 0.75, 80],
  ["music.", 8.45, 0.85, 37],
] as const;
const FLIP = 12.6;
const FLICKER = [13.4, 14.15] as const;
const GRAIN = [6.2, 14.2] as const;
const PLATE = 14.2;
const PUSH = 17.3;
const REVEAL = 19.7;
const END = 21.9;

const VERTEX = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FRAGMENT = `precision highp float;
uniform sampler2D s;uniform vec2 r;uniform vec2 c;uniform float z;uniform float g;uniform float n;
void main(){
  vec2 q=vec2(gl_FragCoord.x,r.y-gl_FragCoord.y);
  vec2 size=vec2(${WIDTH}.,${HEIGHT}.);
  vec2 u=(q-r*.5)/(z*r.x/size.x)+c;
  if(u.x<0.||u.y<0.||u.x>=size.x||u.y>=size.y){gl_FragColor=vec4(0.,0.,0.,1.);return;}
  vec2 cell=floor(u);vec2 f=u-cell;
  vec3 color=texture2D(s,(cell+.5)/size).rgb;
  float x=f.x*3.;float lane=floor(x);float w=x-lane;
  float m=clamp(min(w,1.-w)/.2,0.,1.)*clamp(min(f.y,1.-f.y)/.16,0.,1.);
  vec3 tint=lane<1.?vec3(1.,.12,.12):lane<2.?vec3(.12,1.,.12):vec3(.12,.12,1.);
  vec3 lit=(color*1.7+.055)*tint*m;
  vec3 result=mix(lit,texture2D(s,u/size).rgb,clamp((3.2-z)/2.2,0.,1.));
  float grain=fract(sin(dot(q+n,vec2(12.9898,78.233)))*43758.5453)-.5;
  gl_FragColor=vec4(result+grain*g,1.);
}`;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (from: number, to: number, k: number) => from + (to - from) * k;
const logLerp = (from: number, to: number, k: number) =>
  Math.exp(lerp(Math.log(from), Math.log(to), k));
const inOut = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);
const out = (k: number) => 1 - (1 - k) ** 3;

type Box = { left: number; top: number; width: number; height: number };

function drawCover(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { naturalWidth: number; naturalHeight: number },
  box: Box,
  width = box.width,
) {
  const scale = Math.max(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const sourceWidth = box.width / scale;
  const sourceHeight = box.height / scale;
  context.drawImage(
    image,
    (image.naturalWidth - sourceWidth) / 2,
    (image.naturalHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    box.left + (box.width - width) / 2,
    box.top,
    width,
    box.height,
  );
}

function measureOpening(slide: HTMLElement, images: HTMLImageElement[]) {
  const frame = slide.getBoundingClientRect();
  const scale = WIDTH / frame.width;
  const box = (rect: DOMRect) => ({
    left: rect.left - frame.left,
    top: rect.top - frame.top,
    width: rect.width,
    height: rect.height,
  });
  const field = getComputedStyle(slide).backgroundColor;
  const covers = [...slide.querySelectorAll<HTMLImageElement>(".wrapped-stack img")].flatMap(
    (element) => {
      const image = images.find((loaded) => loaded.src === element.src);
      return image ? [{ image, box: box(element.getBoundingClientRect()) }] : [];
    },
  );
  return (context: CanvasRenderingContext2D) => {
    context.save();
    context.scale(scale, scale);
    context.fillStyle = field;
    context.fillRect(0, 0, frame.width, frame.height);
    for (const cover of covers)
      if (cover.image.complete && cover.image.naturalWidth)
        drawCover(context, cover.image, cover.box);
    context.restore();
  };
}

function program(gl: WebGLRenderingContext) {
  const shader = (type: number, source: string) => {
    const result = gl.createShader(type);
    if (!result) throw new Error("WebGL is unavailable");
    gl.shaderSource(result, source);
    gl.compileShader(result);
    return result;
  };
  const result = gl.createProgram();
  if (!result) throw new Error("WebGL is unavailable");
  gl.attachShader(result, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(result, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error("WebGL is unavailable");
  gl.useProgram(result);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(result, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const parameter of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
    gl.texParameteri(gl.TEXTURE_2D, parameter, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const uniform = (name: string) => gl.getUniformLocation(result, name);
  return { r: uniform("r"), c: uniform("c"), z: uniform("z"), g: uniform("g"), n: uniform("n") };
}

export default function WrappedIntro({
  summary,
  slide,
  onReveal,
  onDone,
}: {
  summary: WrappedRecap;
  slide: RefObject<HTMLDivElement | null>;
  onReveal: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onReveal, onDone });
  callbacks.current = { onReveal, onDone };

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl", { antialias: false });
    const source = document.createElement("canvas");
    source.width = WIDTH;
    source.height = HEIGHT;
    const context = source.getContext("2d");
    if (!canvas || !gl || !context) {
      callbacks.current.onReveal();
      callbacks.current.onDone();
      return;
    }
    let frame = 0;
    let active = true;
    let revealedAt = 0;
    const finish = () => {
      if (!active) return;
      active = false;
      callbacks.current.onReveal();
      callbacks.current.onDone();
    };

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = footage;

    const plays = summary.totalPlays;
    const lines = [
      "This year,",
      "you pressed",
      "play",
      plays.toLocaleString(),
      plays === 1 ? "time." : "times.",
    ];
    const covers: HTMLImageElement[] = [];
    for (const url of wrappedCovers(summary, 16))
      loadWrappedImage(url)
        .then((image) => covers.push(image))
        .catch(() => {});
    video.addEventListener("error", finish, { once: true });

    Promise.all([
      loadWrappedFonts(`${WORDS.map(([word]) => word).join("")}${lines.join("")}`),
      loadWrappedLogo(),
    ])
      .then(([, logo]) => {
        if (!active) return;
        const uniforms = program(gl);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.min(1080, Math.round(canvas.clientWidth * dpr));
        canvas.height = Math.round((canvas.width * HEIGHT) / WIDTH);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uniforms.r, canvas.width, canvas.height);

        let poster: { value: string; size: number; base: number }[] | null = null;
        const layout = () => {
          context.font = `900 100px ${WRAPPED_DISPLAY}`;
          context.letterSpacing = "-4px";
          const rows = lines.map((value) => ({
            value,
            size: Math.min(230, (490 / context.measureText(value).width) * 100),
          }));
          const total = rows.reduce((height, row) => height + row.size * 0.8, 0);
          const fit = Math.min(1, 860 / total);
          let y = (HEIGHT - total * fit) / 2;
          return rows.map((row) => {
            const size = row.size * fit;
            y += size * 0.8;
            return { ...row, size, base: y - size * 0.08 };
          });
        };
        let opening: ((context: CanvasRenderingContext2D) => void) | null = null;

        const draw = (t: number) => {
          context.globalAlpha = 1;
          context.letterSpacing = "0px";
          context.shadowBlur = 0;
          if (t < REVEAL) context.drawImage(video, 0, 0, WIDTH, HEIGHT);
          else {
            opening ??= slide.current ? measureOpening(slide.current, covers) : null;
            if (opening) opening(context);
          }
          context.fillStyle = "#fff";
          if (t < LOGO_END && logo) {
            context.globalAlpha = 1 - clamp((t - 4.9) / 0.6);
            const grow = clamp((t - 1.05) / 0.85);
            context.save();
            context.translate(WIDTH / 2, HEIGHT / 2);
            if (grow <= 0) {
              context.beginPath();
              context.arc(0, 0, 2.2 * inOut(clamp((t - 0.35) / 0.35)), 0, Math.PI * 2);
              context.fill();
            } else {
              const scale = 0.11 * (1 - (1 - grow) ** 3 * Math.cos(grow * 7));
              context.scale(scale, scale);
              context.translate(-325, -242);
              context.fill(logo.path);
            }
            context.restore();
          }
          for (const [word, start, length, size] of WORDS) {
            if (t < start || t >= start + length) continue;
            const scale = 1.08 - 0.08 * out(clamp((t - start) / length));
            const px = size * 5.4;
            context.save();
            context.globalAlpha = 1;
            context.font = `900 ${px}px ${WRAPPED_DISPLAY}`;
            context.letterSpacing = `${-0.04 * px}px`;
            context.textAlign = "center";
            context.shadowColor = "rgba(0,0,0,.35)";
            context.shadowBlur = 40;
            const ascent = context.measureText(word).actualBoundingBoxAscent;
            context.translate(WIDTH / 2, HEIGHT / 2);
            context.scale(scale, scale);
            context.fillText(word, 0, ascent / 2);
            context.restore();
          }
          if (t >= FLIP && t < PLATE && covers.length)
            for (let index = 0; index < 16; index++) {
              const column = index % 4;
              const row = Math.floor(index / 4);
              const k = clamp((t - FLIP - (column + row) * 0.06) / 0.55);
              if (k <= 0) continue;
              const angle = inOut(k) * Math.PI;
              const tile = { left: column * 135, top: row * 240, width: 135, height: 240 };
              const width = tile.width * Math.abs(Math.cos(angle));
              context.fillStyle = "#000";
              context.fillRect(tile.left, tile.top, tile.width, tile.height);
              if (angle < Math.PI / 2)
                context.drawImage(
                  video,
                  tile.left,
                  tile.top,
                  tile.width,
                  tile.height,
                  tile.left + (tile.width - width) / 2,
                  tile.top,
                  width,
                  tile.height,
                );
              else {
                const flicker =
                  t >= FLICKER[0] && t < FLICKER[1]
                    ? Math.floor((t - FLICKER[0]) / 0.125) * 3 + index * 7
                    : index;
                drawCover(context, covers[flicker % covers.length], tile, width);
              }
            }
          if (t >= PLATE && t < REVEAL) {
            poster ??= layout();
            context.fillStyle = "#fff";
            poster.forEach((line, index) => {
              const k = clamp((t - 14.5 - index * 0.45) / 0.35);
              if (k <= 0) return;
              const scale = 1.08 - 0.08 * out(k);
              context.save();
              context.globalAlpha = Math.min(1, k * 3);
              context.font = `900 ${line.size}px ${WRAPPED_DISPLAY}`;
              context.letterSpacing = `${-0.04 * line.size}px`;
              context.translate(25, line.base);
              context.scale(scale, scale);
              context.fillText(line.value, 0, 0);
              context.restore();
            });
          }
        };

        const lens = (t: number) => {
          if (t < LOGO_END)
            return {
              zoom: t < 1 ? lerp(110, 96, t) : logLerp(96, 1, inOut(clamp((t - 1) / 4))),
              x: WIDTH / 2,
              y: HEIGHT / 2,
            };
          if (t < PUSH) return { zoom: 1, x: WIDTH / 2, y: HEIGHT / 2 };
          if (t < REVEAL) {
            const k = inOut(clamp((t - PUSH) / 2.4));
            const focus = poster ? poster[3].base - poster[3].size * 0.36 : HEIGHT / 2;
            return { zoom: logLerp(1, 120, k), x: WIDTH / 2, y: lerp(HEIGHT / 2, focus, k) };
          }
          const k = out(clamp((t - REVEAL) / 2.2));
          return {
            zoom: logLerp(120, 1, k),
            x: lerp(360, WIDTH / 2, k),
            y: lerp(190, HEIGHT / 2, k),
          };
        };

        const started = performance.now();
        const tick = (now: number) => {
          if (!active) return;
          let t = video.currentTime;
          if (t === 0 && now - started > 10_000) return finish();
          if (revealedAt || video.ended || t >= REVEAL) {
            if (!revealedAt) {
              revealedAt = now - Math.max(0, t - REVEAL) * 1000;
              callbacks.current.onReveal();
            }
            t = REVEAL + (now - revealedAt) / 1000;
          }
          if (t >= END) return finish();
          draw(t);
          const view = lens(t);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          } catch {
            return finish();
          }
          gl.uniform2f(uniforms.c, view.x, view.y);
          gl.uniform1f(uniforms.z, view.zoom);
          gl.uniform1f(uniforms.g, t >= GRAIN[0] && t < GRAIN[1] ? 0.09 : 0);
          gl.uniform1f(uniforms.n, Math.floor(t * 24));
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          frame = requestAnimationFrame(tick);
        };
        return video.play().then(() => {
          frame = requestAnimationFrame(tick);
        });
      })
      .catch(finish);

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [slide, summary]);

  return <canvas ref={ref} className="wrapped-intro" aria-hidden="true" />;
}
