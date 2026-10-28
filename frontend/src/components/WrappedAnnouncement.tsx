import { useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { wrappedClient } from "../utils/api/clients/wrapped.ts";
import { resolveApiPath } from "../utils/api/core.ts";
import { useWrapped, wrappedTimeZone } from "../hooks/useWrapped.ts";
import "./wrapped-announcement.css";

export default function WrappedAnnouncement() {
  const { user } = useAuth();
  const location = useLocation();
  const client = useQueryClient();
  const toast = useToast();
  const headingId = useId();
  const query = useWrapped();
  const year = query.data?.year;
  const sessionKey = `aurral-wrapped-hidden:${user?.id}:${year}`;
  const [hiddenSession, setHiddenSession] = useState<string | null>(null);
  let sessionHidden = hiddenSession === sessionKey;
  try {
    sessionHidden ||= sessionStorage.getItem(sessionKey) === "1";
  } catch {}
  const dismissal = useMutation({
    mutationFn: (hidden: boolean) =>
      parseResponse(wrappedClient.banner.$put({ json: { hidden, timeZone: wrappedTimeZone() } })),
    onSuccess: (data) => {
      client.setQueriesData({ queryKey: ["wrapped"] }, data);
      if (data.bannerHidden)
        toast.showInfo({
          message:
            "Wrapped is hidden until next year. You can still open it from your profile menu.",
          action: { label: "Undo", onClick: () => dismissal.mutate(false) },
        });
    },
    onError: () => toast.showError("Wrapped could not be hidden. Try again."),
  });
  const summary = query.data?.summary;
  if (
    !summary?.totalPlays ||
    query.data?.bannerHidden ||
    sessionHidden ||
    location.pathname === "/wrapped"
  )
    return null;
  const artwork = [...summary.topAlbums, ...summary.topArtists, ...summary.topSongs]
    .flatMap((item) => (item.artwork ? [item.artwork] : []))
    .filter((url, index, urls) => urls.indexOf(url) === index)
    .slice(0, 4);
  const hideSession = () => {
    setHiddenSession(sessionKey);
    try {
      sessionStorage.setItem(sessionKey, "1");
    } catch {}
  };
  return (
    <section className="wrapped-announcement" aria-labelledby={headingId}>
      <div className="wrapped-announcement-heading">
        {artwork.length > 0 ? (
          <div className="wrapped-announcement-art" aria-hidden="true">
            {artwork.map((url) => (
              <img
                key={url}
                src={url.startsWith("/api/") ? resolveApiPath(url) : url}
                alt=""
                loading="lazy"
              />
            ))}
          </div>
        ) : (
          <span className="wrapped-announcement-year" aria-hidden="true">
            {year}
          </span>
        )}
        <div>
          <h2 id={headingId}>Your {year} Wrapped is ready.</h2>
          <p>{user?.username}&apos;s year in music.</p>
        </div>
      </div>
      <div className="wrapped-announcement-actions">
        <Link
          className="btn btn-primary"
          to="/wrapped"
          state={{ wrappedFrom: `${location.pathname}${location.search}${location.hash}` }}
        >
          Open Wrapped
        </Link>
        <div className="wrapped-announcement-dismissals">
          <button type="button" className="btn btn-ghost" onClick={hideSession}>
            Hide
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={dismissal.isPending}
            onClick={() => dismissal.mutate(true)}
          >
            Hide for this year
          </button>
        </div>
      </div>
    </section>
  );
}
