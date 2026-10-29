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
  type RefObject,
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

const DOODLES = {
  crown: {
    width: 24,
    height: 18,
    strokes: [
      [
        "M19.1 15C19.3 14 20 11.1 20.3 9.1C20.7 7.1 20.9 4 21 3C20.6 3.5 19.3 5 18.4 6C17.5 7 16.2 8.6 15.8 9.2C15.3 8.4 13.9 5.9 13 4.4C12.2 2.9 10.9 0.7 10.5 0C10 0.7 8.6 2.8 7.7 4.4C6.9 5.9 5.7 8.4 5.3 9.2C4.9 8.6 3.7 6.9 2.8 5.9C2 4.9 0.5 3.5 0 3C0.1 4 0.5 7 0.8 9C1.1 11 1.7 14 1.9 15C2.8 15.1 5.7 15.2 7.6 15.3C9.5 15.3 11.5 15.4 13.5 15.3C15.4 15.3 18.2 15.1 19.1 15",
        "M19.1 15C19.3 14 19.7 11 20 9C20.4 7 20.8 4 21 3C20.5 3.5 19.1 4.8 18.2 5.9C17.3 6.9 16.2 8.6 15.8 9.2C15.3 8.4 14.1 5.9 13.3 4.3C12.4 2.8 11 0.7 10.5 0C10 0.7 8.5 2.9 7.7 4.4C6.8 5.9 5.7 8.4 5.3 9.2C4.8 8.6 3.5 7.1 2.6 6C1.8 5 0.4 3.5 0 3C0.2 4 0.6 6.8 0.9 8.8C1.2 10.8 1.7 14 1.9 15C2.9 15 5.8 15.1 7.7 15.1C9.6 15.2 11.6 15.3 13.5 15.3C15.4 15.3 18.2 15.1 19.1 15",
      ],
    ],
  },
  heart: {
    width: 12,
    height: 11,
    strokes: [
      [
        "M4.5 8C3.8 7.3 0.7 4.9 0.1 3.7C-0.5 2.4 0.4 1.3 0.9 0.6C1.3 0 2.4 -0.3 3 -0.1C3.6 0.1 4.2 1.6 4.5 1.9C4.7 1.5 5.4 0.1 6 -0.1C6.6 -0.3 7.7 0 8.2 0.7C8.7 1.3 9.6 2.5 9 3.7C8.4 4.9 5.3 7.4 4.6 8.1",
        "M4.5 8C3.7 7.3 0.5 4.8 -0.1 3.6C-0.7 2.3 0.2 1.1 0.7 0.5C1.3 -0.1 2.6 -0.4 3.2 -0.1C3.8 0.1 4.2 1.6 4.4 1.9C4.6 1.6 5.2 0.2 5.8 0C6.5 -0.2 7.7 -0.1 8.2 0.5C8.8 1.1 9.7 2.3 9.1 3.6C8.5 4.8 5.3 7.4 4.6 8.1",
      ],
    ],
  },
  flame: {
    width: 13,
    height: 20,
    strokes: [
      [
        "M9.1 17C9.2 16.4 9.8 14.4 9.9 13.1C10.1 11.8 10.1 10.1 10 9C9.9 7.9 9.6 7.3 9.4 6.5C9.1 5.7 8.5 4.5 8.3 4.1C8.1 4.6 7.4 6.1 7.1 7.2C6.8 8.2 6.7 10 6.6 10.5C6.5 9.6 6.2 6.8 5.9 5.1C5.6 3.3 4.9 0.9 4.7 0C4.5 0.8 3.8 3 3.4 4.6C3 6.2 2.6 8.7 2.4 9.5C2.3 9.2 2 8.1 1.7 7.4C1.4 6.8 1 5.8 0.8 5.4C0.7 6 0.3 7.7 0.2 8.7C0 9.8 0 10.9 0 11.9C0 12.9 0.2 13.7 0.3 14.6C0.4 15.4 0.6 16.6 0.7 17",
        "M9.1 17C9.2 16.3 9.5 14.3 9.7 13C9.8 11.7 10.1 10.1 10 9C9.9 7.9 9.5 7.2 9.2 6.4C8.9 5.5 8.5 4.5 8.3 4.1C8.1 4.6 7.6 6.1 7.3 7.1C7 8.2 6.7 10 6.6 10.5C6.5 9.6 6.2 6.9 5.9 5.1C5.6 3.4 4.9 0.9 4.7 0C4.5 0.8 3.6 3.1 3.2 4.7C2.8 6.3 2.5 8.7 2.4 9.5C2.3 9.2 2 8 1.8 7.3C1.5 6.6 1 5.8 0.8 5.4C0.7 6 0.4 7.5 0.3 8.6C0.1 9.7 0 10.9 0 11.9C0 12.9 0.2 13.7 0.3 14.6C0.4 15.4 0.6 16.6 0.7 17",
      ],
    ],
  },
  ring: {
    width: 16,
    height: 10,
    strokes: [
      [
        "M3.7 0.7C4 0.8 4.5 0.6 4.9 0.5C5.3 0.5 5.7 0.4 6.1 0.3C6.4 0.3 6.7 0.2 7.1 0.2C7.5 0.2 8 0.2 8.4 0.3C8.9 0.4 9.4 0.5 9.8 0.6C10.1 0.7 10.3 0.9 10.6 1.1C10.9 1.3 11.2 1.5 11.5 1.7C11.7 1.9 12.1 2.2 12.2 2.4C12.4 2.5 12.5 2.6 12.6 2.8C12.6 3 12.6 3.3 12.6 3.6C12.6 3.8 12.8 4.1 12.7 4.4C12.6 4.6 12.3 4.7 12 4.9C11.8 5.2 11.7 5.4 11.5 5.6C11.2 5.8 10.9 5.9 10.6 6.1C10.2 6.3 9.8 6.4 9.5 6.6C9.1 6.7 8.9 6.8 8.5 6.9C8 7 7.4 7.1 6.9 7.1C6.5 7.1 6.2 7.1 5.8 7C5.4 7 4.9 6.9 4.4 6.8C4 6.7 3.5 6.7 3.1 6.6C2.7 6.5 2.4 6.2 2 6.1C1.7 5.9 1.3 5.7 1.1 5.5C0.8 5.3 0.7 5 0.5 4.8C0.3 4.5 -0.1 4.3 -0.3 4.1C-0.4 3.9 -0.3 3.7 -0.2 3.4C-0.2 3.2 -0.2 2.9 -0.1 2.6C0 2.4 0.2 2.1 0.4 1.8C0.6 1.6 0.8 1.3 1.1 1.1C1.3 1 1.5 0.9 1.8 0.8C2.2 0.6 2.8 0.5 3.3 0.3C3.7 0.2 4.1 0 4.5 -0.1C4.9 -0.2 5.3 -0.1 5.8 -0.1C6.2 -0.1 6.9 -0.1 7.4 -0.1C7.9 -0.1 8.4 -0.1 8.9 -0.1C9.4 0 9.9 0 10.3 0.1C10.7 0.3 11.1 0.7 11.3 0.8",
        "M3.7 0.7C3.9 0.6 4.3 0.5 4.7 0.4C5 0.3 5.5 0.2 5.9 0.2C6.3 0.1 6.9 0.1 7.3 0.2C7.7 0.2 8 0.2 8.4 0.3C8.7 0.4 9.2 0.6 9.6 0.7C10 0.8 10.4 0.8 10.7 0.9C11 1.1 11.3 1.4 11.6 1.6C11.8 1.8 12.1 2.1 12.3 2.4C12.4 2.6 12.4 2.8 12.5 3C12.5 3.2 12.6 3.5 12.6 3.7C12.7 3.9 12.7 4 12.6 4.2C12.6 4.4 12.5 4.5 12.3 4.8C12.1 5 11.6 5.4 11.4 5.7C11.1 5.9 11.1 6.1 10.8 6.2C10.5 6.3 9.9 6.2 9.5 6.4C9.2 6.5 8.9 6.8 8.5 6.9C8 7.1 7.5 7 7 7.1C6.6 7.1 6 7.1 5.5 7.1C5.1 7.1 4.9 6.9 4.4 6.8C4 6.7 3.4 6.5 3 6.4C2.5 6.3 2.2 6.3 1.8 6.2C1.5 6 1.2 5.7 0.9 5.5C0.7 5.3 0.5 5.1 0.3 4.9C0.1 4.7 0 4.5 -0.1 4.3C-0.2 4.1 -0.2 3.9 -0.2 3.6C-0.2 3.3 -0.2 2.8 -0.2 2.5C-0.1 2.2 0.1 2.2 0.3 2C0.5 1.8 0.6 1.6 0.9 1.4C1.2 1.1 1.7 1 2.1 0.8C2.5 0.6 2.8 0.5 3.2 0.4C3.6 0.2 3.9 0.2 4.4 0.1C4.9 -0.1 5.5 -0.3 6 -0.4C6.5 -0.5 7 -0.4 7.5 -0.3C7.9 -0.3 8.3 -0.3 8.8 -0.2C9.2 -0.1 9.9 0.2 10.3 0.4C10.8 0.5 11.3 0.6 11.5 0.7",
      ],
    ],
  },
  bang: {
    width: 11,
    height: 16,
    strokes: [
      [
        "M2.9 0C2.8 0.7 2.4 2.9 2.2 4.3C2 5.8 1.7 7.9 1.6 8.6",
        "M2.9 0C2.7 0.7 2.2 2.8 2 4.2C1.8 5.7 1.7 7.9 1.6 8.6",
      ],
      [
        "M1.2 11.7C1.2 11.8 1.2 12 1.1 12.2C1.1 12.3 1.1 12.5 1 12.6",
        "M1.2 11.7C1.2 11.8 1.1 12 1.1 12.1C1.1 12.3 1.1 12.5 1 12.6",
      ],
      [
        "M7.6 0.8C7.5 1.5 7.3 3.7 7.1 5.1C6.8 6.5 6.3 8.4 6.1 9.1",
        "M7.6 0.8C7.5 1.5 7.2 3.5 7 4.9C6.7 6.3 6.2 8.4 6.1 9.1",
      ],
      [
        "M5.7 12C5.7 12 5.6 12.3 5.6 12.4C5.6 12.6 5.5 12.8 5.5 12.9",
        "M5.7 12C5.7 12 5.6 12.3 5.6 12.4C5.6 12.6 5.5 12.8 5.5 12.9",
      ],
    ],
  },
  stopwatch: {
    width: 16,
    height: 18,
    strokes: [
      [
        "M6.5 2.3C6.5 2.2 6.6 1.7 6.6 1.4C6.6 1.1 6.5 0.6 6.5 0.4C6.4 0.4 6 0.4 5.7 0.4C5.4 0.4 5 0.4 4.8 0.4C5.1 0.4 5.9 0.4 6.4 0.3C7 0.3 7.9 0.3 8.2 0.3",
        "M6.5 2.3C6.5 2.1 6.5 1.6 6.5 1.3C6.5 1 6.5 0.6 6.5 0.4C6.4 0.4 5.9 0.3 5.6 0.3C5.3 0.3 4.9 0.4 4.8 0.4C5.1 0.4 6 0.3 6.5 0.3C7.1 0.3 7.9 0.3 8.2 0.3",
      ],
      [
        "M6.5 2.4C6.8 2.4 7.5 2.5 7.9 2.5C8.3 2.6 8.5 2.7 8.9 2.9C9.3 3 9.9 3.2 10.2 3.4C10.6 3.7 10.7 4.1 10.9 4.4C11.2 4.8 11.6 5 11.9 5.4C12.1 5.8 12.2 6.3 12.4 6.7C12.5 7.1 12.7 7.4 12.7 7.8C12.8 8.2 12.7 8.8 12.6 9.3C12.5 9.8 12.4 10.1 12.3 10.5C12.2 10.9 12.2 11.2 12 11.6C11.8 11.9 11.2 12.4 10.9 12.7C10.6 13 10.5 13.2 10.2 13.4C9.9 13.6 9.5 13.9 9.1 14C8.7 14.2 8.2 14.4 7.8 14.5C7.4 14.6 7.1 14.8 6.6 14.8C6.2 14.8 5.6 14.6 5.2 14.6C4.7 14.5 4.5 14.5 4.1 14.3C3.7 14.1 3.3 13.7 2.9 13.4C2.5 13.1 2.2 13 1.9 12.7C1.6 12.4 1.4 11.9 1.2 11.5C0.9 11.1 0.7 10.8 0.5 10.4C0.3 10 0.2 9.5 0.2 9.1C0.2 8.7 0.3 8.3 0.4 7.9C0.5 7.5 0.5 7 0.7 6.6C0.8 6.2 1 5.9 1.2 5.5C1.4 5.1 1.7 4.6 2 4.3C2.2 3.9 2.4 3.6 2.7 3.3C3 3.1 3.4 2.9 3.8 2.8C4.2 2.6 4.8 2.4 5.2 2.3C5.7 2.2 6.3 2.2 6.5 2.2C6.5 3.2 6.5 7.3 6.6 8.4C7 7.9 8.6 5.9 9 5.4",
        "M6.5 2.4C6.8 2.4 7.3 2.3 7.8 2.4C8.2 2.5 8.7 2.6 9.1 2.8C9.5 3 9.9 3.4 10.2 3.7C10.5 3.9 10.9 4.2 11.1 4.5C11.4 4.9 11.5 5.3 11.7 5.6C11.9 5.9 12.3 6.1 12.5 6.5C12.6 6.9 12.5 7.4 12.6 7.9C12.6 8.3 12.6 8.8 12.6 9.3C12.5 9.7 12.4 10 12.3 10.4C12.2 10.8 12.2 11.3 12 11.7C11.8 12.1 11.5 12.3 11.2 12.6C10.9 13 10.6 13.4 10.2 13.6C9.8 13.8 9.4 13.9 9 14.1C8.6 14.3 8.1 14.5 7.7 14.6C7.3 14.7 7 14.8 6.5 14.8C6.1 14.8 5.7 14.6 5.2 14.5C4.8 14.4 4.4 14.2 4 14.1C3.6 13.9 3.2 13.7 2.8 13.5C2.5 13.3 2.2 13.1 1.9 12.8C1.6 12.5 1.2 12.1 1 11.7C0.8 11.3 0.8 10.7 0.7 10.3C0.6 9.9 0.3 9.6 0.2 9.2C0.2 8.8 0.2 8.3 0.3 7.8C0.3 7.4 0.5 6.9 0.6 6.5C0.7 6.1 0.8 5.7 1 5.4C1.2 5 1.4 4.6 1.7 4.3C2 3.9 2.4 3.7 2.8 3.4C3.2 3.1 3.7 2.8 4.1 2.6C4.5 2.4 4.8 2.3 5.2 2.2C5.6 2.2 6.3 2.2 6.5 2.2C6.5 3.3 6.4 7.6 6.4 8.6C6.9 8.1 8.6 5.8 9.1 5.3",
      ],
    ],
  },
  rays: {
    width: 14,
    height: 14,
    strokes: [
      [
        "M4.2 11.2C4.8 11.1 6.3 10.7 7.4 10.4C8.4 10.1 9.8 9.6 10.3 9.5",
        "M4.2 11.2C4.8 11.1 6.2 10.7 7.2 10.4C8.3 10.1 9.8 9.6 10.3 9.5",
      ],
      [
        "M2.6 8.4C3 8 4.2 7 4.9 6.2C5.7 5.5 6.7 4.3 7.1 4",
        "M2.6 8.4C3 8 4.1 6.9 4.9 6.2C5.6 5.4 6.7 4.3 7.1 4",
      ],
      [
        "M-0.2 6.8C0 6.3 0.5 4.8 0.8 3.8C1.1 2.8 1.4 1.2 1.5 0.7",
        "M-0.2 6.8C0 6.2 0.4 4.7 0.7 3.7C1 2.7 1.4 1.2 1.5 0.7",
      ],
    ],
  },
  arrow: {
    width: 19,
    height: 13,
    strokes: [
      [
        "M16 9.5C15.4 9.4 13.8 9.1 12.6 8.9C11.4 8.6 10.3 8.4 9 7.8C7.7 7.3 6.3 6.4 5 5.6C3.6 4.8 1.7 3.4 1 3",
        "M16 9.5C15.4 9.4 13.5 9 12.4 8.7C11.2 8.5 10.3 8.4 9 7.8C7.7 7.3 6.2 6.2 4.8 5.4C3.5 4.6 1.6 3.4 1 3",
      ],
      [
        "M1.2 7.2C1.2 6.9 1.2 5.8 1.2 5.1C1.2 4.4 1 3.4 1 3C1.4 2.9 2.5 2.6 3.3 2.3C4 2.1 5.2 1.7 5.6 1.6",
        "M1.2 7.2C1.2 6.8 1.2 5.7 1.1 5C1.1 4.3 1 3.3 1 3C1.4 2.9 2.6 2.5 3.4 2.3C4.1 2.1 5.2 1.7 5.6 1.6",
      ],
    ],
  },
  notes: {
    width: 14,
    height: 15,
    strokes: [
      [
        "M3.9 10.3C4 10.3 4 10.2 3.9 10.1C3.9 10 3.9 9.9 3.8 9.8C3.7 9.7 3.6 9.6 3.5 9.6C3.4 9.5 3.4 9.4 3.3 9.4C3.3 9.3 3.2 9.3 3.1 9.2C3 9.2 2.8 9.2 2.7 9.2C2.6 9.2 2.5 9.2 2.4 9.2C2.3 9.2 2.2 9.2 2.1 9.2C2 9.2 1.8 9.2 1.7 9.2C1.5 9.2 1.4 9.3 1.3 9.3C1.2 9.4 1.2 9.5 1.2 9.5C1.1 9.6 0.8 9.6 0.7 9.6C0.7 9.7 0.7 9.8 0.6 9.9C0.6 9.9 0.5 10 0.5 10.1C0.5 10.1 0.4 10.2 0.4 10.3C0.5 10.4 0.6 10.5 0.6 10.6C0.6 10.7 0.5 10.8 0.6 10.9C0.6 10.9 0.8 11 0.9 11C1 11.1 1 11.1 1.1 11.1C1.2 11.2 1.3 11.3 1.4 11.3C1.5 11.4 1.6 11.4 1.7 11.4C1.8 11.4 1.9 11.4 2.1 11.4C2.2 11.4 2.4 11.4 2.5 11.4C2.6 11.3 2.5 11.4 2.6 11.3C2.7 11.3 2.9 11.3 3.1 11.3C3.2 11.3 3.3 11.2 3.4 11.1C3.4 11.1 3.6 11 3.6 10.9C3.7 10.8 3.7 10.7 3.8 10.7C3.8 10.6 3.7 10.6 3.8 10.6C3.8 10.5 3.9 10.4 4 10.4C4 10.3 3.9 10.1 3.9 10C3.8 10 3.7 10 3.7 9.9C3.6 9.9 3.6 9.8 3.6 9.7C3.6 9.6 3.8 10.8 3.9 9.4C3.9 8.1 3.8 2.9 3.8 1.7C4.8 1.5 9.1 0.7 10.2 0.6C10.2 1.9 10.3 7.3 10.3 8.7C10.3 10.2 10.4 9.2 10.5 9.4C10.5 9.6 10.5 9.6 10.5 9.7C10.5 9.8 10.5 9.8 10.4 9.9C10.4 9.9 10.2 9.9 10.1 10C10 10.1 10 10.1 10 10.2C9.9 10.2 9.8 10.3 9.7 10.3C9.6 10.4 9.5 10.4 9.4 10.5C9.3 10.5 9.1 10.6 9 10.6C8.9 10.6 8.8 10.6 8.7 10.6C8.6 10.5 8.5 10.6 8.4 10.6C8.2 10.6 8.1 10.6 8 10.5C7.9 10.5 7.8 10.3 7.7 10.3C7.7 10.2 7.6 10.2 7.5 10.2C7.4 10.1 7.4 10 7.4 9.9C7.3 9.8 7.1 9.8 7.1 9.7C7.1 9.6 7.1 9.4 7.1 9.4C7.2 9.3 7.1 9.3 7.2 9.3C7.2 9.2 7.2 9.1 7.3 9C7.3 9 7.3 8.8 7.4 8.7C7.4 8.6 7.5 8.6 7.6 8.6C7.7 8.6 7.8 8.6 7.9 8.5C8 8.5 8.1 8.4 8.2 8.3C8.3 8.3 8.4 8.3 8.5 8.3C8.6 8.3 8.7 8.3 8.9 8.3C9 8.3 9.2 8.2 9.3 8.2C9.4 8.3 9.4 8.4 9.4 8.4C9.5 8.5 9.6 8.5 9.7 8.5C9.8 8.5 9.9 8.5 10 8.6C10.1 8.7 10.2 8.8 10.3 8.9C10.4 9 10.4 8.9 10.5 9C10.5 9 10.5 9.3 10.6 9.4C10.6 9.5 10.6 9.5 10.6 9.6C10.5 9.6 10.5 9.7 10.4 9.8C10.4 9.8 10.2 10 10.2 10C10.1 10.1 10.2 10.1 10.1 10.1C10.1 10.1 9.9 10.3 9.9 10.3",
        "M3.9 10.3C4 10.2 3.8 10.1 3.8 10C3.8 9.9 3.7 9.8 3.7 9.8C3.7 9.7 3.7 9.6 3.6 9.5C3.5 9.5 3.4 9.4 3.3 9.4C3.2 9.3 3.1 9.4 3 9.3C2.9 9.3 2.9 9.1 2.8 9.1C2.7 9.1 2.5 9.1 2.4 9.1C2.3 9.2 2.2 9.2 2.1 9.2C2 9.3 1.7 9.3 1.6 9.3C1.5 9.3 1.4 9.4 1.3 9.4C1.2 9.4 1.2 9.4 1.1 9.4C1 9.4 1 9.5 0.9 9.5C0.8 9.6 0.6 9.8 0.6 9.9C0.5 10 0.6 10.1 0.6 10.1C0.6 10.2 0.5 10.1 0.5 10.2C0.5 10.3 0.6 10.5 0.6 10.6C0.6 10.7 0.6 10.8 0.6 10.8C0.7 10.9 0.7 11 0.7 11.1C0.8 11.1 1 11.1 1.1 11.1C1.2 11.2 1.2 11.2 1.3 11.2C1.4 11.3 1.5 11.4 1.6 11.4C1.7 11.5 1.8 11.4 2 11.4C2.1 11.4 2.2 11.4 2.3 11.4C2.5 11.4 2.6 11.5 2.7 11.4C2.9 11.4 3 11.5 3.1 11.4C3.2 11.3 3.2 11.1 3.3 11.1C3.4 11 3.5 11.1 3.6 11C3.6 11 3.6 10.9 3.7 10.8C3.7 10.7 3.9 10.7 3.9 10.6C4 10.5 3.9 10.5 3.9 10.4C3.9 10.3 3.8 10.3 3.8 10.2C3.8 10.1 3.8 9.9 3.8 9.8C3.8 9.7 3.6 9.7 3.6 9.6C3.6 9.5 3.7 10.6 3.8 9.3C3.8 8 3.8 3 3.8 1.8C4.9 1.6 9.3 0.7 10.4 0.5C10.4 1.9 10.4 7.3 10.5 8.8C10.5 10.2 10.5 9.2 10.5 9.3C10.5 9.5 10.5 9.6 10.5 9.7C10.4 9.8 10.4 9.9 10.3 9.9C10.3 10 10.4 10.1 10.3 10.1C10.2 10.2 10 10.3 9.9 10.3C9.8 10.4 9.8 10.4 9.7 10.4C9.6 10.4 9.6 10.4 9.4 10.5C9.3 10.5 9.1 10.6 8.9 10.6C8.8 10.6 8.8 10.6 8.7 10.6C8.6 10.6 8.5 10.6 8.4 10.6C8.3 10.6 8.1 10.5 8 10.5C7.9 10.4 7.8 10.4 7.7 10.3C7.6 10.2 7.4 10.2 7.4 10.1C7.3 10.1 7.4 10 7.4 9.9C7.3 9.8 7.2 9.8 7.1 9.7C7.1 9.6 7.1 9.5 7.1 9.5C7.1 9.4 7 9.3 7 9.2C7 9.1 7.1 9 7.2 8.9C7.2 8.8 7.2 8.8 7.3 8.8C7.3 8.7 7.5 8.7 7.6 8.6C7.7 8.6 7.8 8.4 7.9 8.4C8 8.3 8.2 8.4 8.3 8.4C8.4 8.4 8.4 8.4 8.5 8.4C8.6 8.3 8.8 8.3 8.9 8.3C9 8.3 9 8.4 9.1 8.4C9.2 8.4 9.3 8.3 9.5 8.3C9.6 8.3 9.8 8.4 9.9 8.4C10 8.5 10 8.5 10.1 8.6C10.1 8.7 10.3 8.7 10.4 8.8C10.4 8.9 10.5 9 10.5 9.1C10.5 9.2 10.5 9.2 10.5 9.3C10.5 9.4 10.6 9.5 10.5 9.5C10.5 9.6 10.4 9.6 10.4 9.7C10.3 9.8 10.2 9.8 10.2 9.9C10.1 10 10.2 10.2 10.1 10.2C10 10.3 9.8 10.3 9.7 10.4",
      ],
    ],
  },
  underline: {
    width: 43,
    height: 7,
    strokes: [
      [
        "M0 1.6C0.8 1.6 3 1.7 4.5 1.6C5.9 1.6 7.3 1.4 8.7 1.3C10.2 1.2 12.3 1 13 0.9C13.8 0.9 16 1 17.5 1.1C19.1 1.1 20.7 1.1 22.3 1.1C23.9 1.2 26.2 1.2 27 1.2C27.8 1.2 30 1.1 31.5 1.1C32.9 1 34.2 1.1 35.7 1C37.1 0.9 39.3 0.7 40 0.6C39.1 0.7 36.5 0.8 34.8 0.9C33.1 1 31.4 1.2 29.7 1.3C28 1.4 26.2 1.4 24.4 1.5C22.7 1.6 20.9 1.9 19.2 2.1C17.5 2.3 16 2.6 14.3 2.8C12.6 3 9.9 3.3 9 3.4C9.8 3.4 12.1 3.5 13.7 3.6C15.3 3.6 16.9 3.7 18.6 3.7C20.2 3.7 21.7 3.7 23.3 3.6C24.9 3.6 26.5 3.6 28.1 3.5C29.7 3.4 32.2 3.3 33 3.2",
        "M0 1.6C0.7 1.6 2.8 1.6 4.2 1.5C5.7 1.4 7.1 1.3 8.6 1.2C10 1.1 12.3 0.9 13 0.9C13.8 0.9 16.2 1 17.7 1C19.2 1.1 20.7 1.2 22.2 1.2C23.8 1.2 26.2 1.2 27 1.2C27.7 1.2 29.8 1.2 31.3 1.2C32.8 1.1 34.3 0.9 35.7 0.8C37.2 0.7 39.3 0.6 40 0.6C39.2 0.6 36.6 0.7 34.9 0.8C33.2 0.9 31.5 1.1 29.7 1.3C28 1.4 26.1 1.5 24.4 1.7C22.6 1.8 20.9 2 19.2 2.2C17.5 2.3 15.9 2.4 14.2 2.6C12.5 2.8 9.9 3.3 9 3.4C9.8 3.4 12.3 3.4 13.9 3.4C15.5 3.5 16.8 3.7 18.4 3.8C20 3.8 21.9 3.8 23.5 3.8C25.2 3.7 26.6 3.4 28.2 3.3C29.7 3.2 32.2 3.2 33 3.2",
      ],
    ],
  },
  circle: {
    width: 83,
    height: 87,
    strokes: [
      [
        "M16 11.9C17.2 11.2 20.5 8.7 22.8 7.5C25.1 6.2 27.5 5 29.9 4.2C32.3 3.4 34.7 2.8 37.2 2.5C39.8 2.3 42.7 2.3 45.4 2.7C48.1 3.1 50.9 3.7 53.4 4.7C55.9 5.7 58.1 7 60.3 8.5C62.4 10 64.6 11.8 66.5 13.8C68.5 15.7 70.4 17.9 71.9 20.1C73.4 22.3 74.6 24.6 75.6 27.1C76.5 29.6 77.1 32.4 77.6 35.1C78.1 37.9 78.9 40.8 78.8 43.6C78.7 46.4 77.9 49 77.2 51.7C76.5 54.4 75.8 57.1 74.7 59.6C73.6 62.2 72.1 64.5 70.4 66.7C68.8 68.9 66.8 71.1 64.8 72.9C62.9 74.8 61 76.5 58.6 77.9C56.2 79.3 53.2 80.4 50.6 81.2C48 82 45.8 82.4 43.2 82.6C40.5 82.7 37.6 82.6 34.9 82.3C32.2 81.9 29.4 81.4 26.8 80.5C24.2 79.6 21.8 78.2 19.5 76.7C17.1 75.2 14.9 73.5 12.9 71.6C10.9 69.6 9.4 67.2 7.7 64.9C6.1 62.5 4.2 60.1 3.1 57.5C2 54.9 1.5 52.3 1 49.5C0.6 46.7 0.3 43.8 0.3 40.9C0.4 38 0.9 35 1.5 32.1C2.1 29.3 3 26.5 4 24C5.1 21.4 6.3 19.2 7.9 16.9C9.6 14.7 12 12.6 14.1 10.6C16.2 8.7 18.4 6.8 20.7 5.4C23.1 4 25.5 3.1 28.1 2.3C30.8 1.5 33.8 0.9 36.7 0.6C39.5 0.3 43.8 0.5 45.2 0.4",
        "M16 11.9C17.1 11 20 8.5 22.3 7.2C24.5 5.9 27 4.7 29.6 3.9C32.2 3.1 35 2.6 37.6 2.4C40.2 2.3 42.6 2.4 45.2 2.8C47.8 3.2 50.5 4.1 53.1 4.9C55.6 5.8 58.1 6.7 60.4 8.2C62.7 9.6 64.8 11.5 66.7 13.5C68.7 15.5 70.6 17.8 72 20.1C73.4 22.4 74.4 24.8 75.4 27.4C76.3 29.9 77.2 32.7 77.7 35.4C78.3 38 78.6 40.5 78.6 43.2C78.6 45.9 78.4 48.6 77.7 51.4C77 54.1 75.6 57.2 74.4 59.8C73.3 62.4 72.4 64.9 70.8 67C69.2 69.1 67 70.7 65 72.5C62.9 74.3 60.9 76.5 58.6 77.9C56.2 79.3 53.5 80.3 50.9 81.1C48.2 81.9 45.2 82.5 42.6 82.7C39.9 82.9 37.6 82.7 34.9 82.3C32.2 81.8 29.2 81 26.5 80.1C23.9 79.2 21.4 78.4 19.1 76.9C16.8 75.5 14.6 73.5 12.6 71.5C10.6 69.5 8.8 67.4 7.3 65.1C5.8 62.8 4.5 60.4 3.5 57.9C2.4 55.3 1.6 52.7 1.1 49.8C0.5 47 0.2 43.5 0.2 40.6C0.2 37.7 0.6 35.3 1.2 32.6C1.8 29.9 2.5 27 3.7 24.4C4.9 21.8 6.8 19.3 8.5 17C10.2 14.8 11.9 12.6 13.9 10.7C16 8.9 18.1 7.3 20.6 5.8C23 4.3 25.8 2.7 28.5 1.7C31.2 0.8 34.1 0.4 36.8 0.2C39.5 -0.1 43.6 0.2 44.9 0.2",
      ],
    ],
  },
  tally: {
    width: 17,
    height: 14,
    strokes: [
      [
        "M1.5 0.2C1.5 1.1 1.4 3.8 1.4 5.5C1.3 7.3 1.3 9.9 1.3 10.8",
        "M1.5 0.2C1.5 1.1 1.3 3.7 1.2 5.5C1.2 7.2 1.3 9.9 1.3 10.8",
      ],
      [
        "M4.6 0.2C4.6 1.1 4.4 3.7 4.3 5.5C4.2 7.3 4.1 9.9 4.1 10.8",
        "M4.6 0.2C4.5 1.1 4.3 3.7 4.2 5.4C4.2 7.2 4.1 9.9 4.1 10.8",
      ],
      [
        "M7.1 0.2C7.1 1.1 7 3.8 7 5.6C6.9 7.3 6.9 9.9 6.9 10.8",
        "M7.1 0.2C7.1 1.1 6.9 3.7 6.9 5.5C6.9 7.2 6.9 9.9 6.9 10.8",
      ],
      [
        "M10.2 0.2C10.2 1.1 10 3.8 9.9 5.5C9.8 7.3 9.7 9.9 9.7 10.8",
        "M10.2 0.2C10.1 1.1 9.9 3.7 9.8 5.5C9.8 7.2 9.7 9.9 9.7 10.8",
      ],
      [
        "M0 8.6C0.8 8.3 3.2 7.3 4.8 6.7C6.3 6 7.8 5.5 9.4 4.8C10.9 4.1 13.2 3 14 2.6",
        "M0 8.6C0.8 8.3 3.2 7.4 4.7 6.7C6.3 6.1 7.8 5.4 9.3 4.7C10.9 4 13.2 3 14 2.6",
      ],
    ],
  },
  sun: {
    width: 18,
    height: 18,
    strokes: [
      [
        "M7.5 4.5C7.7 4.6 8 4.6 8.2 4.6C8.4 4.7 8.6 4.7 8.7 4.8C8.9 4.8 9 4.9 9.2 5C9.3 5.1 9.5 5.2 9.7 5.4C9.9 5.5 10.1 5.7 10.2 5.9C10.3 6.1 10.3 6.3 10.3 6.5C10.4 6.7 10.4 7 10.5 7.2C10.5 7.4 10.6 7.6 10.6 7.8C10.6 8 10.5 8.2 10.4 8.3C10.3 8.5 10.2 8.8 10.1 9C10 9.2 10.1 9.4 9.9 9.5C9.8 9.7 9.5 9.8 9.3 9.9C9.1 10 9 10.2 8.8 10.3C8.7 10.4 8.4 10.4 8.2 10.5C8 10.5 7.8 10.6 7.6 10.6C7.4 10.6 7.3 10.7 7.1 10.6C6.9 10.6 6.5 10.6 6.3 10.5C6.1 10.4 6.1 10.3 5.9 10.2C5.7 10 5.5 9.9 5.4 9.7C5.2 9.6 5 9.5 4.9 9.3C4.8 9.1 4.7 8.9 4.6 8.7C4.5 8.4 4.5 8.3 4.4 8C4.4 7.8 4.5 7.6 4.4 7.3C4.4 7.1 4.3 6.9 4.3 6.7C4.4 6.5 4.5 6.3 4.6 6.1C4.8 6 4.8 5.8 5 5.6C5.1 5.4 5.3 5.2 5.5 5C5.6 4.9 5.8 4.7 6 4.6C6.1 4.6 6.2 4.5 6.5 4.5C6.7 4.4 7 4.4 7.2 4.4C7.5 4.3 7.7 4.3 7.9 4.3C8 4.3 8.3 4.5 8.4 4.5",
        "M7.5 4.5C7.7 4.5 7.9 4.5 8 4.6C8.2 4.6 8.4 4.6 8.6 4.7C8.8 4.7 9.1 4.9 9.3 5C9.4 5.1 9.5 5.2 9.6 5.4C9.8 5.6 9.9 5.8 10.1 6C10.2 6.1 10.3 6.2 10.4 6.4C10.5 6.6 10.5 6.9 10.5 7.1C10.6 7.3 10.6 7.6 10.6 7.8C10.6 8 10.4 8.2 10.4 8.4C10.3 8.6 10.2 8.9 10.2 9C10.1 9.2 10 9.3 9.9 9.4C9.8 9.5 9.6 9.7 9.5 9.8C9.3 10 9 10.2 8.8 10.3C8.6 10.4 8.5 10.5 8.4 10.6C8.2 10.6 7.8 10.5 7.6 10.5C7.4 10.5 7.3 10.6 7.1 10.6C6.9 10.6 6.6 10.5 6.4 10.5C6.2 10.4 5.9 10.3 5.7 10.2C5.6 10.1 5.5 9.9 5.4 9.7C5.2 9.5 5 9.3 4.8 9.2C4.7 9 4.6 8.9 4.5 8.7C4.4 8.5 4.4 8.2 4.3 8C4.3 7.8 4.3 7.6 4.3 7.4C4.3 7.2 4.4 7 4.4 6.8C4.5 6.6 4.6 6.5 4.7 6.2C4.7 6 4.8 5.7 4.9 5.5C5.1 5.3 5.2 5.3 5.4 5.2C5.5 5 5.7 4.9 5.9 4.8C6.1 4.7 6.4 4.6 6.6 4.5C6.8 4.5 7 4.4 7.2 4.4C7.4 4.4 7.6 4.4 7.8 4.4C8 4.4 8.4 4.4 8.5 4.4",
      ],
      [
        "M7.5 0C7.7 0.3 8.2 1.1 8.5 1.7C8.7 2.2 9.1 3 9.3 3.3C9.5 3.2 10.4 2.9 11 2.7C11.6 2.6 12.5 2.3 12.8 2.2C12.7 2.5 12.5 3.3 12.3 3.9C12.2 4.5 11.9 5.4 11.8 5.7C12 5.9 12.7 6.4 13.3 6.7C13.8 7 14.7 7.4 15 7.5C14.7 7.6 13.9 8 13.4 8.3C12.8 8.6 12 9.1 11.8 9.3C11.8 9.6 12.1 10.5 12.3 11.1C12.5 11.7 12.7 12.5 12.8 12.8C12.5 12.7 11.7 12.4 11.2 12.2C10.6 12 9.6 11.8 9.3 11.8C9.1 12 8.6 12.9 8.3 13.5C8 14 7.6 14.8 7.5 15C7.4 14.7 6.9 14 6.6 13.5C6.3 12.9 5.9 12 5.7 11.8C5.5 11.8 4.7 12 4.1 12.2C3.5 12.4 2.5 12.7 2.2 12.8C2.3 12.5 2.5 11.7 2.6 11.1C2.8 10.5 3.2 9.6 3.3 9.3C3 9.1 2.2 8.6 1.7 8.3C1.1 8 0.3 7.6 0 7.5C0.3 7.3 1.2 6.9 1.7 6.6C2.3 6.3 3 5.9 3.3 5.7C3.2 5.4 2.9 4.5 2.8 3.9C2.6 3.3 2.3 2.5 2.2 2.2C2.5 2.3 3.5 2.7 4.1 2.8C4.7 3 5.5 3.2 5.7 3.3C5.9 3 6.3 2.2 6.6 1.6C6.9 1.1 7.4 0.3 7.5 0",
        "M7.5 0C7.6 0.3 8 1 8.3 1.6C8.6 2.1 9.1 3 9.3 3.3C9.6 3.2 10.5 2.8 11.1 2.7C11.7 2.5 12.5 2.3 12.8 2.2C12.7 2.5 12.5 3.5 12.3 4.1C12.2 4.6 11.9 5.5 11.8 5.7C12 5.9 12.9 6.5 13.4 6.8C13.9 7.1 14.7 7.4 15 7.5C14.7 7.7 13.8 8.2 13.3 8.5C12.7 8.8 12 9.1 11.8 9.3C11.9 9.5 12.2 10.3 12.4 10.9C12.5 11.5 12.7 12.5 12.8 12.8C12.5 12.7 11.6 12.4 11 12.2C10.4 12.1 9.6 11.8 9.3 11.8C9.1 12 8.6 12.9 8.3 13.5C8 14 7.6 14.7 7.5 15C7.3 14.7 6.9 13.9 6.6 13.3C6.3 12.8 5.9 12 5.7 11.8C5.5 11.9 4.7 12.2 4.1 12.3C3.5 12.5 2.5 12.7 2.2 12.8C2.3 12.5 2.7 11.6 2.9 11C3 10.5 3.2 9.6 3.3 9.3C3 9.1 2.2 8.7 1.7 8.4C1.1 8.1 0.3 7.7 0 7.5C0.3 7.4 1.1 6.9 1.6 6.6C2.2 6.3 3 5.9 3.3 5.7C3.2 5.5 2.9 4.6 2.7 4C2.5 3.4 2.3 2.5 2.2 2.2C2.5 2.3 3.4 2.7 4 2.8C4.6 3 5.5 3.2 5.7 3.3C5.9 3 6.4 2.1 6.7 1.6C7 1 7.4 0.3 7.5 0",
      ],
    ],
  },
  moon: {
    width: 16,
    height: 17,
    strokes: [
      [
        "M10.3 1.4C10.1 1.3 9.5 1 9.1 0.9C8.7 0.7 8.2 0.6 7.7 0.5C7.2 0.5 6.7 0.4 6.2 0.5C5.8 0.5 5.4 0.6 5 0.7C4.6 0.9 4.2 1 3.9 1.3C3.5 1.5 3 1.9 2.6 2.2C2.3 2.5 2 2.9 1.7 3.3C1.5 3.6 1.3 4.1 1.1 4.5C0.9 4.9 0.8 5.2 0.6 5.6C0.5 6.1 0.4 6.5 0.4 7C0.4 7.5 0.7 8 0.8 8.4C0.8 8.9 0.8 9.2 1 9.7C1.1 10.1 1.4 10.5 1.7 10.9C2 11.2 2.3 11.5 2.6 11.8C2.9 12.1 3.3 12.4 3.7 12.7C4.1 12.9 4.6 13.1 5.1 13.3C5.5 13.4 5.8 13.5 6.2 13.6C6.7 13.6 7.3 13.6 7.8 13.5C8.3 13.4 8.7 13.3 9.1 13.2C9.5 13 10.1 12.8 10.3 12.7C10.1 12.6 9.5 12.4 9.1 12.3C8.7 12.1 8.3 11.9 8 11.7C7.7 11.5 7.5 11.1 7.2 10.8C6.9 10.5 6.4 10.2 6.2 9.9C6 9.5 5.9 9.2 5.8 8.8C5.7 8.4 5.6 8 5.5 7.6C5.5 7.2 5.6 6.7 5.6 6.3C5.6 5.9 5.7 5.5 5.8 5.1C5.9 4.7 6 4.4 6.2 4.1C6.4 3.8 6.8 3.5 7.1 3.2C7.4 2.8 7.7 2.5 8 2.3C8.3 2 8.6 1.9 9 1.8C9.3 1.7 10 1.5 10.3 1.5",
        "M10.3 1.4C10 1.3 9.4 0.9 8.9 0.8C8.5 0.6 8 0.5 7.6 0.4C7.2 0.4 6.8 0.4 6.4 0.4C5.9 0.5 5.3 0.6 4.9 0.7C4.5 0.9 4.1 1.2 3.7 1.4C3.4 1.6 3 1.8 2.7 2C2.4 2.3 2.1 2.8 1.8 3.2C1.5 3.6 1.3 4 1.1 4.5C0.9 4.9 0.7 5.3 0.6 5.7C0.5 6.2 0.4 6.7 0.5 7.1C0.5 7.5 0.6 7.9 0.7 8.3C0.8 8.7 1 9.1 1.1 9.5C1.3 10 1.4 10.5 1.6 10.9C1.9 11.3 2.4 11.7 2.7 11.9C3.1 12.2 3.3 12.3 3.7 12.5C4.1 12.7 4.6 13.1 5.1 13.3C5.5 13.5 5.9 13.5 6.3 13.5C6.7 13.6 7.1 13.6 7.6 13.6C8 13.5 8.6 13.3 9.1 13.2C9.5 13 10 12.6 10.2 12.5C10 12.5 9.3 12.5 9 12.4C8.6 12.2 8.2 11.9 7.9 11.7C7.6 11.4 7.3 11.2 7 10.9C6.7 10.6 6.5 10.3 6.3 10C6.1 9.7 6 9.4 5.8 8.9C5.7 8.5 5.6 7.9 5.5 7.5C5.4 7.1 5.5 6.8 5.5 6.5C5.5 6.1 5.6 5.6 5.7 5.2C5.8 4.9 6.2 4.5 6.4 4.2C6.6 3.8 6.8 3.5 7.1 3.2C7.3 2.9 7.6 2.7 7.9 2.4C8.3 2.1 8.7 1.8 9.1 1.6C9.5 1.4 10.1 1.4 10.3 1.3",
      ],
    ],
  },
};

