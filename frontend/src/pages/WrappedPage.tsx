import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { useAudioQueue } from "../contexts/audioQueueContext";
import { useToast } from "../contexts/ToastContext";
import { buildWrapped, getWrapped, saveWrappedPlaylist } from "../utils/api/endpoints/wrapped";
import { buildAuthenticatedApiUrl, resolveApiPath } from "../utils/api/core";
import { createWrappedImage, downloadWrappedFile } from "../utils/wrappedShare";
import type { WrappedResponse } from "../../../backend/routes/wrapped.ts";
import type { WrappedSummary } from "../../../backend/services/wrapped/metrics.ts";
import { wrappedSeason } from "../../../lib/wrapped.ts";
import { useModalDialog } from "../hooks/useModalDialog.ts";
import { X } from "../components/icons.tsx";
import TooltipButton from "../components/TooltipButton.tsx";
import "./wrapped.css";

type Summary = WrappedSummary;
const number = (value: number) => value.toLocaleString();
const imageUrl = (url: string) => (url.startsWith("/api/") ? resolveApiPath(url) : url);

function WrappedFrame({
  year,
  onClose,
  children,
}: {
  year: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const { dialogRef } = useModalDialog({ open: true, onClose });
  return createPortal(
    <div className="wrapped-stage">
      <div
        className="wrapped-page"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Your ${year} Aurral Wrapped`}
        tabIndex={-1}
      >
        <header className="wrapped-header">
          <h1>
            Aurral Wrapped <span>{year}</span>
          </h1>
          <TooltipButton
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            label="Close Wrapped"
          >
            <X aria-hidden="true" />
          </TooltipButton>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Opening({
  summary,
  onStart,
  onRecap,
}: {
  summary: Summary;
  onStart: () => void;
  onRecap: () => void;
}) {
  const covers = [...summary.topAlbums, ...summary.topSongs, ...summary.topArtists]
    .flatMap((item) => (item.artwork ? [item.artwork] : []))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .slice(0, 3);
  return (
    <section className="wrapped-opening" aria-label="Your year in music">
      <div className="wrapped-opening-content">
        <h2>
          Your year.
          <br />
          Your music.
        </h2>
        {covers.length > 0 ? (
          <div className="wrapped-sleeves" aria-hidden="true">
            {covers.map((url) => (
              <img key={url} src={imageUrl(url)} alt="" />
            ))}
          </div>
        ) : (
          <p className="wrapped-opening-total">{number(summary.totalPlays)} plays.</p>
        )}
        <p className="wrapped-opening-year">{summary.year}</p>
      </div>
      <div className="wrapped-opening-actions">
        <button type="button" className="btn btn-primary" onClick={onStart}>
          Start your Wrapped
        </button>
        <button type="button" className="btn btn-ghost" onClick={onRecap}>
          View full recap
        </button>
      </div>
    </section>
  );
}

function Rankings({ rows, artist = false }: { rows: Summary["topSongs"]; artist?: boolean }) {
  return (
    <ol className="wrapped-ranking">
      {rows.map((row, index) => (
        <li key={row.key}>
          <span className="wrapped-rank">{index + 1}</span>
          {row.artwork && <img src={imageUrl(row.artwork)} alt="" loading="lazy" />}
          <div>
            <strong>{row.name}</strong>
            {!artist && <span>{row.artist}</span>}
          </div>
          <span className="wrapped-count">{number(row.plays)} plays</span>
        </li>
      ))}
    </ol>
  );
}

function ListeningMonths({ summary }: { summary: Summary }) {
  const max = Math.max(1, ...summary.months.map((month) => month.plays));
  const [selected, setSelected] = useState(summary.months.length - 1);
  const month = summary.months[selected];
  return (
    <div className="wrapped-months">
      <div
        className="wrapped-chart"
        role="group"
        aria-label={summary.months
          .map((month) => `${month.month}: ${month.plays} plays`)
          .join(", ")}
      >
        {summary.months.map((month, index) => (
          <button
            key={month.month}
            type="button"
            className={`btn btn-ghost wrapped-month${index === selected ? " is-selected" : ""}`}
            onClick={() => setSelected(index)}
            aria-pressed={index === selected}
            aria-label={`${month.month}: ${month.plays} plays`}
          >
            <span
              className="wrapped-month-bar"
              style={{ height: `${Math.max(1, (month.plays / max) * 100)}%` }}
            />
            <span>
              {new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(
                new Date(`${month.month}-01T12:00:00Z`),
              )}
            </span>
          </button>
        ))}
      </div>
      {month && (
        <div className="wrapped-month-detail">
          <h3>
            {new Intl.DateTimeFormat(undefined, {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            }).format(new Date(`${month.month}-01T12:00:00Z`))}
          </h3>
          <ol>
            {month.artists
              .filter((artist) => artist.plays)
              .map((artist) => (
                <li key={artist.name}>
                  <span>{artist.name}</span>
                  <span>{artist.plays} plays</span>
                </li>
              ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function SongQuiz({ summary }: { summary: Summary }) {
  const [answer, setAnswer] = useState<string | null>(null);
  const top = summary.topSongs[0];
  const candidates = [...summary.topSongs.slice(0, 4)].sort((a, b) => a.name.localeCompare(b.name));
  const winners = summary.topSongs.filter((song) => song.plays === top.plays);
  return (
    <div className="wrapped-quiz">
      <p>
        {winners.length > 1
          ? "Which song shares your number-one spot?"
          : "Which song did you play most?"}
      </p>
      {candidates.map((song) => (
        <button
          className={`btn btn-ghost wrapped-quiz-choice${answer === song.key ? " is-selected" : ""}`}
          type="button"
          key={song.key}
          disabled={answer !== null}
          onClick={() => setAnswer(song.key)}
        >
          {song.name}
          <span>{song.artist}</span>
        </button>
      ))}
      {answer && (
        <p role="status">
          {winners.some((song) => song.key === answer)
            ? "You know your favorites."
            : `${top.name} came out on top.`}{" "}
          {top.plays} plays
          {winners.length > 1
            ? `, tied with ${winners.length - 1} other ${winners.length === 2 ? "song" : "songs"}`
            : ""}
          .
        </p>
      )}
    </div>
  );
}

function Recap({ summary }: { summary: Summary }) {
  return (
    <div className="wrapped-recap">
      <div className="wrapped-stats">
        <p>
          <strong>{number(summary.totalPlays)}</strong>plays
        </p>
        <p>
          <strong>{number(summary.uniqueArtists)}</strong>artists
        </p>
        <p>
          <strong>{number(summary.uniqueSongs)}</strong>songs
        </p>
      </div>
      <section>
        <h2>Top artists</h2>
        <Rankings rows={summary.topArtists} artist />
      </section>
      <section>
        <h2>Top songs</h2>
        <Rankings rows={summary.topSongs} />
      </section>
      {summary.topAlbums.length > 0 && (
        <section>
          <h2>Top albums</h2>
          <p className="wrapped-note">Ranked by recorded track plays.</p>
          <Rankings rows={summary.topAlbums} />
        </section>
      )}
      {summary.topGenres.length > 0 && (
        <section>
          <h2>Top genres</h2>
          <ol className="wrapped-genres">
            {summary.topGenres.map((genre) => (
              <li key={genre.name}>
                <span>{genre.name}</span>
                <span>{genre.plays} plays</span>
              </li>
            ))}
          </ol>
          <p className="wrapped-note">
            Genre metadata is available for {number(summary.genrePlays)} of{" "}
            {number(summary.totalPlays)} plays.
          </p>
        </section>
      )}
      <section>
        <h2>Your listening year</h2>
        <ListeningMonths summary={summary} />
      </section>
      <div className="wrapped-facts">
        <p>
          <strong>{summary.longestStreak} days</strong>Longest recorded streak
        </p>
        <p>
          <strong>{summary.activeDays} days</strong>With recorded listening
        </p>
        {summary.busiestDay && (
          <p>
            <strong>{summary.busiestDay.plays} plays</strong>On {summary.busiestDay.date}
          </p>
        )}
      </div>
      {summary.listening.timedPlays > 0 && (
        <section>
          <h2>{summary.listening.estimated ? "Estimated listening time" : "Listening time"}</h2>
          <p className="wrapped-minutes">{number(summary.listening.minutes)} minutes</p>
          <p className="wrapped-note">
            Time is available for {number(summary.listening.timedPlays)} of{" "}
            {number(summary.totalPlays)} plays.
            {summary.listening.estimated ? " Includes estimates from track lengths." : ""}
          </p>
        </section>
      )}
    </div>
  );
}

function Stories({ summary, onRecap }: { summary: Summary; onRecap: () => void }) {
  const [index, setIndex] = useState(0);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const artist = summary.topArtists[0];
  const slides = [
    {
      key: "year",
      title: "Your year in music.",
      content: (
        <>
          <p className="wrapped-big-number">{number(summary.totalPlays)}</p>
          <p className="wrapped-story-label">plays. All yours.</p>
          <div className="wrapped-story-facts">
            <p>{number(summary.uniqueArtists)} artists</p>
            <p>{number(summary.uniqueSongs)} songs</p>
          </div>
        </>
      ),
    },
    {
      key: "artist",
      title: "Your top artist",
      content: (
        <>
          <h2 className="wrapped-artist-name">{artist.name}</h2>
          {artist.artwork && (
            <img className="wrapped-story-art" src={imageUrl(artist.artwork)} alt={artist.name} />
          )}
          <p className="wrapped-story-count">
            <strong>{artist.plays}</strong> plays this year
          </p>
        </>
      ),
    },
    {
      key: "songs",
      title: "Your top songs",
      content: <Rankings rows={summary.topSongs.slice(0, 5)} />,
    },
    ...(summary.topAlbums.length
      ? [
          {
            key: "albums",
            title: "Your top albums",
            content: (
              <>
                <Rankings rows={summary.topAlbums} />
                <p className="wrapped-note">By recorded track plays.</p>
              </>
            ),
          },
        ]
      : []),
    ...(summary.topGenres.length
      ? [
          {
            key: "genres",
            title: "Your sound this year",
            content: (
              <>
                <ol className="wrapped-genres wrapped-genres--story">
                  {summary.topGenres.map((genre) => (
                    <li key={genre.name}>{genre.name}</li>
                  ))}
                </ol>
                <p className="wrapped-note">
                  Based on {number(summary.genrePlays)} plays with genre metadata.
                </p>
              </>
            ),
          },
        ]
      : []),
    {
      key: "months",
      title: "Your favorites changed.",
      content: <ListeningMonths summary={summary} />,
    },
    { key: "quiz", title: "One more thing.", content: <SongQuiz summary={summary} /> },
    {
      key: "streak",
      title: "You kept listening.",
      content: (
        <>
          <p className="wrapped-big-number">{summary.longestStreak}</p>
          <p className="wrapped-story-label">days in your longest streak.</p>
          <p>{summary.activeDays} days with recorded listening this year.</p>
        </>
      ),
    },
  ];
  const next = () => (index === slides.length - 1 ? onRecap() : setIndex(index + 1));
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !(event.target instanceof Element) ||
        !event.target.closest(".wrapped-page") ||
        event.target.closest(
          ".wrapped-months, .wrapped-quiz, input, select, textarea, [contenteditable]",
        )
      )
        return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex(Math.max(0, index - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (index === slides.length - 1) onRecap();
        else setIndex(index + 1);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [index, onRecap, slides.length]);
  const slide = slides[Math.min(index, slides.length - 1)];
  return (
    <section className="wrapped-story" aria-label="Your Wrapped stories">
      <div className="wrapped-progress" aria-label={`Story ${index + 1} of ${slides.length}`}>
        {slides.map((slide, i) => (
          <span key={slide.key} className={i <= index ? "is-complete" : ""} />
        ))}
      </div>
      <div
        className="wrapped-slide"
        key={slide.key}
        aria-live="polite"
        onPointerDown={(event) => {
          pointerStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = pointerStart.current;
          pointerStart.current = null;
          if (
            event.button !== 0 ||
            !start ||
            Math.abs(start.x - event.clientX) > 10 ||
            Math.abs(start.y - event.clientY) > 10 ||
            !(event.target instanceof Element) ||
            event.target.closest("button, a, input, select, textarea") ||
            window.getSelection()?.toString()
          )
            return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left + bounds.width / 2) setIndex(Math.max(0, index - 1));
          else next();
        }}
      >
        <h2 className="wrapped-slide-title">{slide.title}</h2>
        {slide.content}
      </div>
      <div className="wrapped-story-controls">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setIndex(index - 1)}
          disabled={index === 0}
        >
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={next}>
          {index === slides.length - 1 ? "See full recap" : "Next"}
        </button>
      </div>
    </section>
  );
}

export default function WrappedPage() {
  const { bootstrap, user, hasPermission } = useAuth();
  const enabled = bootstrap?.api.features.includes("wrapped") === true;
  const [view, setView] = useState<"opening" | "stories" | "recap">("opening");
  const [sharing, setSharing] = useState(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const season = bootstrap?.wrappedPreview ?? wrappedSeason(bootstrap?.appVersion ?? "");
  const year = season?.year ?? new Date().getFullYear();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const queue = useAudioQueue();
  const toast = useToast();
  const queryKey = ["wrapped", user?.id, year, timeZone];
  const query = useQuery({
    queryKey,
    enabled: enabled && season !== null,
    queryFn: async ({ signal }) => {
      const data = await getWrapped(year, timeZone, signal);
      return data.report ? data : buildWrapped(year, timeZone);
    },
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.report?.state ?? "") ? 3000 : false,
  });
  const build = useMutation({
    mutationFn: () => buildWrapped(year, timeZone, true),
    onSuccess: (data) => client.setQueryData<WrappedResponse>(queryKey, data),
    onError: () => toast.showError("Your recap could not be started. Try again."),
  });
  const playlist = useMutation({
    mutationFn: () => saveWrappedPlaylist(year, timeZone),
    onSuccess: (result) => {
      toast.showSuccess(
        `Saved ${result.trackCount} songs${result.unavailableCount ? `; ${result.unavailableCount} unavailable songs were left out` : ""}.`,
      );
      navigate(`/playlists/${encodeURIComponent(result.playlistId)}`);
    },
    onError: () =>
      toast.showError("The playlist could not be saved. Rebuild your recap and try again."),
  });
  if (!enabled) return <Navigate to="/" replace />;
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
  const report = query.data?.report;
  const summary = report?.state === "ready" ? report.summary : null;
  const collecting = report?.state === "queued" || report?.state === "running";
  const share = async () => {
    if (!summary) return;
    setSharing(true);
    try {
      const file = await createWrappedImage(summary);
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `My ${year} Aurral Wrapped` });
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) throw error;
        }
      } else {
        downloadWrappedFile(file);
        toast.showSuccess("Your share image was saved.");
      }
    } catch {
      toast.showError("Your share image could not be created. Try again.");
    } finally {
      setSharing(false);
    }
  };
  const playSongs = () => {
    if (!summary) return;
    const tracks = summary.topSongs.flatMap((song) =>
      song.libraryTrackId && song.libraryAlbumId
        ? [
            {
              id: `song:${song.libraryTrackId}`,
              title: song.name,
              artist: song.artist,
              album: song.album,
              artwork: song.artwork,
              trackMbid: song.mbid,
              src: buildAuthenticatedApiUrl(
                `/library/canonical-stream/${song.libraryAlbumId}/${song.libraryTrackId}`,
              ),
              recordHistory: true,
            },
          ]
        : [],
    );
    if (
      !queue.playQueue(tracks, {
        source: { type: "wrapped", id: year, label: `Your ${year} Wrapped` },
      })
    )
      toast.showError("None of these songs are available in your Library.");
    else toast.showSuccess(`Playing ${tracks.length} songs available in your Library.`);
  };
  return (
    <WrappedFrame year={year} onClose={close}>
      {query.isPending && (
        <div className="wrapped-status" role="status">
          <h2>Your year in music.</h2>
          <p>Loading your recap.</p>
        </div>
      )}
      {query.isError && (
        <div className="wrapped-status" role="alert">
          <h2>Your recap could not be loaded.</h2>
          <button type="button" className="btn btn-primary" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      )}
      {!query.isPending && !query.isError && !summary && (
        <div className="wrapped-status" role="status">
          <h2>Your year in music.</h2>
          <p>
            {collecting
              ? "Collecting your listening history. You can leave this page and come back."
              : report?.state === "failed"
                ? report.message
                : "Bring together the music you kept coming back to."}
          </p>
          {!collecting && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={build.isPending}
              onClick={() => build.mutate()}
            >
              {build.isPending ? "Starting…" : "Build your Wrapped"}
            </button>
          )}
        </div>
      )}
      {summary && summary.totalPlays === 0 && (
        <div className="wrapped-status">
          <h2>
            {summary.sources.some((source) => source.state !== "ready")
              ? "Your listening history is unavailable."
              : "No recorded listening yet."}
          </h2>
          <p>
            {summary.sources.some((source) => source.state !== "ready")
              ? "Check your connections, then try again."
              : "Connect a scrobbler in your Profile, or listen through Aurral to start your recap."}
          </p>
          <Link className="btn btn-primary" to="/profile">
            Open Profile
          </Link>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={build.isPending}
            onClick={() => build.mutate()}
          >
            Try again
          </button>
        </div>
      )}
      {summary && summary.totalPlays > 0 && view === "opening" && (
        <Opening
          summary={summary}
          onStart={() => setView("stories")}
          onRecap={() => setView("recap")}
        />
      )}
      {summary && summary.totalPlays > 0 && view !== "opening" && (
        <>
          <div className="wrapped-view-controls">
            <button
              type="button"
              className="btn btn-ghost"
              aria-pressed={view === "stories"}
              onClick={() => setView("stories")}
            >
              Stories
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              aria-pressed={view === "recap"}
              onClick={() => setView("recap")}
            >
              Full recap
            </button>
            <button type="button" className="btn btn-primary" disabled={sharing} onClick={share}>
              {sharing ? "Creating image…" : "Share your year"}
            </button>
          </div>
          <div className={`wrapped-body wrapped-body--${view}`}>
            {view === "stories" ? (
              <Stories
                key={`${year}:${summary.end}`}
                summary={summary}
                onRecap={() => setView("recap")}
              />
            ) : (
              <Recap summary={summary} />
            )}
            {view === "recap" && (
              <div className="wrapped-actions">
                <button type="button" className="btn btn-secondary" onClick={playSongs}>
                  Play top songs
                </button>
                {hasPermission("accessFlow") && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={playlist.isPending}
                    onClick={() => playlist.mutate()}
                  >
                    {playlist.isPending ? "Saving…" : "Save available songs"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={build.isPending}
                  onClick={() => build.mutate()}
                >
                  Rebuild
                </button>
              </div>
            )}
            {view === "recap" && (
              <footer className="wrapped-coverage">
                <p>
                  {new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: "medium" }).format(
                    summary.start,
                  )}{" "}
                  to{" "}
                  {new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: "medium" }).format(
                    summary.end - 1,
                  )}
                  . Recorded listening only.
                </p>
                {summary.sources.some((source) => source.state !== "ready") && (
                  <p>
                    Some history is unavailable or incomplete:{" "}
                    {summary.sources
                      .filter((source) => source.state !== "ready")
                      .map((source) => source.source)
                      .join(", ")}
                    . Check your connections and rebuild.
                  </p>
                )}
              </footer>
            )}
          </div>
        </>
      )}
    </WrappedFrame>
  );
}
