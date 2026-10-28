import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
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
  createWrappedImage,
  downloadWrappedFile,
  loadWrappedFonts,
  wrappedCovers,
  wrappedImageUrl,
  wrappedInk,
  wrappedPalette,
} from "../utils/wrappedShare";
import { resolveApiPath } from "../utils/api/core";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { Volume2, VolumeX, X } from "../components/icons.tsx";
import TooltipButton from "../components/TooltipButton.tsx";
import "./wrapped.css";

type Slide = {
  kind: "opening" | "minutes" | "artist" | "songs" | "hour" | "share";
  preview: string | null;
};
type ShareImage = { file: File; url: string } | "failed" | null;

const count = (value: number, word: string) =>
  `${value.toLocaleString()} ${word}${value === 1 ? "" : "s"}`;
const hourLabel = (hour: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, hour));

function storySlides(summary: WrappedRecap) {
  const previews = summary.topSongs.slice(0, 5).flatMap((song) => song.preview ?? []);
  const preview = (rank: number) => (previews.length ? previews[rank % previews.length] : null);
  const artist = summary.topArtists[0];
  const artistSong = artistTrack(summary);
  const slides: Slide[] = [
    { kind: "opening", preview: preview(2) },
    { kind: "minutes", preview: preview(1) },
  ];
  if (artist) slides.push({ kind: "artist", preview: artistSong?.preview ?? null });
  if (summary.topSongs.length) slides.push({ kind: "songs", preview: preview(0) });
  slides.push({ kind: "hour", preview: preview(3) }, { kind: "share", preview: preview(0) });
  return slides;
}

function artistTrack(summary: WrappedRecap) {
  const name = summary.topArtists[0]?.name.toLowerCase();
  return summary.topSongs.find((song) => song.preview && song.artist.toLowerCase() === name);
}

function Fit({
  className,
  max,
  lines = 1,
  children,
}: {
  className: string;
  max: number;
  lines?: number;
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
    <p ref={ref} className={className}>
      {children}
    </p>
  );
}