function Doodle({
  shape,
  className,
  step,
  stretch,
  style,
}: {
  shape: keyof typeof DOODLES;
  className: string;
  step: number;
  stretch?: boolean;
  style?: CSSProperties;
}) {
  const { width, height, strokes } = DOODLES[shape];
  const timing = penTiming(strokes);
  return (
    <svg
      className={`wrapped-doodle ${className}`}
      viewBox={`-1.5 -1.5 ${width} ${height}`}
      preserveAspectRatio={stretch ? "none" : undefined}
      style={{ ...at(step), ...style }}
      aria-hidden="true"
    >
      {strokes.flatMap((pair, index) =>
        pair.map((d, echo) => (
          <path key={`${index}-${echo}`} d={d} pathLength={1} style={timing[index]} />
        )),
      )}
    </svg>
  );
}

function penTiming(strokes: string[][]) {
  let pen = 0;
  return strokes.map(([path]) => {
    const values = path.match(/-?[\d.]+/g)?.map(Number) ?? [];
    let length = 0;
    for (let index = 6; index < values.length; index += 6)
      length += Math.hypot(
        values[index] - values[index - 6],
        values[index + 1] - values[index - 5],
      );
    const time = Math.sqrt(length) * 0.9;
    const timing = { "--at": pen, "--d": time };
    pen += time + 1;
    return timing;
  });
}

