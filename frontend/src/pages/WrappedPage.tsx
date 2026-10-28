import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import { wrappedClient } from "../utils/api/clients/wrapped.ts";
import {
  useWrapped,
  useWrappedSeason,
  wrappedTimeZone,
  type WrappedRecap,
} from "../hooks/useWrapped.ts";
import { playlistPath } from "../navigation/playlistPaths.ts";
import {
  WRAPPED_CARD_BUILD,
  createWrappedImage,
  downloadWrappedFile,
  loadWrappedFonts,
  prepareWrappedCard,
  wrappedCovers,
  wrappedImageUrl,
  wrappedInk,
  wrappedPalette,
} from "../utils/wrappedShare";
import {
  wrappedAlbumSong,
  wrappedArtistSong,
  wrappedSongSource,
  wrappedSoundtrack,
} from "../utils/wrappedSoundtrack.ts";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { RotateCcw, Volume2, VolumeX, X } from "../components/icons.tsx";
import TooltipButton from "../components/TooltipButton.tsx";
import WrappedIntro from "./WrappedIntro.tsx";
import "./wrapped.css";

type Slide = {
  kind:
    | "opening"
    | "minutes"
    | "variety"
    | "genre"
    | "artist"
    | "artists"
    | "song"
    | "songs"
    | "album"
    | "months"
    | "day"
    | "streak"
    | "hour"
    | "share";
};
type ShareImage = { file: File; url: string } | "failed" | null;

const DAY_MS = 86_400_000;
const plural = (value: number, word: string) => `${word}${value === 1 ? "" : "s"}`;
const count = (value: number, word: string) => `${value.toLocaleString()} ${plural(value, word)}`;
const hourLabel = (hour: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, hour));
const dayLabel = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(Date.parse(date));
const percent = (part: number, whole: number) => {
  const value = Math.round((part / Math.max(1, whole)) * 100);
  return value < 1 ? "<1%" : `${value}%`;
};
const sentenceCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const withoutEdition = (title: string) => title.replace(/\s*[([][^()[\]]*[)\]]\s*$/, "") || title;

function storySlides(summary: WrappedRecap) {
  const include = (condition: unknown, slide: Slide) => (condition ? [slide] : []);
  return [
    { kind: "opening" },
    { kind: "minutes" },
    { kind: "variety" },
    ...include(summary.topGenres.length, { kind: "genre" }),
    ...include(summary.topArtists[0], { kind: "artist" }),
    ...include(summary.topArtists.length >= 3, { kind: "artists" }),
    ...include(summary.topSongs[0], { kind: "song" }),
    ...include(summary.topSongs.length >= 3, { kind: "songs" }),
    ...include(summary.topAlbums[0], { kind: "album" }),
    ...include(summary.months.filter((month) => month.plays).length >= 2, { kind: "months" }),
    ...include(summary.busiestDay, { kind: "day" }),
    ...include((summary.longestStreak?.days ?? 0) >= 2, { kind: "streak" }),
    { kind: "hour" },
    { kind: "share" },
  ] satisfies Slide[];
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const introKey = (year: number) => `aurral.wrapped.intro.${year}`;

function introPending(year: number) {
  try {
    return !reducedMotion() && localStorage.getItem(introKey(year)) === null;
  } catch {
    return false;
  }
}

function markIntroSeen(year: number) {
  try {
    localStorage.setItem(introKey(year), "seen");
    return true;
  } catch {
    return false;
  }
}

const at = (step: number): CSSProperties => ({ "--i": step });

function Fit({
  className,
  max,
  lines = 1,
  step,
  fly,
  children,
}: {
  className: string;
  max: number;
  lines?: number;
  step?: number;
  fly?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    for (let size = max; size >= 6; size--) {
      element.style.fontSize = `${size}cqw`;
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      if (
        element.scrollWidth <= element.clientWidth &&
        element.offsetHeight <= lines * lineHeight + 1
      )
        break;
    }
  }, [children, lines, max]);
  return (
    <p
      ref={ref}
      className={className}
      style={step === undefined ? undefined : at(step)}
      data-fly={fly}
    >
      {children}
    </p>
  );
}

function Words({ text, from }: { text: string; from: number }) {
  return text.split(" ").map((word, index) => (
    <Fragment key={index}>
      {index > 0 && " "}
      <span className="wrapped-mask">
        <span className="wrapped-in wrapped-in--word" style={at(from + index * 1.4)}>
          {word}
        </span>
      </span>
    </Fragment>
  ));
}

