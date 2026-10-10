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
  unreachable: "aurral.org can't reach your server yet. Your links won't play until it can. Aurral keeps retrying.",
  unavailable: "cloudflared isn't installed on your server, so these links can't play.",
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

  const copy = async (link) => {
    try {
      const outcome = await shareLink(link.url, link.title);
      if (outcome === "copied") showSuccess?.(`Copied the link for ${link.title}`);
    } catch {
      showError?.("Could not copy the link. Try again from a secure (https) address.");
    }
  };

  const items = links.data?.links || [];
  const tunnelNote = items.length ? TUNNEL_NOTES[links.data?.tunnel] : null;

  return (
    <div className={`settings-page__section${className ? ` ${className}` : ""}`}>
      <div className="settings-page__section-intro">
        <h3 className="settings-page__section-title">Shared links</h3>
        <p className="settings-page__section-note">
          Links that let people play music from your Aurral. Stopping one ends it right away.
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
          No shared links. Turn on Play from my Aurral when you share an artist, album, or track.
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
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => copy(link)}>
                      Copy link
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
