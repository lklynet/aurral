import type { SyntheticEvent } from "react";
import { useLocation } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import RouteLink from "./RouteLink";
import { SortableList } from "./SortableList";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { RotateCcw } from "./icons";
import { usePlaylistArtwork } from "../hooks/usePlaylistArtwork.ts";
import { flowPath, playlistPath } from "../navigation/playlistPaths.ts";
import { PlaylistArtworkThumb } from "./PlaylistArtworkThumb.tsx";
import type { PlaylistStatus } from "../utils/playlistStats.ts";
import { applyCustomOrder } from "../utils/playlistOrder.ts";
import { playlistOrderQueryOptions } from "../queryOptions.ts";
import { usersClient } from "../utils/api/clients/users.ts";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";

type SidebarPlaylistsProps = {
  status: PlaylistStatus;
  iconsOnly: boolean;
  onTooltip?: (event: SyntheticEvent<HTMLElement>) => void;
};

type Entry = { id: string; name: string; kind: string; path: string };

function usePlaylistOrder() {
  const { user } = useAuth();
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const options = playlistOrderQueryOptions(user?.id);
  const { data } = useQuery(options);
  const { mutate } = useMutation({
    mutationFn: (ids: string[]) =>
      parseResponse(usersClient.me["playlist-order"].$put({ json: { ids } })),
    onMutate: (ids) => queryClient.setQueryData(options.queryKey, { ids }),
    onSuccess: (saved) => queryClient.setQueryData(options.queryKey, saved),
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: options.queryKey });
      showError("Couldn't save playlist order");
    },
  });
  return { order: data?.ids ?? [], saveOrder: mutate };
}

function SidebarPlaylistRow({
  entry,
  iconsOnly,
  onTooltip,
}: {
  entry: Entry;
  iconsOnly: boolean;
  onTooltip?: SidebarPlaylistsProps["onTooltip"];
}) {
  const { pathname } = useLocation();
  const { artworkUrlFor } = usePlaylistArtwork();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
  });
  const active = pathname === entry.path;
  return (
    <RouteLink
      ref={setNodeRef}
      to={entry.path}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`sidebar-link sidebar-link--${iconsOnly ? "icons" : "full"} sidebar-playlist${active ? " is-active" : ""}${isDragging ? " is-dragging" : ""}`}
      aria-current={active ? "page" : undefined}
      aria-label={iconsOnly ? entry.name : undefined}
      aria-roledescription={attributes["aria-roledescription"]}
      aria-describedby={attributes["aria-describedby"]}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      onMouseEnter={onTooltip}
      onFocus={onTooltip}
      {...listeners}
    >
      <PlaylistArtworkThumb
        sizes="2rem"
        artworkUrl={artworkUrlFor(entry.id)}
        name={entry.name}
        className="sidebar-playlist__art"
      />
      {iconsOnly ? (
        <span className="sidebar-tooltip">{entry.name}</span>
      ) : (
        <span className="sidebar-player__copy">
          <span className="sidebar-player__title">{entry.name}</span>
          <span className="sidebar-player__subtitle">{entry.kind}</span>
        </span>
      )}
    </RouteLink>
  );
}

function SidebarPlaylists({ status, iconsOnly, onTooltip }: SidebarPlaylistsProps) {
  const { order, saveOrder } = usePlaylistOrder();
  const entries = applyCustomOrder(
    [
      ...status.staticPlaylists.map(({ id, name }) => ({
        id,
        name,
        kind: "Playlist",
        path: playlistPath(id),
      })),
      ...status.flows.map(({ id, name }) => ({ id, name, kind: "Flow", path: flowPath(id) })),
    ],
    order,
  );

  if (entries.length === 0) return null;

  return (
    <nav className="sidebar-playlists" aria-label="Your playlists">
      {iconsOnly ? null : (
        <div className="sidebar-playlists__head-row" data-library-menu-target>
          <RouteLink to="/library/playlists" className="sidebar-playlists__head">
            Playlists
          </RouteLink>
          {order.length > 0 ? (
            <LibraryItemMenu
              label="Playlists"
              triggerLabel="Playlist order"
              triggerClassName="native-library-item-menu__trigger sidebar-playlists__menu"
              items={[
                {
                  id: "reset",
                  label: "Reset order",
                  icon: RotateCcw,
                  onSelect: () => saveOrder([]),
                },
              ]}
            />
          ) : null}
        </div>
      )}
      <SortableList
        ids={entries.map(({ id }) => id)}
        titleOf={(id) => entries.find((entry) => entry.id === id)?.name ?? "Playlist"}
        onReorder={saveOrder}
      >
        <div className="sidebar-playlists__list">
          {entries.map((entry) => (
            <SidebarPlaylistRow
              key={entry.id}
              entry={entry}
              iconsOnly={iconsOnly}
              onTooltip={onTooltip}
            />
          ))}
        </div>
      </SortableList>
    </nav>
  );
}

export default SidebarPlaylists;
