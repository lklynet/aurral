import { useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { wrappedClient } from "../utils/api/clients/wrapped.ts";
import { wrappedCovers, wrappedImageUrl } from "../utils/wrappedShare.ts";
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
  const covers = wrappedCovers(summary);
  const artwork = covers.length < 4 ? covers.slice(0, 1) : covers;
  const hideSession = () => {
    setHiddenSession(sessionKey);
    try {
      sessionStorage.setItem(sessionKey, "1");
    } catch {}
  };
  return (
    <section className="wrapped-announcement" aria-labelledby={headingId}>
      {artwork.length > 0 && (
        <div className="wrapped-announcement-art" aria-hidden="true">
          {artwork.map((url) => (
            <img key={url} src={wrappedImageUrl(url)} alt="" loading="lazy" />
          ))}
        </div>
      )}
      <div className="wrapped-announcement-body">
        <h2 id={headingId}>Your {year} Wrapped is ready.</h2>
        <div className="wrapped-announcement-actions">
          <Link
            className="btn btn-primary"
            to="/wrapped"
            state={{ wrappedFrom: `${location.pathname}${location.search}${location.hash}` }}
          >
            Open
          </Link>
          <LibraryItemMenu
            label="Wrapped"
            triggerClassName="btn btn-ghost btn-icon"
            contextMenu={false}
            items={[
              { id: "now", label: "Hide for now", onSelect: hideSession },
              {
                id: "year",
                label: "Hide for this year",
                disabled: dismissal.isPending,
                onSelect: () => dismissal.mutate(true),
              },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
