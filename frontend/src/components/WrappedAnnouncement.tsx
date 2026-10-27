import { useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import {
  buildWrapped,
  getWrappedAnnouncement,
  hideWrappedAnnouncement,
} from "../utils/api/endpoints/wrapped.ts";
import { resolveApiPath } from "../utils/api/core.ts";
import { wrappedSeason } from "../../../lib/wrapped.ts";
import "./wrapped-announcement.css";

export default function WrappedAnnouncement() {
  const { user, bootstrap } = useAuth();
  const location = useLocation();
  const client = useQueryClient();
  const toast = useToast();
  const headingId = useId();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const season = bootstrap?.wrappedPreview ?? wrappedSeason(bootstrap?.appVersion ?? "");
  const year = season?.year;
  const sessionKey = `aurral-wrapped-hidden:${user?.id}:${year}`;
  const [hiddenSession, setHiddenSession] = useState<string | null>(null);
  let sessionHidden = hiddenSession === sessionKey;
  try {
    sessionHidden ||= sessionStorage.getItem(sessionKey) === "1";
  } catch {}
  const queryKey = ["wrapped-announcement", user?.id, year, timeZone];
  const query = useQuery({
    queryKey,
    enabled: Boolean(season && (user?.id ?? 0) > 0),
    queryFn: async ({ signal }) => {
      const announcement = await getWrappedAnnouncement(timeZone, signal);
      if (announcement.state === "missing" && !announcement.hidden) {
        await buildWrapped(announcement.year, timeZone);
        return getWrappedAnnouncement(timeZone, signal);
      }
      return announcement;
    },
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.state ?? "") ? 3000 : 60_000,
  });
  const dismissal = useMutation({
    mutationFn: (hidden: boolean) => {
      if (!season) throw new Error("Wrapped is unavailable");
      return hideWrappedAnnouncement(season.year, timeZone, hidden);
    },
    onSuccess: (data) => {
      client.setQueryData(queryKey, data);
      if (data.hidden)
        toast.showInfo({
          message:
            "Wrapped is hidden until next year. You can still open it from your profile menu.",
          action: { label: "Undo", onClick: () => dismissal.mutate(false) },
        });
    },
    onError: () => toast.showError("Wrapped could not be hidden. Try again."),
  });
  if (!query.data?.ready || query.data.hidden || sessionHidden || location.pathname === "/wrapped")
    return null;
  const hideSession = () => {
    setHiddenSession(sessionKey);
    try {
      sessionStorage.setItem(sessionKey, "1");
    } catch {}
  };
  return (
    <section className="wrapped-announcement" aria-labelledby={headingId}>
      <div className="wrapped-announcement-heading">
        {query.data.artwork.length > 0 ? (
          <div className="wrapped-announcement-art" aria-hidden="true">
            {query.data.artwork.map((url) => (
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
