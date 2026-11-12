import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, Play } from "../../../components/icons";
import TooltipButton from "../../../components/TooltipButton";
import { useShelfScroll } from "../hooks/useShelfScroll.ts";
import { getArtistVideos } from "../../../utils/api/endpoints/artists.ts";
import { DotLoader } from "../../../components/DotLoader";
import type { ArtistPreviewTrack } from "../hooks/usePreviewPlayer";

interface ArtistVideo {
  videoId: string;
  embedUrl: string;
  trackTitle: string;
}

interface ArtistDetailsVideosProps {
  mbid: string;
  artistName: string;
  tracks: ArtistPreviewTrack[];
}

export function ArtistDetailsVideos({ mbid, artistName, tracks }: ArtistDetailsVideosProps) {
  const headingId = useId();
  const [videos, setVideos] = useState<ArtistVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const shelf = useShelfScroll(videos.length);

  useEffect(() => {
    const controller = new AbortController();
    setVideos([]);
    setPlayingId(null);
    setFailed(false);
    setLoading(true);
    getArtistVideos(mbid, artistName, tracks, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setVideos(result.videos);
        setFailed(result.failed);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mbid, artistName, tracks, attempt]);

  if (!loading && !failed && videos.length === 0) return null;

  return (
    <section className="artist-section" aria-labelledby={headingId}>
      <div className="artist-section-head">
        <h2 className="artist-section-title" id={headingId}>
          Videos
        </h2>
        {shelf.canScrollLeft || shelf.canScrollRight ? (
          <div className="artist-shelf-nav">
            <TooltipButton
              type="button"
              onClick={() => shelf.scrollBy(-1)}
              className="btn btn-ghost btn-icon-square"
              label="Scroll videos left"
              disabled={!shelf.canScrollLeft}
            >
              <ChevronLeft aria-hidden="true" />
            </TooltipButton>
            <TooltipButton
              type="button"
              onClick={() => shelf.scrollBy(1)}
              className="btn btn-ghost btn-icon-square"
              label="Scroll videos right"
              disabled={!shelf.canScrollRight}
            >
              <ChevronRight aria-hidden="true" />
            </TooltipButton>
          </div>
        ) : null}
      </div>
      {loading ? (
        <div className="artist-loading" role="status" aria-label="Finding videos">
          <DotLoader size="xl" label={null} />
        </div>
      ) : (
        <>
          {videos.length > 0 ? (
            <div ref={shelf.ref} className="artist-videos">
              {videos.map((video) => (
                <div className="artist-video" key={video.videoId}>
                  <div className="artist-video__frame">
                    {playingId === video.videoId ? (
                      <iframe
                        src={`${video.embedUrl}?rel=0&autoplay=1`}
                        title={`${artistName} - ${video.trackTitle}`}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        referrerPolicy="strict-origin-when-cross-origin"
                        allowFullScreen
                      />
                    ) : (
                      <button
                        type="button"
                        className="artist-video__poster"
                        onClick={() => setPlayingId(video.videoId)}
                        aria-label={`Play ${video.trackTitle} video`}
                      >
                        <img
                          src={`https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                        <span className="artist-video__play" aria-hidden="true">
                          <Play />
                        </span>
                      </button>
                    )}
                  </div>
                  <p className="artist-video__title">{video.trackTitle}</p>
                </div>
              ))}
            </div>
          ) : null}
          {failed ? (
            <div className="artist-video-status" role="status">
              <span>
                {videos.length ? "Some videos could not be loaded." : "Videos could not be loaded."}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