function useTextEnd(mark: RefObject<HTMLSpanElement | null>, text: string) {
  const [end, setEnd] = useState<{ left: number; top: number; room: number } | null>(null);
  useLayoutEffect(() => {
    const span = mark.current;
    const line = span?.parentElement;
    const row = span?.closest("li");
    if (!span || !line || !row) return;
    const offset = (node: HTMLElement) => {
      let [left, top] = [0, 0];
      for (let at: Element | null = node; at instanceof HTMLElement && at !== row;) {
        left += at.offsetLeft;
        top += at.offsetTop;
        at = at.offsetParent;
      }
      return { left, top };
    };
    const [tail, box] = [offset(span), offset(line)];
    const unit = row.offsetWidth / 90;
    const left = Math.min(tail.left, box.left + line.clientWidth) / unit;
    setEnd(
      tail.top + span.offsetHeight / 2 > box.top + line.clientHeight
        ? null
        : { left, top: tail.top / unit, room: 93 - left },
    );
  }, [mark, text]);
  return end;
}

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
          {minutes === null ? (
            "plays"
          ) : (
            <>
              minutes
              <Doodle shape="stopwatch" className="wrapped-stopwatch" step={18} />
            </>
          )}
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
  const most = rows.findIndex((row) => row.value === Math.max(...rows.map(({ value }) => value)));
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
            {index === most && <Doodle shape="rays" className="wrapped-rays" step={27} />}
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
            <span className="wrapped-genre-share">
              {percent(genre.plays, summary.totalPlays)}
              {index === 0 && (
                <>
                  <Doodle shape="ring" className="wrapped-ring" step={19} />
                  <Doodle shape="bang" className="wrapped-bang" step={27} />
                </>
              )}
            </span>
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
  const pad = useRef<HTMLDivElement>(null);
  const [crown, setCrown] = useState<CSSProperties | null>(null);
  const name = artist?.name;
  useLayoutEffect(() => {
    const words = [...(pad.current?.querySelectorAll<HTMLElement>(".wrapped-in--word") ?? [])];
    const [first] = words;
    if (!pad.current || !first) return;
    const unit = pad.current.offsetWidth / 90;
    const line = words.filter((word) => word.offsetTop === first.offsetTop);
    const right = Math.max(...line.map((word) => word.offsetLeft + word.offsetWidth)) / unit;
    const scale = Math.min(1, (86.5 - right) / 21);
    setCrown(
      scale < 0.6
        ? null
        : {
            left: `${right + 2}cqw`,
            top: `${(first.offsetTop + first.offsetHeight / 2) / unit - 9 * scale}cqw`,
            width: `${24 * scale}cqw`,
          },
    );
  }, [name]);
  if (!artist) return null;
  return (
    <>
      {artist.artwork && (
        <img className="wrapped-hero" src={wrappedImageUrl(artist.artwork)} alt="" />
      )}
      <div ref={pad} className="wrapped-pad wrapped-bottom">
        <Fit className="wrapped-artist" max={37} lines={3}>
          <Words text={artist.name} from={7} />
        </Fit>
        {crown && (
          <Doodle
            shape="crown"
            className="wrapped-crown"
            step={13 + artist.name.split(" ").length * 1.4}
            style={crown}
          />
        )}
        <p className="wrapped-body wrapped-in" style={at(12)}>
          Your top artist. {count(artist.plays, "play")}.{"\u00a0"}
          <Doodle shape="heart" className="wrapped-heart" step={20} />
        </p>
        {song && playing && <NowPlaying title={song.name} />}
      </div>
    </>
  );
}

