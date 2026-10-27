import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../../contexts/AuthContext";
import { queryKeys } from "../../../queryClient";
import { parseResponse, type InferResponseType } from "hono/client";
import { shareLinksClient } from "../../../utils/api/clients/shareLinks.ts";
import { formatDate, formatRelativeTime } from "../../../utils/dateTime";
import { shareLink } from "../../../utils/shareLink";
import { DotLoader } from "../../../components/DotLoader";
import type { useToast } from "../../../contexts/ToastContext";
import { readApiError } from "../utils/apiError.ts";

type Toast = ReturnType<typeof useToast>["showSuccess"];
type ShareLinksResponse = InferResponseType<typeof shareLinksClient.$get, 200>;
type ShareLinkResponse = ShareLinksResponse["links"][number];

const KIND_LABELS: Partial<Record<string, string>> = {
  artist: "Artist",
  album: "Album",
  track: "Track",
};
const TUNNEL_NOTES: Partial<Record<ShareLinksResponse["tunnel"], string>> = {
  starting: "Connecting your links to aurral.org…",
  unreachable: "Links cannot play yet. Retrying the connection to aurral.org.",
  unavailable: "Install cloudflared on your server to enable playback links.",
};

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function describeExpiry(expiresAt: number | null) {
  if (!expiresAt) return "Never expires";
  const date = new Date(expiresAt);
  return expiresAt - Date.now() < TWO_DAYS_MS
    ? `Expires ${formatRelativeTime(date)}`
    : `Expires ${formatDate(date)}`;
}

function describeLink(link: ShareLinkResponse) {
  return [
    KIND_LABELS[link.kind] || "Link",
    link.artistName && link.kind !== "artist" ? link.artistName : null,
    describeExpiry(link.expiresAt),
    link.allowDownload ? "Downloads allowed" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SharedLinksSection({
  showSuccess,
  showError,
  className = "",
}: {
  showSuccess: Toast;
  showError: Toast;
  className?: string;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.shareLinks(user?.id);
  const links = useQuery({
    queryKey,
    queryFn: ({ signal }) => parseResponse(shareLinksClient.$get(undefined, { init: { signal } })),
    enabled: user?.id != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.links?.length && data.tunnel !== "online" ? 5000 : false;
    },
  });
  const stop = useMutation({
    mutationFn: (link: ShareLinkResponse) =>
      parseResponse(
        shareLinksClient[":id"].$delete({ param: { id: encodeURIComponent(link.id) } }),
      ),
    onSuccess: (_, link) => {
      queryClient.setQueryData<ShareLinksResponse>(
        queryKey,
        (current) =>
          current && {
            ...current,
            links: current.links.filter((entry) => entry.id !== link.id),
          },
      );
      showSuccess?.(`Stopped sharing ${link.title}.`);
    },
    onError: (error) => {
      showError?.(
        readApiError(error).message || "Could not stop sharing. The link still works. Try again.",
      );
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const share = async (link: ShareLinkResponse) => {
    try {
      const outcome = await shareLink(link.url, link.title);
      if (outcome === "copied") showSuccess?.(`Copied the link for ${link.title}`);
    } catch {
      showError?.("Could not share the link. Open Aurral over HTTPS and retry.");
    }
  };

  const items = links.data?.links || [];
  const tunnel = links.data?.tunnel;
  const tunnelNote = items.length && tunnel ? TUNNEL_NOTES[tunnel] : null;

  return (
    <div className={`settings-page__section${className ? ` ${className}` : ""}`}>
      <div className="settings-page__section-intro">
        <h3 className="settings-page__section-title">Shared links</h3>
        <p className="settings-page__section-note">Stopping a link ends access immediately.</p>
      </div>

      {links.isPending ? (
        <p className="settings-page__muted-copy">
          <DotLoader size="sm" label={null} /> Loading…
        </p>
      ) : links.isError ? (
        <p className="settings-page__hint settings-page__hint--warning">
          Failed to load your shared links.{" "}
          <button type="button" className="settings-page__link" onClick={() => links.refetch()}>
            Try again
          </button>
        </p>
      ) : items.length === 0 ? (
        <p className="settings-page__muted-copy">
          No shared links. Enable Play from my Aurral when sharing music.
        </p>
      ) : (
        <>
          {tunnelNote ? (
            <p
              className={`settings-page__hint${links.data?.tunnel === "starting" ? "" : " settings-page__hint--warning"}`}
              role="status"
            >
              {tunnelNote}
            </p>
          ) : null}
          <ul className="connected-account-list shared-link-list">
            {items.map((link) => {
              const stopping = stop.isPending && stop.variables?.id === link.id;
              return (
                <li key={link.id} className="connected-account-row">
                  <span className="shared-link-row__text">
                    <strong className="shared-link-row__title">{link.title}</strong>
                    <span className="shared-link-row__meta">{describeLink(link)}</span>
                  </span>
                  <span className="shared-link-row__actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => share(link)}
                    >
                      Share link
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => stop.mutate(link)}
                      disabled={stopping}
                    >
                      {stopping ? "Stopping…" : "Stop sharing"}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
