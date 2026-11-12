import { useId, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { resolveAuthenticatedApiAssetUrl } from "../../../utils/api/core.ts";
import { artistListeningQueryOptions } from "../../../utils/api/endpoints/artists.ts";
import { normalizeStreamQueueTrack } from "../../../utils/audioQueue";
import { getReleaseGroupCoverUrl, type ReleaseGroup } from "../utils";
import { ArtistTrackRow } from "./ArtistTrackRow";

const WEEK_MS = 7 * 86_400_000;
const MIN_ACTIVE_WEEKS = 8;

const plural = (count: number, noun: string) =>
  `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

const timeListened = (durationMs: number) => {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 1) return "";
  return minutes < 90
    ? `about ${plural(minutes, "minute")}`
    : `about ${plural(Math.round(minutes / 60), "hour")}`;
};

const weekLevel = (plays: number, most: number) => {
  if (plays === 0) return 0;
  const share = plays / most;
  return share <= 0.25 ? 1 : share <= 0.6 ? 2 : 3;
};

function WeekStrip({ weeks, since }: { weeks: number[]; since: number }) {
  const [active, setActive] = useState<number | null>(null);
  const last = weeks.length - 1;
  const most = Math.max(...weeks);
  const describe = (index: number) => {
    const start = new Date(since + index * WEEK_MS);
    const label = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `Week of ${label} · ${plural(weeks[index] ?? 0, "play")}`;
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * weeks.length);
    setActive(Math.min(last, Math.max(0, index)));
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? last;
    const next =
      event.key === "ArrowLeft"
        ? current - 1
        : event.key === "ArrowRight"
          ? current + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(Math.min(last, Math.max(0, next)));
  };
  const shown = active ?? last;

  return (
    <div className="artist-listening__strip">
      <div
        className="artist-listening__weeks"
        role="slider"
        tabIndex={0}
        aria-label="Weekly plays"
        aria-valuemin={1}
        aria-valuemax={weeks.length}
        aria-valuenow={shown + 1}
        aria-valuetext={describe(shown)}
        onKeyDown={step}
        onPointerDown={point}
        onPointerMove={point}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setActive(null);
        }}
        onBlur={() => setActive(null)}
      >
        {weeks.map((plays, index) => (
          <span
            key={since + index * WEEK_MS}
            className={`is-level-${weekLevel(plays, most)}${index === active ? " is-active" : ""}`}
          />
        ))}
      </div>
      <div className="artist-listening__labels" aria-hidden="true">
        <span>
          {active === null
            ? `Weekly plays · ${new Date(since).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
            : describe(active)}
        </span>
        <span>This week</span>
      </div>
    </div>
  );
}

export function ArtistDetailsListening({
  mbid,
  artistName,
  releaseGroups,
}: {
  mbid: string;
  artistName: string;
  releaseGroups: ReleaseGroup[];
}) {
  const headingId = useId();
  const { data } = useQuery(artistListeningQueryOptions(mbid, artistName));
  const { playTrack, togglePlayPause, matchesSource, currentTrack, isPlaying, isLoading } =
    useAudioQueue();
  const listening = data?.listening;
  if (!listening) return null;

  const source = { type: "artist-listening", id: mbid, label: artistName };
  const fromHere = matchesSource(source);
  const queue = listening.topTracks.flatMap((track) =>
    track.queueTrack ? [normalizeStreamQueueTrack(track.queueTrack)] : [],
  );
  const coverFor = (album: string | null) => {
    const match = album
      ? releaseGroups.find(
          (releaseGroup) =>
            releaseGroup.title?.localeCompare(album, undefined, { sensitivity: "accent" }) === 0,
        )
      : null;
    return getReleaseGroupCoverUrl(match);
  };
  const activeWeeks = listening.weeks.filter((plays) => plays > 0).length;
  const time = timeListened(listening.durationMs);
  const firstPlayed = listening.firstPlayedAt
    ? new Date(listening.firstPlayedAt).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })
    : null;
  const facts = [
    listening.rank ? `Your #${listening.rank} artist in the past year` : null,
    firstPlayed ? `First played ${firstPlayed}` : null,
  ].filter((fact) => fact !== null);

  return (
    <section className="artist-section artist-listening" aria-labelledby={headingId}>
      <div className="artist-listening__summary">
        <h2 className="artist-listening__headline" id={headingId}>
          You’ve played {artistName} {plural(listening.plays, "time")}
          {time ? <span className="artist-listening__dim">, {time}</span> : null}
        </h2>
        {facts.length ? (
          <p className="artist-listening__facts">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </p>
        ) : null}
        {activeWeeks >= MIN_ACTIVE_WEEKS ? (
          <WeekStrip weeks={listening.weeks} since={listening.weeksSince} />
        ) : null}
      </div>
      <div className="artist-tracks" role="list" aria-label={`Your top ${artistName} tracks`}>
        {listening.topTracks.map((track, index) => {
          const entry = track.queueTrack ? normalizeStreamQueueTrack(track.queueTrack) : null;
          const active = Boolean(entry && fromHere && currentTrack?.id === entry.id);
          return (
            <ArtistTrackRow
              key={track.title}
              number={index + 1}
              title={track.title}
              subtitle={track.album}
              artwork={
                resolveAuthenticatedApiAssetUrl(track.queueTrack?.artworkUrl) ||
                coverFor(track.album) ||
                null
              }
              duration={plural(track.plays, "play")}
              active={active}
              playing={active && (isPlaying || isLoading)}
              onPlay={
                entry
                  ? () => (active ? togglePlayPause() : playTrack(entry, { source, queue }))
                  : null
              }
            />
          );
        })}
      </div>
    </section>
  );
}
