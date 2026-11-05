import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { AlertCircle, Mic } from "./icons";
import StatePanel from "./StatePanel";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { queryKeys } from "../queryClient";
import { lyricsClient } from "../utils/api/clients/lyrics";

const TICK_MS = 250;
const MANUAL_SCROLL_HOLD_MS = 3000;

type PlayerTrack = NonNullable<ReturnType<typeof useAudioQueue>["currentTrack"]>;

function lyricsLookup(track: PlayerTrack) {
  const hasLibraryFile = track.libraryAlbumId != null && track.libraryTrackId != null;
  return {
    artist: track.artist || "",
    title: track.title || "",
    ...(track.album ? { album: track.album } : {}),
    ...(track.durationMs ? { durationMs: String(track.durationMs) } : {}),
    ...(hasLibraryFile
      ? {
          libraryAlbumId: String(track.libraryAlbumId),
          libraryTrackId: String(track.libraryTrackId),
        }
      : {}),
  };
}

function useActiveLine(lines: { start?: number }[], synced: boolean) {
  const { getPosition } = useAudioQueue();
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!synced) return undefined;
    const tick = () => {
      const position = getPosition() * 1000;
      setActive(lines.findLastIndex((line) => (line.start ?? 0) <= position));
    };
    tick();
    const interval = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(interval);
  }, [getPosition, lines, synced]);
  return [active, setActive] as const;
}

export default function PlayerLyrics({
  track,
  variant,
}: {
  track: PlayerTrack;
  variant: "panel" | "sheet" | "fullscreen";
}) {
  const { seek } = useAudioQueue();
  const lookup = lyricsLookup(track);
  const lyricsQuery = useQuery({
    queryKey: queryKeys.lyrics(lookup),
    queryFn: ({ signal }) =>
      parseResponse(lyricsClient.$get({ query: lookup }, { init: { signal } })),
    staleTime: Infinity,
  });
  const lyrics = lyricsQuery.data?.lyrics;
  const lines = lyrics?.lines ?? [];
  const synced = lyrics?.synced === true;
  const [active, setActive] = useActiveLine(lines, synced);
  const listRef = useRef<HTMLOListElement>(null);
  const manualScrollAt = useRef(0);

  useEffect(() => {
    const list = listRef.current;
    const line = list?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (!list || !line || Date.now() - manualScrollAt.current < MANUAL_SCROLL_HOLD_MS) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({
      top: line.offsetTop - list.clientHeight / 2 + line.offsetHeight / 2,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [active]);

  const className = `player-lyrics player-lyrics--${variant}`;

  if (lyricsQuery.isPending) {
    return (
      <div className={className} aria-busy="true" aria-label="Loading lyrics">
        <div className="player-lyrics__skeleton">
          {[78, 60, 72, 48, 66].map((width) => (
            <span key={width} style={{ width: `${width}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (lyricsQuery.isError) {
    return (
      <div className={className}>
        <StatePanel
          icon={<AlertCircle />}
          title="Couldn't load lyrics"
          role="alert"
          onRetry={() => lyricsQuery.refetch()}
          retrying={lyricsQuery.isFetching}
        />
      </div>
    );
  }

  if (!lines.length) {
    return (
      <div className={className}>
        <StatePanel
          icon={<Mic />}
          title="No lyrics found"
          message={
            lookup.libraryTrackId ? "Add a .lrc file next to the track to use your own." : null
          }
        />
      </div>
    );
  }

  const holdAutoScroll = () => {
    manualScrollAt.current = Date.now();
  };

  return (
    <ol
      ref={listRef}
      className={`${className}${synced ? " is-synced" : ""}`}
      aria-label={`Lyrics for ${track.title}`}
      onWheel={holdAutoScroll}
      onTouchMove={holdAutoScroll}
    >
      {lines.map((line, index) => {
        const text = line.value || "♪";
        if (!synced) {
          return (
            <li key={index} className="player-lyrics__line">
              {text}
            </li>
          );
        }
        const state = index === active ? " is-active" : index < active ? " is-past" : "";
        return (
          <li key={index} data-line={index}>
            <button
              type="button"
              className={`player-lyrics__line${state}`}
              aria-current={index === active || undefined}
              onClick={() => {
                manualScrollAt.current = 0;
                seek((line.start ?? 0) / 1000);
                setActive(index);
              }}
            >
              {text}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
