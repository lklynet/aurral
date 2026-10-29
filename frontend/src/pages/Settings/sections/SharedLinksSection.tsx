import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../../contexts/AuthContext";
import { queryKeys } from "../../../queryClient";
import { parseResponse, type InferResponseType } from "hono/client";
import { shareLinksClient } from "../../../utils/api/clients/shareLinks.ts";
import { formatDate, formatRelativeTime } from "../../../utils/dateTime";
import { shareLink } from "../../../utils/shareLink";
import { DotLoader } from "../../../components/DotLoader";
import { useToast } from "../../../contexts/ToastContext";
import { readApiError } from "../utils/apiError.ts";
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from "../SettingsLayout";
type ShareLinksResponse = InferResponseType<typeof shareLinksClient.$get, 200>;
type ShareLinkResponse = ShareLinksResponse["links"][number];

const KIND_LABELS: Partial<Record<string, string>> = {
  artist: "Artist",
  album: "Album",
  track: "Track",
  playlist: "Playlist",
};
const TUNNEL_NOTES: Partial<Record<ShareLinksResponse["tunnel"], string>> = {
  starting: "Connecting your links to aurral.org…",
  unreachable: "Links cannot play yet. Retrying the connection to aurral.org.",
  unavailable: "Install cloudflared on your server to enable playback links.",
};

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function describeFiles({ shareFiles, expiresAt }: ShareLinkResponse) {
  if (!shareFiles) return null;
  if (!expiresAt) return "Files never expire";
  if (expiresAt <= Date.now()) return "Files expired";
  const date = new Date(expiresAt);
  return expiresAt - Date.now() < TWO_DAYS_MS
    ? `Files expire ${formatRelativeTime(date)}`
    : `Files until ${formatDate(date)}`;
}

function describeLink(link: ShareLinkResponse) {
  return [
    KIND_LABELS[link.kind] || "Link",
    link.artistName && link.kind !== "artist" ? link.artistName : null,
    link.kind === "playlist" ? "Updates daily" : null,
    describeFiles(link),
    link.allowDownload ? "Downloads allowed" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function SharedLinksSection() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.shareLinks(user?.id);
  const links = useQuery({
    queryKey,
    queryFn: ({ signal }) => parseResponse(shareLinksClient.$get(undefined, { init: { signal } })),
    enabled: user?.id != null,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.links?.some(
        (link) => link.shareFiles && (!link.expiresAt || link.expiresAt > Date.now()),
      ) && data.tunnel !== "online"
        ? 5000
        : false;
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
      showSuccess(
        link.kind === "playlist"
          ? `Stopped sharing ${link.title}.`
          : `Stopped sharing files for ${link.title}. The link still works.`,
      );
    },
    onError: (error) => {
      showError(
        readApiError(error).message || "Could not stop sharing. The link still works. Try again.",
      );
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const share = async (link: ShareLinkResponse) => {
    try {
      const outcome = await shareLink(link.url, link.title);
      if (outcome === "copied") showSuccess(`Copied the link for ${link.title}`);
    } catch {
      showError("Could not share the link. Open Aurral over HTTPS and retry.");
    }
  };

  const items = links.data?.links || [];
  const tunnel = links.data?.tunnel;
  const tunnelNote =
    items.some((link) => link.shareFiles && (!link.expiresAt || link.expiresAt > Date.now())) &&
    tunnel
      ? TUNNEL_NOTES[tunnel]
      : null;

  return (
    <SettingsPage title="Shared links">
      <SettingsGroup note="Stopping ends file access right away. A stopped playlist link stops working.">
        {links.isPending ? (
          <p className="settings-loading">
            <DotLoader size="sm" label={null} /> Loading…
          </p>
        ) : links.isError ? (
          <SettingsNote tone="warning">
            Couldn&apos;t load your shared links.{" "}
            <button type="button" className="settings-link" onClick={() => links.refetch()}>
              Try again
            </button>
          </SettingsNote>
        ) : items.length === 0 ? (
          <p className="settings-group__note">
            No shared links. Turn on Share my files when you share music.
          </p>
        ) : (
          <>
            {tunnelNote ? (
              <SettingsNote tone={links.data?.tunnel === "starting" ? "default" : "warning"}>
                {tunnelNote}
              </SettingsNote>
            ) : null}
            {items.map((link) => {
              const stopping = stop.isPending && stop.variables?.id === link.id;
              return (
                <SettingsRow key={link.id} label={link.title} help={describeLink(link)}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => share(link)}
                  >
                    Share link
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => stop.mutate(link)}
                    disabled={stopping}
                  >
                    {stopping
                      ? "Stopping…"
                      : link.kind === "playlist"
                        ? "Stop sharing"
                        : "Stop files"}
                  </button>
                </SettingsRow>
              );
            })}
          </>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
