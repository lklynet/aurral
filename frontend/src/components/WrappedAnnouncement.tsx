import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { wrappedClient } from "../utils/api/clients/wrapped.ts";
import { wrappedCovers, wrappedImageUrl } from "../utils/wrappedShare.ts";
import { useWrapped, wrappedTimeZone } from "../hooks/useWrapped.ts";

const readSessionFlag = (key: string) => {
  try {
    return sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const writeSessionFlag = (key: string) => {
  try {
    sessionStorage.setItem(key, "1");
  } catch {}
};

export default function WrappedAnnouncement() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { addToast, removeToast, showInfo, showError } = useToast();
  const query = useWrapped();
  const year = query.data?.year;
  const summary = query.data?.summary;
  const sessionKey = `aurral-wrapped-hidden:${user?.id}:${year}`;
  const onWrapped = location.pathname === "/wrapped";
  const from = useRef("");
  useEffect(() => {
    from.current = `${location.pathname}${location.search}${location.hash}`;
  });

  const { mutate: setHidden } = useMutation({
    mutationFn: (hidden: boolean) =>
      parseResponse(wrappedClient.banner.$put({ json: { hidden, timeZone: wrappedTimeZone() } })),
    onSuccess: (data) => {
      client.setQueriesData({ queryKey: ["wrapped"] }, data);
      if (data.bannerHidden)
        showInfo({
          message:
            "Wrapped is hidden until next year. You can still open it from your profile menu.",
          action: { label: "Undo", onClick: () => setHidden(false) },
        });
    },
    onError: (_error, hidden) =>
      showError({
        message: "Wrapped could not be hidden.",
        action: { label: "Try again", onClick: () => setHidden(hidden) },
      }),
  });

  const ready = Boolean(summary?.totalPlays) && !query.data?.bannerHidden;
  const artwork = summary ? wrappedCovers(summary).map(wrappedImageUrl).join("\n") : "";

  useEffect(() => {
    if (!ready) return;
    if (onWrapped) {
      writeSessionFlag(sessionKey);
      return;
    }
    if (readSessionFlag(sessionKey)) return;
    let closedByApp = false;
    const id = addToast(
      {
        title: `Your ${year} Wrapped is ready.`,
        artwork: artwork ? artwork.split("\n") : undefined,
        action: {
          label: "Open",
          onClick: () => {
            closedByApp = true;
            navigate("/wrapped", { state: { wrappedFrom: from.current } });
          },
        },
        onClose: () => {
          if (!closedByApp) setHidden(true);
        },
      },
      "info",
      Infinity,
    );
    return () => {
      closedByApp = true;
      removeToast(id);
    };
  }, [addToast, artwork, navigate, onWrapped, ready, removeToast, sessionKey, setHidden, year]);

  return null;
}