function CountUp({ value, from }: { value: number; from: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion()) return;
    const start = performance.now() + from * 100;
    let frame = requestAnimationFrame(function tick(now) {
      const k = Math.min(1, Math.max(0, (now - start) / 2200));
      element.textContent = Math.round(value * (1 - (1 - k) ** 4)).toLocaleString();
      if (k < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [from, value]);
  return <span ref={ref}>{value.toLocaleString()}</span>;
}

function vintageGraph(element: HTMLAudioElement, vintage: boolean) {
  try {
    const context = new AudioContext();
    const source = context.createMediaElementSource(element);
    const clean = new GainNode(context, { gain: vintage ? 0 : 1 });
    const mono = new GainNode(context, { channelCount: 1, channelCountMode: "explicit" });
    const old = new GainNode(context, { gain: vintage ? 2 : 0 });
    const hiss = new GainNode(context, { gain: vintage ? 1 : 0 });
    const noise = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let index = 0; index < samples.length; index++)
      samples[index] =
        (Math.random() * 2 - 1) * 0.012 + (Math.random() < 0.0007 ? Math.random() - 0.5 : 0);
    const crackle = new AudioBufferSourceNode(context, { buffer: noise, loop: true });
    source.connect(clean).connect(context.destination);
    source
      .connect(mono)
      .connect(new BiquadFilterNode(context, { type: "highpass", frequency: 380 }))
      .connect(new BiquadFilterNode(context, { type: "lowpass", frequency: 3000 }))
      .connect(old)
      .connect(context.destination);
    crackle
      .connect(new BiquadFilterNode(context, { type: "highpass", frequency: 900 }))
      .connect(hiss)
      .connect(context.destination);
    crackle.start();
    return { context, clean, old, hiss };
  } catch {
    return null;
  }
}

function useSoundtrack(src: string | null, seek: number | null, muted: boolean, vintage: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const graph = useRef<ReturnType<typeof vintageGraph>>(null);
  const startAt = useRef(0);
  const [current, setCurrent] = useState<string | null>(null);
  const queue = useAudioQueue();
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const vintageRef = useRef(vintage);
  vintageRef.current = vintage;

  useEffect(() => {
    const element = new Audio();
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    element.loop = true;
    const sound = vintageGraph(element, vintageRef.current);
    element.addEventListener("playing", () => {
      setCurrent(element.src);
      sound?.context.resume().catch(() => {});
      if (queueRef.current.isPlaying) queueRef.current.togglePlayPause();
    });
    element.addEventListener("pause", () => setCurrent(null));
    audio.current = element;
    graph.current = sound;
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
      sound?.context.close().catch(() => {});
      audio.current = null;
      graph.current = null;
    };
  }, []);

  useEffect(() => {
    if (audio.current) audio.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const sound = graph.current;
    if (!sound) return;
    const now = sound.context.currentTime;
    sound.clean.gain.setTargetAtTime(!vintage && !muted ? 1 : 0, now, 0.15);
    sound.old.gain.setTargetAtTime(vintage && !muted ? 2 : 0, now, 0.15);
    sound.hiss.gain.setTargetAtTime(vintage && !muted ? 1 : 0, now, 0.15);
  }, [muted, vintage]);

  useEffect(() => {
    const element = audio.current;
    if (!element || !src) return;
    let frame = 0;
    const ramp = (to: number, length: number, then?: () => void) => {
      const from = element.volume;
      const started = performance.now();
      frame = requestAnimationFrame(function step(now) {
        const k = Math.min(1, Math.max(0, (now - started) / length));
        element.volume = from + (to - from) * k;
        if (k < 1) frame = requestAnimationFrame(step);
        else then?.();
      });
    };
    const start = () => {
      element.src = src;
      startAt.current = seek ?? 0;
      if (seek !== 0)
        element.addEventListener(
          "loadedmetadata",
          () => {
            if (element.src !== src) return;
            if (seek === null) {
              if (!(element.duration > 60)) return;
              startAt.current = Math.round(element.duration * 0.3);
            }
            element.currentTime = startAt.current;
          },
          { once: true },
        );
      element.play().catch(() => {});
      ramp(1, 800);
    };
    if (element.src === src) ramp(1, 300);
    else if (element.paused) {
      element.volume = 0;
      start();
    } else ramp(0, 350, start);
    return () => cancelAnimationFrame(frame);
  }, [src, seek]);

  return {
    current,
    position: () => {
      const element = audio.current;
      if (!element?.src || element.paused || element.seeking) return null;
      const time = element.currentTime - startAt.current;
      return time >= 0 ? time : null;
    },
    resume: () => {
      const element = audio.current;
      graph.current?.context.resume().catch(() => {});
      if (element?.src && element.paused) element.play().catch(() => {});
    },
    restart: () => {
      const element = audio.current;
      graph.current?.context.resume().catch(() => {});
      if (!element?.src) return;
      element.currentTime = startAt.current;
      element.play().catch(() => {});
    },
  };
}

