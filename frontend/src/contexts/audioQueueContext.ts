import { createContext, useContext } from "react";
import type {
  ArtworkTarget,
  QueueEntry,
  QueueSource,
  QueueTrackInput,
  RepeatMode,
} from "../utils/audioQueue.ts";

export type AudioQueueValue = {
  queue: QueueEntry[];
  upcoming: { index: number; track: QueueEntry }[];
  currentTrack: QueueEntry | null;
  currentIndex: number;
  source: QueueSource | null;
  playbackError: string | null;
  isActive: boolean;
  isPlaying: boolean;
  isLoading: boolean;
  isStarting: boolean;
  duration: number;
  getPosition: () => number;
  getBufferedEnd: () => number;
  seek: (position: number) => void;
  volume: number;
  muted: boolean;
  setVolume: (volume: number) => void;
  setMuted: (muted: boolean) => void;
  toggleMute: () => void;
  isShuffleEnabled: boolean;
  setShuffleEnabled: (enabled: boolean) => void;
  repeatMode: RepeatMode;
  toggleRepeat: () => void;
  playQueue: (
    tracks: QueueTrackInput[],
    options?: {
      startTrackId?: string | number | null;
      source?: QueueSource | null;
      shuffle?: boolean;
    },
  ) => boolean;
  playTrack: (
    track: QueueTrackInput,
    options?: { queue?: QueueTrackInput[]; source?: QueueSource | null },
  ) => boolean;
  togglePlayPause: () => void;
  playNext: () => void;
  playPrevious: () => void;
  clearQueue: () => void;
  skipTo: (playbackIndex: number) => void;
  toggleShuffle: () => void;
  matchesSource: (candidate: Partial<QueueSource> | null | undefined) => boolean;
  queueNext: (
    tracks: QueueTrackInput | QueueTrackInput[],
    options?: { source?: QueueSource | null },
  ) => false | "started" | "queued";
  addToQueue: (
    tracks: QueueTrackInput | QueueTrackInput[],
    options?: { source?: QueueSource | null },
  ) => false | "started" | "queued";
  removeFromQueue: (entryId: string) => void;
  reorderUpcoming: (entryIds: string[]) => void;
  clearUpcoming: () => () => void;
  updateQueueArtwork: (
    target: ArtworkTarget,
    artwork: string | null,
    artworkSource?: string | null,
  ) => void;
};

export const AudioQueueContext = createContext<AudioQueueValue | null>(null);

export function useAudioQueue() {
  const context = useContext(AudioQueueContext);
  if (!context) {
    throw new Error("useAudioQueue must be used within AudioQueueProvider");
  }
  return context;
}
