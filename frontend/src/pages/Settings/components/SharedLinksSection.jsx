import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../../contexts/AuthContext";
import { queryKeys } from "../../../queryClient";
import { deleteShareLink, getShareLinks } from "../../../utils/api/endpoints/shareLinks";
import { formatDate, formatRelativeTime } from "../../../utils/dateTime";
import { shareLink } from "../../../utils/shareLink";
import { DotLoader } from "../../../components/DotLoader";

const KIND_LABELS = { artist: "Artist", album: "Album", track: "Track" };
const TUNNEL_NOTES = {
  starting: "Connecting your links to aurral.org…",
  unreachable: "Links cannot play yet. Retrying the connection to aurral.org.",
  unavailable: "Install cloudflared on your server to enable playback links.",
};

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function describeExpiry(expiresAt) {
  if (!expiresAt) return "Never expires";
  const date = new Date(expiresAt);
  return expiresAt - Date.now() < TWO_DAYS_MS
    ? `Expires ${formatRelativeTime(date)}`
    : `Expires ${formatDate(date)}`;
}

function describeLink(link) {
  return [
    KIND_LABELS[link.kind] || "Link",
    link.artistName && link.kind !== "artist" ? link.artistName : null,
    describeExpiry(link.expiresAt),
    link.allowDownload ? "Downloads allowed" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SharedLinksSection({ showSuccess, showError, className = "" }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.shareLinks(user?.id);
  const links = useQuery({
    queryKey,
    queryFn: ({ signal }) => getShareLinks({ signal }),
    enabled: user?.id != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.links?.length && data.tunnel !== "online" ? 5000 : false;
    },
  });
  const stop = useMutation({
    mutationFn: (link) => deleteShareLink(link.id),
    onSuccess: (_, link) => {
      queryClient.setQueryData(queryKey, (current) => ({
        ...current,
        links: (current?.links || []).filter((entry) => entry.id !== link.id),
      }));
      showSuccess?.(`Stopped sharing ${link.title}.`);
    },
    onError: (error) => {
      showError?.(
        error.response?.data?.message || "Could not stop sharing. The link still works. Try again.",
      );
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const share = async (link) => {
    try {
      const outcome = await shareLink(link.url, link.title);
      if (outcome === "copied") showSuccess?.(`Copied the link for ${link.title}`);
    } catch {
      showError?.("Could not share the link. Open Aurral over HTTPS and retry.");
    }
  };

  const items = links.data?.links || [];
  const tunnelNote = items.length ? TUNNEL_NOTES[links.data?.tunnel] : null;

  return (
    <div className={`settings-page__section${className ? ` ${className}` : ""}`}>
      <div className="settings-page__section-intro">
        <h3 className="settings-page__section-title">Shared links</h3>
        <p className="settings-page__section-note">
          Stopping a link ends access immediately.
        </p>
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
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => share(link)}>
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
