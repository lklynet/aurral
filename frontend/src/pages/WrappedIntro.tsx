import { useEffect, useRef, type RefObject } from "react";
import type { WrappedRecap } from "../hooks/useWrapped.ts";
import { loadWrappedFonts, loadWrappedLogo } from "../utils/wrappedShare";
import { REEL_HEIGHT, REEL_WIDTH, createReel, measureOpening } from "./wrappedReel.ts";
import footage from "./wrapped-intro.mp4?url";

const GLYPHS = "Youryearinmusic.playsJFMAMJJASOND0123456789,";
const WAIT = 1500;
const FADE = 0.6;
const LEAD = 0.25;

function findSlide(slide: RefObject<HTMLDivElement | null>, alive: () => boolean) {
  const started = performance.now();
  return new Promise<HTMLElement>((resolve, reject) => {
    const look = () => {
      if (!alive()) return reject(new Error("Intro closed"));
      if (slide.current) return resolve(slide.current);
      if (performance.now() - started > 5000) return reject(new Error("Opening slide is missing"));
      requestAnimationFrame(look);
    };
    look();
  });
}

export default function WrappedIntro({
  summary,
  beats,
  slide,
  position,
  onStart,
  onReveal,
  onDone,
}: {
  summary: WrappedRecap;
  beats: WrappedRecap["topSongs"][number]["beats"];
  slide: RefObject<HTMLDivElement | null>;
  position: (() => number | null) | null;
  onStart: () => void;
  onReveal: (lead: number) => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ position, onStart, onReveal, onDone });
  callbacks.current = { position, onStart, onReveal, onDone };

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      callbacks.current.onReveal(0);
      callbacks.current.onDone();
      return;
    }
    let active = true;
    let frame = 0;
    let reel: ReturnType<typeof createReel> | null = null;
    const finish = () => {
      if (!active) return;
      active = false;
      callbacks.current.onStart();
      callbacks.current.onReveal(0);
      callbacks.current.onDone();
    };

    Promise.all([
      loadWrappedFonts(GLYPHS),
      loadWrappedLogo(),
      fetch(footage)
        .then((response) => (response.ok ? response.arrayBuffer().then(() => footage) : null))
        .catch(() => null),
      findSlide(slide, () => active).then((element) =>
        Promise.all(
          [...element.querySelectorAll("img")].map((image) => image.decode().catch(() => {})),
        ).then(() => element),
      ),
    ])
      .then(([, logo, video, element]) => {
        if (!active) return;
        if (!logo) return finish();
        const film = createReel({
          beats,
          summary,
          logo: logo.path,
          opening: measureOpening(element),
          footage: video,
        });
        reel = film;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.min(1080, Math.round(canvas.clientWidth * dpr));
        canvas.height = Math.round((canvas.width * REEL_HEIGHT) / REEL_WIDTH);
        callbacks.current.onStart();
        const deadline = performance.now() + (callbacks.current.position ? WAIT : 0);
        let origin: number | null = null;
        let dropped = false;
        const tick = (now: number) => {
          if (!active) return;
          const heard = callbacks.current.position?.() ?? null;
          if (origin === null && heard === null && now < deadline) {
            film.draw(context, 0);
            frame = requestAnimationFrame(tick);
            return;
          }
          origin ??= now / 1000 - (heard ?? 0);
          if (heard !== null && Math.abs(heard - (now / 1000 - origin)) < 0.5)
            origin -= (heard - (now / 1000 - origin)) * 0.1;
          const t = now / 1000 - origin;
          if (!dropped && t >= film.drop - LEAD) {
            dropped = true;
            callbacks.current.onReveal(Math.max(0, film.drop - t));
          }
          if (t >= film.end) return finish();
          film.draw(context, t);
          canvas.style.opacity = String(Math.min(1, (film.end - t) / FADE));
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      })
      .catch(finish);

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      reel?.dispose();
    };
  }, [beats, slide, summary]);

  return <canvas ref={ref} className="wrapped-intro" aria-hidden="true" />;
}