function usePreviewAudio(src: string | null, muted: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const queue = useAudioQueue();
  const queueRef = useRef(queue);
  queueRef.current = queue;

  useEffect(() => {
    const element = new Audio();
    element.preload = "auto";
    element.addEventListener("playing", () => {
      setPlaying(true);
      if (queueRef.current.isPlaying) queueRef.current.togglePlayPause();
    });
    element.addEventListener("pause", () => setPlaying(false));
    audio.current = element;
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
      audio.current = null;
    };
  }, []);

  useEffect(() => {
    if (audio.current) audio.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const element = audio.current;
    if (!element || !src) return;
    const url = new URL(resolveApiPath(src), window.location.href).href;
    if (element.src === url) return;
    element.src = url;
    element.volume = 0;
    element.play().catch(() => {});
    const started = performance.now();
    let frame = requestAnimationFrame(function fade(now) {
      element.volume = Math.min(1, (now - started) / 800);
      if (element.volume < 1) frame = requestAnimationFrame(fade);
    });
    return () => cancelAnimationFrame(frame);
  }, [src]);

  return {
    playing,
    resume: () => {
      const element = audio.current;
      if (element?.src && element.paused && !element.ended) element.play().catch(() => {});
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

function Opening({ summary, username }: { summary: WrappedRecap; username: string }) {
  const covers = wrappedCovers(summary);
  const year = String(summary.year);
  return (
    <>
      {covers.length > 0 && (
        <div className="wrapped-stack" aria-hidden="true">
          {covers.map((url) => (
            <img key={url} src={wrappedImageUrl(url)} alt="" />
          ))}
        </div>
      )}
      <p className={covers.length ? "wrapped-year wrapped-year--beside" : "wrapped-year"}>
        {year.slice(0, 2)}
        <br />
        {year.slice(2)}
      </p>
      <div className="wrapped-foot">
        <p>Your year in music</p>
        <p className="wrapped-dim">{username}</p>
      </div>
    </>
  );
}

function Minutes({ summary }: { summary: WrappedRecap }) {
  const { minutes, totalPlays, uniqueArtists, uniqueSongs } = summary;
  const span =
    minutes === null || minutes < 60
      ? ""
      : minutes >= 1440
        ? `About ${(minutes / 1440).toLocaleString(undefined, { maximumFractionDigits: 1 })} days of music. `
        : `About ${count(Math.round(minutes / 60), "hour")} of music. `;
  return (
    <div className="wrapped-pad">
      <Fit className="wrapped-fill" max={41}>
        {(minutes ?? totalPlays).toLocaleString()}
      </Fit>
      <p className="wrapped-word">{minutes === null ? "plays" : "minutes"}</p>
      <p className="wrapped-body">
        {minutes === null
          ? `${count(uniqueArtists, "artist")} and ${count(uniqueSongs, "song")}.`
          : `${span}${count(totalPlays, "play")} across ${count(uniqueArtists, "artist")}.`}
      </p>
    </div>
  );
}

function Artist({ summary, playing }: { summary: WrappedRecap; playing: boolean }) {
  const artist = summary.topArtists[0];
  const song = artistTrack(summary);
  if (!artist) return null;
  return (
    <>
      {artist.artwork && (
        <img className="wrapped-hero" src={wrappedImageUrl(artist.artwork)} alt="" />
      )}
      <div className="wrapped-pad wrapped-bottom">
        <Fit className="wrapped-artist" max={37} lines={3}>
          {artist.name}
        </Fit>
        <p className="wrapped-body">Your top artist. {count(artist.plays, "play")}.</p>
        {song && playing && (
          <p className="wrapped-now">
            <span className="wrapped-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Playing {song.name}
          </p>
        )}
      </div>
    </>
  );
}

function Songs({ summary }: { summary: WrappedRecap }) {
  return (
    <div className="wrapped-pad">
      <h2 className="sr-only">Your top songs</h2>
      <ol className="wrapped-rank">
        {summary.topSongs.slice(0, 5).map((song, index) => (
          <li key={song.key}>
            <span className="wrapped-rank-number">{index + 1}</span>
            <span className="wrapped-rank-title">{song.name}</span>
            <span className="wrapped-rank-artist">{song.artist}</span>
          </li>
        ))}
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
        <Fit className="wrapped-hour" max={50}>
          {hourLabel(hour)}
        </Fit>
        <p className="wrapped-word wrapped-word--small">was your hour.</p>
        <p className="wrapped-body">
          {count(peak, "play")} started in this hour. That is {share}% of your year.
        </p>
      </div>
      <div className="wrapped-histogram" aria-hidden="true">
        {summary.hours.map((plays, index) => (
          <i
            key={index}
            className={index === hour ? "wrapped-peak" : undefined}
            style={{ height: `${Math.max(2, (plays / peak) * 100)}%` }}
          />
        ))}
      </div>
      <div className="wrapped-axis" aria-hidden="true">
        <span>{hourLabel(0)}</span>
        <span>{hourLabel(12)}</span>
        <span>{hourLabel(23)}</span>
      </div>
    </>
  );
}

function ShareCard({ image, alt }: { image: ShareImage; alt: string }) {
  if (image === "failed")
    return (
      <div className="wrapped-pad wrapped-notice">
        <p className="wrapped-body">Your share card could not be created.</p>
      </div>
    );
  return image ? <img className="wrapped-card" src={image.url} alt={alt} /> : null;
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
  const [index, setIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const slide = slides[index];
  const fieldOf = (position: number) => palette[position % palette.length];
  const field = fieldOf(index);
  const image = useShareImage(summary, fieldOf(slides.length - 1), username);
  const nowPlaying = slides.slice(0, index + 1).findLast((entry) => entry.preview)?.preview ?? null;
  const audio = usePreviewAudio(nowPlaying, muted);
  const hasAudio = slides.some((entry) => entry.preview);
  const last = index === slides.length - 1;

  useEffect(() => {
    let active = true;
    const text = [
      ...summary.topArtists.map((artist) => artist.name),
      ...summary.topSongs.slice(0, 5).flatMap((song) => [song.name, song.artist]),
      username,
    ].join("");
    loadWrappedFonts(`${text}0123456789,.%`).finally(() => active && setFontsReady(true));
    for (const url of [...wrappedCovers(summary), summary.topArtists[0]?.artwork ?? ""])
      if (url) new Image().src = wrappedImageUrl(url);
    return () => {
      active = false;
    };
  }, [summary, username]);

  const go = (step: number) => {
    audio.resume();
    setIndex((current) => Math.min(slides.length - 1, Math.max(0, current + step)));
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
    const bounds = event.currentTarget.getBoundingClientRect();
    go(event.clientX - bounds.left < bounds.width * 0.3 ? -1 : 1);
  };
  const stop = (event: MouseEvent) => event.stopPropagation();
  const style: CSSProperties = { "--wrapped-field": field, "--wrapped-ink": wrappedInk(field) };

  return (
    <>
      <div
        className="wrapped-frame"
        style={style}
        onClick={tap}
        role="group"
        aria-roledescription="slide"
        aria-label={`${index + 1} of ${slides.length}`}
      >
        <div className="wrapped-progress" aria-hidden="true">
          {slides.map((entry, position) => (
            <i key={entry.kind} className={position <= index ? "wrapped-seen" : undefined} />
          ))}
        </div>
        <div className="wrapped-controls" onClick={stop}>
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
        {fontsReady && (
          <div key={slide.kind} className={`wrapped-slide wrapped-slide--${slide.kind}`}>
            {slide.kind === "opening" && <Opening summary={summary} username={username} />}
            {slide.kind === "minutes" && <Minutes summary={summary} />}
            {slide.kind === "artist" && (
              <Artist
                summary={summary}
                playing={audio.playing && !muted && nowPlaying === slide.preview}
              />
            )}
            {slide.kind === "songs" && <Songs summary={summary} />}
            {slide.kind === "hour" && <Hour summary={summary} />}
            {slide.kind === "share" && (
              <ShareCard image={image} alt={`${username}'s ${summary.year} in music`} />
            )}
          </div>
        )}
      </div>
      <div className="wrapped-actions">{last && actions(image)}</div>
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