function useShareImage(summary: WrappedRecap, field: string, username: string) {
  const [image, setImage] = useState<ShareImage>(null);
  useEffect(() => {
    let url = "";
    let active = true;
    createWrappedImage(summary, field, username)
      .then((file) => {
        url = URL.createObjectURL(file);
        if (active) setImage({ file, url });
        else URL.revokeObjectURL(url);
      })
      .catch(() => active && setImage("failed"));
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [field, summary, username]);
  return image;
}

function fly(from: HTMLElement, to: HTMLElement, frame: HTMLElement) {
  const box = frame.getBoundingClientRect();
  const start = from.getBoundingClientRect();
  const end = to.getBoundingClientRect();
  const source = getComputedStyle(from);
  const target = getComputedStyle(to);
  const ghost = document.createElement("p");
  ghost.className = "wrapped-ghost";
  ghost.textContent = to.textContent;
  Object.assign(ghost.style, {
    left: `${end.left - box.left}px`,
    top: `${end.top - box.top}px`,
    width: `${end.width}px`,
    fontFamily: target.fontFamily,
    fontSize: target.fontSize,
    fontWeight: target.fontWeight,
    lineHeight: target.lineHeight,
    letterSpacing: target.letterSpacing,
  });
  frame.append(ghost);
  from.style.visibility = "hidden";
  to.style.visibility = "hidden";
  to.style.animation = "none";
  const scale = Number.parseFloat(source.fontSize) / Number.parseFloat(target.fontSize);
  ghost
    .animate(
      [
        {
          transform: `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${scale})`,
          color: source.color,
        },
        { transform: "none", color: target.color },
      ],
      { duration: 1000, easing: "cubic-bezier(0.65, 0, 0.2, 1)", fill: "both" },
    )
    .finished.finally(() => {
      to.style.visibility = "";
      ghost.remove();
    });
}

function expand(from: HTMLElement, frame: HTMLElement, field: string) {
  const box = frame.getBoundingClientRect();
  const bar = from.getBoundingClientRect();
  const left = `${bar.left - box.left}px`;
  const width = `${bar.width}px`;
  const color = getComputedStyle(from).backgroundColor;
  const ghost = document.createElement("div");
  ghost.className = "wrapped-ghost";
  frame.append(ghost);
  ghost
    .animate(
      [
        {
          left,
          top: `${bar.top - box.top}px`,
          width,
          height: `${bar.height}px`,
          background: color,
        },
        { left, top: "0px", width, height: `${box.height}px`, background: color, offset: 0.45 },
        {
          left: "0px",
          top: "0px",
          width: `${box.width}px`,
          height: `${box.height}px`,
          background: field,
        },
      ],
      { duration: 800, easing: "cubic-bezier(0.7, 0, 0.25, 1)", fill: "both" },
    )
    .finished.finally(() => ghost.remove());
}

function Opening({ summary, username }: { summary: WrappedRecap; username: string }) {
  const covers = wrappedCovers(summary);
  const year = String(summary.year);
  return (
    <>
      {covers.length > 0 && (
        <div className="wrapped-stack" aria-hidden="true">
          {covers.map((url, index) => (
            <img
              key={url}
              className="wrapped-in wrapped-in--drop"
              style={at(4 + index * 1.2)}
              src={wrappedImageUrl(url)}
              alt=""
            />
          ))}
        </div>
      )}
      <p
        className={`wrapped-year wrapped-in wrapped-in--stamp${covers.length ? " wrapped-year--beside" : ""}`}
        style={at(1)}
      >
        {year.slice(0, 2)}
        <br />
        {year.slice(2)}
      </p>
      <div className="wrapped-foot wrapped-in" style={at(9)}>
        <p>Your year in music</p>
        <p className="wrapped-dim">{username}</p>
      </div>
    </>
  );
}

function Minutes({ summary, spinning }: { summary: WrappedRecap; spinning: boolean }) {
  const { minutes, totalPlays, uniqueArtists, uniqueSongs } = summary;
  const [cover] = wrappedCovers(summary, 1);
  const span =
    minutes === null || minutes < 60
      ? ""
      : minutes >= 1440
        ? `About ${(minutes / 1440).toLocaleString(undefined, { maximumFractionDigits: 1 })} days of music. `
        : `About ${count(Math.round(minutes / 60), "hour")} of music. `;
  return (
    <>
      <div
        className={`wrapped-record wrapped-in${spinning ? " wrapped-record--spinning" : ""}`}
        style={at(14)}
        aria-hidden="true"
      >
        <div className="wrapped-record-disc">
          {cover && <img src={wrappedImageUrl(cover)} alt="" />}
        </div>
      </div>
      <div className="wrapped-pad">
        <Fit className="wrapped-fill wrapped-in wrapped-in--fade" max={41} step={3}>
          <CountUp value={minutes ?? totalPlays} from={3} />
        </Fit>
        <p className="wrapped-word wrapped-in" style={at(9)}>
          {minutes === null ? "plays" : "minutes"}
        </p>
        <p className="wrapped-body wrapped-in" style={at(16)}>
          {minutes === null
            ? `${count(uniqueArtists, "artist")} and ${count(uniqueSongs, "song")}.`
            : `${span}${count(totalPlays, "play")} across ${count(uniqueArtists, "artist")}.`}
        </p>
      </div>
    </>
  );
}

function NowPlaying({ title }: { title: string }) {
  return (
    <p className="wrapped-now">
      <span className="wrapped-eq" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      Playing {title}
    </p>
  );
}

function Variety({ summary }: { summary: WrappedRecap }) {
  const rows = [
    { value: summary.uniqueArtists, word: "artist", size: 46 },
    { value: summary.uniqueSongs, word: "song", size: 34 },
    { value: summary.uniqueAlbums, word: "album", size: 26 },
  ].filter((row) => row.value > 0);
  return (
    <div className="wrapped-pad">
      {rows.map((row, index) => (
        <Fragment key={row.word}>
          <Fit
            className="wrapped-variety wrapped-in wrapped-in--fade"
            max={row.size}
            step={3 + index * 3}
          >
            <CountUp value={row.value} from={3 + index * 3} />
          </Fit>
          <p className="wrapped-variety-label wrapped-in" style={at(4 + index * 3)}>
            {plural(row.value, row.word)}
          </p>
        </Fragment>
      ))}
      <p className="wrapped-body wrapped-in" style={at(13)}>
        Spread across {count(summary.activeDays, "day")} of listening.
      </p>
    </div>
  );
}

function Genre({ summary }: { summary: WrappedRecap }) {
  const [top] = summary.topGenres;
  if (!top) return null;
  return (
    <div className="wrapped-pad">
      <Fit className="wrapped-headline wrapped-in wrapped-in--stamp" max={40} lines={2} step={3}>
        {sentenceCase(top.name)}
      </Fit>
      <p className="wrapped-word wrapped-word--small wrapped-in" style={at(7)}>
        was your sound.
      </p>
      <p className="wrapped-body wrapped-in" style={at(10)}>
        It ran through {percent(top.plays, summary.totalPlays)} of your plays.
      </p>
      <ol className="wrapped-genres">
        {summary.topGenres.map((genre, index) => (
          <li key={genre.name} className="wrapped-in" style={at(12 + index * 1.2)}>
            <span className="wrapped-genre-name">{sentenceCase(genre.name)}</span>
            <span className="wrapped-genre-share">{percent(genre.plays, summary.totalPlays)}</span>
            <i
              className="wrapped-in wrapped-in--stretch"
              style={{ ...at(13 + index * 1.2), width: `${(genre.plays / top.plays) * 100}%` }}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Artist({ summary, playing }: { summary: WrappedRecap; playing: boolean }) {
  const artist = summary.topArtists[0];
  const song = wrappedArtistSong(summary);
  if (!artist) return null;
  return (
    <>
      {artist.artwork && (
        <img className="wrapped-hero" src={wrappedImageUrl(artist.artwork)} alt="" />
      )}
      <div className="wrapped-pad wrapped-bottom">
        <Fit className="wrapped-artist" max={37} lines={3}>
          <Words text={artist.name} from={7} />
        </Fit>
        <p className="wrapped-body wrapped-in" style={at(12)}>
          Your top artist. {count(artist.plays, "play")}.
        </p>
        {song && playing && <NowPlaying title={song.name} />}
      </div>
    </>
  );
}

function Artists({ summary }: { summary: WrappedRecap }) {
  return (
    <div className="wrapped-pad">
      <h2 className="sr-only">Your top artists</h2>
      <ol className="wrapped-artists">
        {summary.topArtists.map((artist, index) => (
          <li key={artist.key} className="wrapped-in" style={at(3 + index * 1.2)}>
            {artist.artwork ? (
              <img src={wrappedImageUrl(artist.artwork)} alt="" />
            ) : (
              <span className="wrapped-artists-blank" />
            )}
            <span className="wrapped-artists-rank">{index + 1}</span>
            <span className="wrapped-artists-name">{artist.name}</span>
            <span className="wrapped-artists-plays">{count(artist.plays, "play")}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Song({ summary, playing }: { summary: WrappedRecap; playing: boolean }) {
  const song = summary.topSongs[0];
  if (!song) return null;
  const details = [
    song.artist,
    `${count(song.plays, "play")}${song.minutes ? `, about ${count(song.minutes, "minute")}` : ""}`,
    `First played this year on ${new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", timeZone: summary.timeZone }).format(song.firstPlayedAt)}`,
  ];
  return (
    <>
      {song.artwork && (
        <img
          className="wrapped-cover wrapped-in wrapped-in--stamp"
          style={at(2)}
          src={wrappedImageUrl(song.artwork)}
          alt=""
        />
      )}
      <div className="wrapped-pad wrapped-bottom">
        <p className="wrapped-kicker wrapped-in" style={at(6)}>
          Your top song
        </p>
        <Fit className="wrapped-headline wrapped-headline--tight" max={40} lines={2} fly="top-song">
          <Words text={song.name} from={7} />
        </Fit>
        <p className="wrapped-body wrapped-in" style={at(12)}>
          {details.join(". ")}.
        </p>
        {playing && <NowPlaying title={song.name} />}
      </div>
    </>
  );
}

function Album({ summary, playing }: { summary: WrappedRecap; playing: boolean }) {
  const album = summary.topAlbums[0];
  const song = wrappedAlbumSong(summary);
  if (!album) return null;
  return (
    <>
      {album.artwork && (
        <img className="wrapped-album" src={wrappedImageUrl(album.artwork)} alt="" />
      )}
      <div className="wrapped-pad wrapped-bottom">
        <p className="wrapped-kicker wrapped-in" style={at(6)}>
          Your top album
        </p>
        <Fit className="wrapped-album-name" max={24} lines={2}>
          <Words text={withoutEdition(album.name)} from={7} />
        </Fit>
        <p className="wrapped-body wrapped-in" style={at(12)}>
          {album.artist}. {count(album.plays, "play")}
          {album.songs > 1 ? ` across ${count(album.songs, "song")}` : ""}.
        </p>
        {song && playing && <NowPlaying title={song.name} />}
      </div>
    </>
  );
}

function Months({ summary }: { summary: WrappedRecap }) {
  const peak = summary.months.reduce((top, month) => (month.plays > top.plays ? month : top));
  const months = Array.from(
    { length: 12 },
    (_, index) =>
      summary.months[index] ?? {
        month: `${summary.year}-${String(index + 1).padStart(2, "0")}`,
        plays: 0,
        topArtist: null,
      },
  );
  return (
    <>
      <div className="wrapped-pad">
        <Fit className="wrapped-headline wrapped-in wrapped-in--stamp" max={40} step={3}>
          {dayLabel(`${peak.month}-01`, { month: "long" })}
        </Fit>
        <p className="wrapped-word wrapped-word--small wrapped-in" style={at(7)}>
          was your loudest month.
        </p>
        <p className="wrapped-body wrapped-in" style={at(10)}>
          {count(peak.plays, "play")}
          {peak.topArtist ? `, mostly ${peak.topArtist.name}` : ""}.
        </p>
      </div>
      <div className="wrapped-months" aria-hidden="true">
        {months.map((month, index) => (
          <div
            key={month.month}
            className={month === peak ? "wrapped-month wrapped-peak" : "wrapped-month"}
          >
            <i
              className="wrapped-in wrapped-in--grow"
              style={{
                ...at(6 + index * 0.6),
                height: month.plays ? `${Math.max(2, (month.plays / peak.plays) * 100)}%` : 0,
              }}
            />
            <span className="wrapped-in wrapped-in--fade" style={at(6 + index * 0.6)}>
              {dayLabel(`${month.month}-01`, { month: "narrow" })}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Day({ summary }: { summary: WrappedRecap }) {
  const day = summary.busiestDay;
  if (!day) return null;
  return (
    <div className="wrapped-pad">
      <Fit className="wrapped-day-month wrapped-in wrapped-in--stamp" max={31} step={3}>
        {dayLabel(day.date, { month: "long" })}
      </Fit>
      <p className="wrapped-day-number wrapped-in wrapped-in--stamp" style={at(6)}>
        {dayLabel(day.date, { day: "numeric" })}
      </p>
      <p className="wrapped-body wrapped-in" style={at(11)}>
        {count(day.plays, "play")} in one day.
        {day.topSong && day.topSong.plays > 1
          ? ` Most of all, ${day.topSong.name}, ${count(day.topSong.plays, "time")}.`
          : ""}
      </p>
    </div>
  );
}

function Streak({ summary }: { summary: WrappedRecap }) {
  const streak = summary.longestStreak;
  if (!streak) return null;
  const first = Date.UTC(summary.year, 0, 1);
  const offset = (date: string) => (Date.parse(date) - first) / DAY_MS;
  const [start, end] = [offset(streak.start), offset(streak.end)];
  const date = (value: string) => dayLabel(value, { month: "long", day: "numeric" });
  return (
    <>
      <div className="wrapped-pad">
        <p className="wrapped-streak wrapped-in wrapped-in--fade" style={at(3)}>
          <CountUp value={streak.days} from={3} />
        </p>
        <p className="wrapped-word wrapped-word--small wrapped-in" style={at(9)}>
          days in a row.
        </p>
        <p className="wrapped-body wrapped-in" style={at(12)}>
          {date(streak.start)} to {date(streak.end)}. Music on {count(summary.activeDays, "day")}{" "}
          this year.
        </p>
      </div>
      <div className="wrapped-calendar" aria-hidden="true">
        {Array.from({ length: 12 }, (_, month) => (
          <div key={month}>
            {Array.from({ length: 31 }, (_, day) => {
              const time = Date.UTC(summary.year, month, day + 1);
              const index = (time - first) / DAY_MS;
              const exists =
                new Date(time).getUTCMonth() === month && index < summary.calendar.length;
              const state = !exists
                ? "wrapped-calendar-none"
                : index >= start && index <= end
                  ? "wrapped-calendar-streak"
                  : summary.calendar[index]
                    ? "wrapped-calendar-on"
                    : "";
              return (
                <i
                  key={day}
                  className={`wrapped-in wrapped-in--dot ${state}`}
                  style={at(4 + (month * 31 + day) * 0.08)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

function Songs({ summary }: { summary: WrappedRecap }) {
  return (
    <div className="wrapped-pad">
      <h2 className="sr-only">Your top songs</h2>
      <ol className="wrapped-rank">
        {summary.topSongs.slice(0, 5).map((song, index) => {
          const step = index ? 13 + (index - 1) * 2.8 : 5;
          return (
            <li key={song.key}>
              <span
                className={`wrapped-rank-number wrapped-in${index ? "" : " wrapped-in--stamp"}`}
                style={at(step)}
              >
                {index + 1}
              </span>
              <span
                className="wrapped-rank-title wrapped-in"
                style={at(index ? step + 0.7 : 7)}
                data-fly={index ? undefined : "top-song"}
              >
                {song.name}
              </span>
              <span className="wrapped-rank-artist wrapped-in" style={at(index ? step + 1.4 : 10)}>
                {song.artist}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Hour({ summary }: { summary: WrappedRecap }) {
  const peak = Math.max(1, ...summary.hours);
  const hour = summary.hours.indexOf(peak);
  const share = Math.round((peak / Math.max(1, summary.totalPlays)) * 100);
  return (
    <>
      <div className="wrapped-pad">
        <Fit className="wrapped-hour wrapped-in wrapped-in--stamp" max={50} step={13.5}>
          {hourLabel(hour)}
        </Fit>
        <p className="wrapped-word wrapped-word--small wrapped-in" style={at(17)}>
          was your hour.
        </p>
        <p className="wrapped-body wrapped-in" style={at(21)}>
          {count(peak, "play")} started in this hour. That is {share}% of your year.
        </p>
      </div>
      <div className="wrapped-histogram" aria-hidden="true">
        {summary.hours.map((plays, index) => (
          <i
            key={index}
            className={`wrapped-in wrapped-in--grow${index === hour ? " wrapped-peak" : ""}`}
            style={{ ...at(5 + index * 0.35), height: `${Math.max(2, (plays / peak) * 100)}%` }}
            data-fly={index === hour ? "peak" : undefined}
          />
        ))}
      </div>
      <div className="wrapped-axis wrapped-in wrapped-in--fade" style={at(5)} aria-hidden="true">
        <span>{hourLabel(0)}</span>
        <span>{hourLabel(12)}</span>
        <span>{hourLabel(23)}</span>
      </div>
    </>
  );
}

function ShareCard({
  summary,
  field,
  username,
  image,
  alt,
  delay,
}: {
  summary: WrappedRecap;
  field: string;
  username: string;
  image: ShareImage;
  alt: string;
  delay: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [start] = useState(delay);
  const [built, setBuilt] = useState(reducedMotion);
  useEffect(() => {
    if (built) return;
    let active = true;
    let frame = 0;
    prepareWrappedCard(summary, field, username)
      .then((draw) => {
        const context = canvas.current?.getContext("2d");
        if (!active || !context) return;
        const begin = performance.now() + start * 100;
        frame = requestAnimationFrame(function tick(now) {
          const time = (now - begin) / 1000;
          draw(context, time);
          if (time < WRAPPED_CARD_BUILD) frame = requestAnimationFrame(tick);
          else setBuilt(true);
        });
      })
      .catch(() => active && setBuilt(true));
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [built, field, start, summary, username]);
  if (image === "failed")
    return (
      <div className="wrapped-pad wrapped-notice">
        <p className="wrapped-body">Your share card could not be created.</p>
      </div>
    );
  return built && image ? (
    <img className="wrapped-card" src={image.url} alt={alt} data-fly="peak" />
  ) : (
    <canvas
      ref={canvas}
      className="wrapped-card"
      width={1080}
      height={1920}
      role="img"
      aria-label={alt}
      data-fly="peak"
    />
  );
}

function Story({
  summary,
  username,
  onClose,
  actions,
}: {
  summary: WrappedRecap;
  username: string;
  onClose: () => void;
  actions: (image: ShareImage) => ReactNode;
}) {
  const slides = useMemo(() => storySlides(summary), [summary]);
  const palette = useMemo(() => wrappedPalette(summary), [summary]);
  const [view, setView] = useState<{ index: number; leaving: number | null }>({
    index: 0,
    leaving: null,
  });
  const [intro, setIntro] = useState(() => introPending(summary.year));
  const [waiting, setWaiting] = useState(intro);
  const [vintage, setVintage] = useState(intro);
  const [fromIntro, setFromIntro] = useState(intro);
  const [held, setHeld] = useState(false);
  const [muted, setMuted] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const pressed = useRef(0);
  const { index, leaving } = view;
  const slide = slides[index];
  const fieldOf = (position: number) => palette[position % palette.length];
  const shareField = fieldOf(slides.length - 1);
  const image = useShareImage(summary, shareField, username);
  const soundtrack = useMemo(
    () =>
      wrappedSoundtrack(
        summary,
        slides.map((entry) => entry.kind),
      ),
    [summary, slides],
  );
  const cue = soundtrack[index];
  const source = cue && wrappedSongSource(cue.song);
  const audio = useSoundtrack(
    intro && waiting ? null : source,
    !cue || cue.song.preview !== null ? 0 : (cue.song.beats?.start ?? null),
    muted,
    vintage,
  );
  const hasAudio = soundtrack.some(Boolean);
  const audible = !muted && Boolean(source) && audio.current === source;
  const playing = audible && cue?.named === true;
  const last = index === slides.length - 1;
  const cut = leaving !== null && slides[leaving].kind === "hour" && slide.kind === "share";

  useEffect(() => {
    let active = true;
    const rows = [...summary.topArtists, ...summary.topSongs.slice(0, 5), ...summary.topAlbums];
    const text = [
      ...rows.flatMap((row) => [row.name, row.artist]),
      ...summary.topGenres.map((genre) => genre.name),
      summary.busiestDay?.topSong?.name ?? "",
      username,
    ].join("");
    loadWrappedFonts(`${text}0123456789,.%`).finally(() => active && setFontsReady(true));
    for (const url of new Set([...wrappedCovers(summary), ...rows.map((row) => row.artwork)]))
      if (url) new Image().src = wrappedImageUrl(url);
    return () => {
      active = false;
    };
  }, [summary, username]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (leaving === null || !frame || reducedMotion()) return;
    const from = frame.querySelector<HTMLElement>(
      `[data-slide="${slides[leaving].kind}"] [data-fly]`,
    );
    const to =
      from &&
      frame.querySelector<HTMLElement>(
        `[data-slide="${slides[index].kind}"] [data-fly="${from.dataset.fly}"]`,
      );
    if (!from || !to) return;
    if (from.dataset.fly === "peak") expand(from, frame, palette[index % palette.length]);
    else fly(from, to, frame);
  }, [index, leaving, palette, slides]);

  const finishIntro = useCallback(() => {
    markIntroSeen(summary.year);
    setVintage(false);
    setIntro(false);
  }, [summary.year]);
  const reveal = useCallback(() => setVintage(false), []);
  const begin = useCallback(() => setWaiting(false), []);

  const go = (step: number) => {
    audio.resume();
    if (intro) {
      setFromIntro(false);
      finishIntro();
      return;
    }
    setFromIntro(false);
    setView((current) => {
      const next = Math.min(slides.length - 1, Math.max(0, current.index + step));
      return next === current.index
        ? current
        : { index: next, leaving: step > 0 ? current.index : null };
    });
  };
  const goRef = useRef(go);
  goRef.current = go;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") goRef.current(1);
      if (event.key === "ArrowLeft") goRef.current(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const tap = (event: MouseEvent<HTMLDivElement>) => {
    if (performance.now() - pressed.current > 300) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    go(event.clientX - bounds.left < bounds.width * 0.3 ? -1 : 1);
  };
  const stop = (event: MouseEvent | PointerEvent<HTMLDivElement>) => event.stopPropagation();
  const settle = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget)
      setView((current) => (current.leaving === null ? current : { ...current, leaving: null }));
  };
  const replay = () => {
    setFromIntro(true);
    setVintage(true);
    setIntro(true);
    audio.restart();
  };
  const fieldStyle = (position: number): CSSProperties => ({
    "--wrapped-field": fieldOf(position),
    "--wrapped-ink": wrappedInk(fieldOf(position)),
  });
  const arrival = (position: number) => {
    if (position !== index) return " wrapped-slide--leaving wrapped-slide--still";
    if (leaving !== null) return cut ? " wrapped-slide--cut" : " wrapped-slide--wipe";
    if (position !== 0 || !fromIntro) return "";
    return intro ? " wrapped-slide--still" : " wrapped-slide--revealed";
  };
  const content = (entry: Slide, current: boolean) => {
    const live = current && playing;
    switch (entry.kind) {
      case "opening":
        return <Opening summary={summary} username={username} />;
      case "minutes":
        return <Minutes summary={summary} spinning={current && audible} />;
      case "variety":
        return <Variety summary={summary} />;
      case "genre":
        return <Genre summary={summary} />;
      case "artist":
        return <Artist summary={summary} playing={live} />;
      case "artists":
        return <Artists summary={summary} />;
      case "song":
        return <Song summary={summary} playing={live} />;
      case "songs":
        return <Songs summary={summary} />;
      case "album":
        return <Album summary={summary} playing={live} />;
      case "months":
        return <Months summary={summary} />;
      case "day":
        return <Day summary={summary} />;
      case "streak":
        return <Streak summary={summary} />;
      case "hour":
        return <Hour summary={summary} />;
      case "share":
        return (
          <ShareCard
            summary={summary}
            field={shareField}
            username={username}
            image={image}
            alt={`${username}'s ${summary.year} in music`}
            delay={cut ? 8 : 5}
          />
        );
    }
  };

  return (
    <>
      <div
        ref={frameRef}
        className={`wrapped-frame${intro ? " wrapped-frame--intro" : ""}${intro || held ? " wrapped-frame--paused" : ""}`}
        style={fieldStyle(index)}
        onClick={tap}
        onPointerDown={() => {
          pressed.current = performance.now();
          setHeld(true);
        }}
        onPointerUp={() => setHeld(false)}
        onPointerCancel={() => setHeld(false)}
        onPointerLeave={() => setHeld(false)}
        role="group"
        aria-roledescription="slide"
        aria-label={intro ? "Intro" : `${index + 1} of ${slides.length}`}
      >
        {intro && (
          <WrappedIntro
            summary={summary}
            beats={soundtrack[0]?.song.beats ?? null}
            slide={slideRef}
            position={soundtrack[0] ? audio.position : null}
            onStart={begin}
            onReveal={reveal}
            onDone={finishIntro}
          />
        )}
        <div className="wrapped-progress" aria-hidden="true">
          {slides.map((entry, position) => (
            <i key={entry.kind} className={position < index ? "wrapped-seen" : undefined}>
              {position === index && fontsReady && (
                <b onAnimationEnd={() => !last && goRef.current(1)} />
              )}
            </i>
          ))}
        </div>
        <div className="wrapped-controls" onClick={stop} onPointerDown={stop}>
          {slide.kind === "opening" && !intro && !reducedMotion() && (
            <TooltipButton
              type="button"
              className="wrapped-control"
              label="Play intro"
              onClick={replay}
            >
              <RotateCcw aria-hidden="true" />
            </TooltipButton>
          )}
          {hasAudio && (
            <TooltipButton
              type="button"
              className="wrapped-control"
              label={muted ? "Unmute" : "Mute"}
              onClick={() => {
                setMuted(!muted);
                audio.resume();
              }}
            >
              {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
            </TooltipButton>
          )}
          <TooltipButton type="button" className="wrapped-control" label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </TooltipButton>
        </div>
        {fontsReady &&
          [leaving, index].map((position) => {
            if (position === null) return null;
            const entry = slides[position];
            return (
              <div
                key={entry.kind}
                ref={position === index ? slideRef : undefined}
                data-slide={entry.kind}
                className={`wrapped-slide wrapped-slide--${entry.kind}${arrival(position)}`}
                style={fieldStyle(position)}
                aria-hidden={position === index ? undefined : true}
                onAnimationEnd={position === index ? settle : undefined}
              >
                {content(entry, position === index)}
              </div>
            );
          })}
      </div>
      <div className="wrapped-actions">{last && !intro && leaving === null && actions(image)}</div>
    </>
  );
}

function Notice({
  title,
  body,
  onClose,
  children,
}: {
  title: string;
  body: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="wrapped-frame">
        <div className="wrapped-controls">
          <TooltipButton type="button" className="wrapped-control" label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </TooltipButton>
        </div>
        <div className="wrapped-pad wrapped-notice" role="status">
          <p className="wrapped-word">{title}</p>
          <p className="wrapped-body">{body}</p>
        </div>
      </div>
      <div className="wrapped-actions">{children}</div>
    </>
  );
}

export default function WrappedPage() {
  const { hasPermission, user } = useAuth();
  const season = useWrappedSeason();
  const timeZone = wrappedTimeZone();
  const year = season?.year ?? new Date().getFullYear();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const query = useWrapped();
  const [sharing, setSharing] = useState(false);
  const close = () => {
    const from: unknown = location.state?.wrappedFrom;
    navigate(
      typeof from === "string" &&
        from.startsWith("/") &&
        !from.startsWith("//") &&
        !from.startsWith("/wrapped")
        ? from
        : "/",
      { replace: true },
    );
  };
  const { dialogRef } = useModalDialog({ open: true, onClose: close });
  const build = useMutation({
    mutationFn: () => parseResponse(wrappedClient.$post({ json: { timeZone } })),
    onSuccess: (data) => client.setQueriesData({ queryKey: ["wrapped"] }, data),
    onError: () => toast.showError("Your Wrapped could not be started. Try again."),
  });
  const playlist = useMutation({
    mutationFn: async () => {
      const response = await wrappedClient.playlist.$post({ json: { timeZone } });
      const result = await response.json();
      if ("error" in result) throw new Error(result.error);
      return result;
    },
    onSuccess: (result) => {
      toast.showSuccess(
        `Saved ${count(result.trackCount, "song")}${result.missingCount ? `. ${count(result.missingCount, "song")} not in your Library were left out` : ""}.`,
      );
      navigate(playlistPath(result.playlistId));
    },
    onError: (error) => toast.showError(error.message || "The playlist could not be saved."),
  });
  if (!season) return <Navigate to="/" replace />;

  const share = async (file: File) => {
    setSharing(true);
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `My ${year} on Aurral` }).catch((error) => {
          if (!(error instanceof Error && error.name === "AbortError")) throw error;
        });
      } else {
        downloadWrappedFile(file);
        toast.showSuccess("Your share card was saved.");
      }
    } catch {
      toast.showError("Your share card could not be shared. Try again.");
    } finally {
      setSharing(false);
    }
  };

  const summary = query.data?.summary ?? null;
  const unavailable = summary?.sources.some((source) => source.state !== "ready") ?? false;
  const rebuild = (
    <button
      type="button"
      className="btn btn-ghost"
      disabled={build.isPending || query.data?.building}
      onClick={() => build.mutate()}
    >
      Try again
    </button>
  );

  let content: ReactNode;
  if (query.isPending)
    content = (
      <>
        <div className="wrapped-frame" />
        <div className="wrapped-actions" />
      </>
    );
  else if (query.isError)
    content = (
      <Notice title="Not loaded" body="Your Wrapped could not be loaded." onClose={close}>
        <button type="button" className="btn btn-primary" onClick={() => query.refetch()}>
          Try again
        </button>
      </Notice>
    );
  else if (!summary)
    content = (
      <Notice
        title={query.data?.error ? "Not ready" : `Building your ${year}`}
        body={
          query.data?.error ?? "Collecting your listening history. You can leave and come back."
        }
        onClose={close}
      >
        {query.data?.error && rebuild}
      </Notice>
    );
  else if (summary.totalPlays === 0)
    content = (
      <Notice
        title="No plays yet"
        body={
          unavailable
            ? "Your listening history could not be reached. Check your connections, then try again."
            : "Listen through Aurral or connect a scrobbler in your Profile to fill your Wrapped."
        }
        onClose={close}
      >
        <Link className="btn btn-primary" to="/profile">
          Open Profile
        </Link>
        {rebuild}
      </Notice>
    );
  else
    content = (
      <Story
        key={summary.end}
        summary={summary}
        username={user?.username ?? ""}
        onClose={close}
        actions={(image) => (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!image || image === "failed" || sharing}
              onClick={() => image && image !== "failed" && share(image.file)}
            >
              Share
            </button>
            {hasPermission("accessFlow") && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={playlist.isPending}
                onClick={() => playlist.mutate()}
              >
                {playlist.isPending ? "Saving" : "Save top songs"}
              </button>
            )}
            {unavailable && rebuild}
          </>
        )}
      />
    );

  return createPortal(
    <div className="wrapped-stage">
      <div
        className="wrapped-story"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Your ${year} Wrapped`}
        tabIndex={-1}
      >
        {content}
      </div>
    </div>,
    document.body,
  );
}