function Artists({ summary }: { summary: WrappedRecap }) {
  const mark = useRef<HTMLSpanElement>(null);
  const end = useTextEnd(mark, summary.topArtists[0]?.name ?? "");
  const arrow = end ? Math.min(17, end.room - 2) : 0;
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
            <span className="wrapped-artists-name">
              {artist.name}
              {index === 0 && <span ref={mark} />}
            </span>
            <span className="wrapped-artists-plays">{count(artist.plays, "play")}</span>
            {index === 0 && end && arrow >= 10 && (
              <Doodle
                shape="arrow"
                className="wrapped-arrow"
                step={10}
                style={{
                  left: `${end.left + 2}cqw`,
                  top: `${end.top + 3.5}cqw`,
                  width: `${arrow}cqw`,
                }}
              />
            )}
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
          <Doodle
            shape="notes"
            className="wrapped-notes"
            step={12 + song.name.split(" ").length * 1.4}
          />
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
  const name = withoutEdition(album.name);
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
          <Words text={name} from={7} />
          <Doodle
            shape="underline"
            className="wrapped-underline"
            step={11 + name.split(" ").length * 1.4}
            stretch
          />
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
            >
              {month === peak && <Doodle shape="flame" className="wrapped-flame" step={21} />}
            </i>
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
        <span className="wrapped-date">
          {dayLabel(day.date, { day: "numeric" })}
          <Doodle shape="circle" className="wrapped-circle" step={13} stretch />
        </span>
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
          <Doodle shape="tally" className="wrapped-tally" step={14} />
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
  const mark = useRef<HTMLSpanElement>(null);
  const end = useTextEnd(mark, summary.topSongs[0]?.name ?? "");
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
                {index === 0 && <span ref={mark} />}
              </span>
              <span className="wrapped-rank-artist wrapped-in" style={at(index ? step + 1.4 : 10)}>
                {song.artist}
              </span>
              {index === 0 && end && (
                <Doodle
                  shape="rays"
                  className="wrapped-rays wrapped-rays--rank"
                  step={10}
                  style={{ left: `${end.left + 0.3}cqw`, top: `${end.top - 4.5}cqw` }}
                />
              )}
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
          <Doodle
            shape={hour >= 6 && hour < 18 ? "sun" : "moon"}
            className="wrapped-sky"
            step={23}
          />
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
    if (event.target === event.currentTarget && !event.pseudoElement)
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
