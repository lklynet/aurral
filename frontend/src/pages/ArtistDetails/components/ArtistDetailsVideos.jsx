import { useEffect, useId, useState } from "react";
import { getArtistVideos } from "../../../utils/api/endpoints/artists.js";
import { DotLoader } from "../../../components/DotLoader";

export function ArtistDetailsVideos({ mbid, artistName, tracks }) {
  const headingId = useId();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setVideos([]);
    setFailed(false);
    setLoading(true);
    getArtistVideos(mbid, artistName, tracks, { signal: controller.signal })
      .then(result => {
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
      <h2 className="artist-section-title" id={headingId}>Videos</h2>
      {loading ? (
        <div className="artist-loading" role="status" aria-label="Finding videos">
          <DotLoader size="xl" label={null} />
        </div>
      ) : (
        <>
          {videos.length > 0 ? (
            <div className={`artist-videos-grid artist-videos-grid--${videos.length}`}>
              {videos.map(video => (
                <div className="artist-video-card" key={video.videoId}>
                  <div className="artist-video">
                    <iframe
                      src={`${video.embedUrl}?rel=0`}
                      title={`${artistName} - ${video.trackTitle}`}
                      loading="lazy"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      referrerPolicy="strict-origin-when-cross-origin"
                      allowFullScreen
                    />
                  </div>
                  <p className="artist-video-title">{video.trackTitle}</p>
                </div>
              ))}
            </div>
          ) : null}
          {failed ? (
            <div className="artist-video-status" role="status">
              <span>{videos.length ? "Some videos could not be loaded." : "Videos could not be loaded."}</span>
              <button type="button" className="btn btn-surface" onClick={() => setAttempt(value => value + 1)}>
                Retry
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
