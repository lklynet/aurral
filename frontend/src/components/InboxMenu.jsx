import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  CalendarDays,
  Inbox,
  Music2,
  Newspaper,
  SlidersHorizontal,
  Sparkles,
  Check,
} from "lucide-react";
import {
  getInbox,
  markAllInboxItemsRead,
  updateInboxItem,
} from "../utils/api/endpoints/inbox.js";
import { readStoredNearbyLocation } from "../pages/discoverUtils.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useToast } from "../contexts/ToastContext";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";
import { queryClient, queryKeys } from "../queryClient.js";

const ITEM_ICONS = {
  release: Music2,
  show: CalendarDays,
  news: Newspaper,
  recommendedNews: Newspaper,
  discovery: Sparkles,
};

const isExternalHref = (href) => /^https?:\/\//i.test(String(href || ""));

const formatInboxDate = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  const dateOnly = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const date = new Date(dateOnly ? `${dateOnly}T12:00:00` : text);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)
    : text;
};

const getInboxSubtitle = (item) => {
  const metadata = item.metadata || {};
  if (item.kind === "release") {
    return [
      "New release",
      metadata.artistName,
      formatInboxDate(metadata.releaseDate),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (item.kind === "discovery") return ["New artist discovery", item.subtitle].filter(Boolean).join(" · ");
  if (item.kind === "show") return ["Upcoming show", item.subtitle].filter(Boolean).join(" · ");
  if (item.kind === "news") return ["Library artist news", item.subtitle].filter(Boolean).join(" · ");
  if (item.kind === "recommendedNews") return ["Recommended artist news", item.subtitle].filter(Boolean).join(" · ");
  return item.subtitle;
};

const FILTER_OPTIONS = [
  { value: "all", label: "All notifications" },
  { value: "release", label: "Releases" },
  { value: "show", label: "Shows" },
  { value: "news", label: "Library Artist news" },
  { value: "recommendedNews", label: "Recommended Artist news" },
  { value: "discovery", label: "Discoveries" },
];

function InboxItem({ item, onRemove, onOpen, pendingAction }) {
  const Icon = ITEM_ICONS[item.kind] || Inbox;
  const subtitle =
    item.kind === "show" && Number(item.expiresAt) <= Date.now()
      ? [getInboxSubtitle(item), "Passed"].filter(Boolean).join(" · ")
      : getInboxSubtitle(item);
  const artistNameForLink = String(
    item.metadata?.artistName || (item.kind === "discovery" ? item.title : ""),
  ).trim();
  const isPending = Boolean(pendingAction);
  const content = (
    <>
      <span className="app-inbox-menu__item-icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="app-inbox-menu__item-copy">
        <span className="app-inbox-menu__item-title-row">
          <span className="app-inbox-menu__item-title">{item.title}</span>
        </span>
        {subtitle ? <span className="app-inbox-menu__item-subtitle">{subtitle}</span> : null}
      </span>
    </>
  );

  return (
    <li className={`app-inbox-menu__item${item.isRead ? " is-read" : " is-unread"}`}>
      {item.href ? (
        isExternalHref(item.href) ? (
          <a
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            className="app-inbox-menu__item-link"
            onClick={() => onOpen(item)}
          >
            {content}
          </a>
        ) : (
          <Link
            to={item.href}
            state={artistNameForLink ? { artistName: artistNameForLink } : undefined}
            className="app-inbox-menu__item-link"
            onClick={() => onOpen(item)}
          >
            {content}
          </Link>
        )
      ) : (
        <button type="button" className="app-inbox-menu__item-link" onClick={() => onOpen(item)}>
          {content}
        </button>
      )}
      <span className="app-inbox-menu__item-actions">
        <button
          type="button"
          className="app-inbox-menu__item-action"
          aria-label={`Remove ${item.title} from Inbox`}
          title="Remove from Inbox"
          disabled={isPending}
          onClick={() => onRemove(item)}
        >
          <Check aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

function InboxMenu() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [pendingActions, setPendingActions] = useState({});
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const { user, bootstrap } = useAuth();
  const [inboxEnabled, setInboxEnabled] = useState(true);
  const { showError } = useToast();

  useEffect(() => {
    setInboxEnabled(bootstrap?.inboxEnabled !== false);
  }, [bootstrap?.inboxEnabled]);

  useEffect(() => {
    const handleSettingsUpdated = (event) => {
      if (typeof event.detail?.inboxEnabled === "boolean") setInboxEnabled(event.detail.inboxEnabled);
    };
    window.addEventListener("aurral:settings-updated", handleSettingsUpdated);
    return () => window.removeEventListener("aurral:settings-updated", handleSettingsUpdated);
  }, []);

  const { mode, zip } = readStoredNearbyLocation();
  const locationZip = mode === "zip" ? zip : "";
  const userId = Number.isInteger(Number(user?.id)) && Number(user.id) > 0 ? user.id : null;
  const queryKey = queryKeys.inbox(userId, locationZip, 50);
  const inboxQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getInbox({ zip: locationZip, limit: 50, signal }),
    enabled: inboxEnabled && userId != null,
    refetchInterval: 60 * 1000,
    staleTime: 30 * 1000,
  });
  const items = Array.isArray(inboxQuery.data?.items) ? inboxQuery.data.items : [];
  const unreadCount = Number(inboxQuery.data?.unreadCount || 0);
  const serverRefreshing = inboxQuery.data?.refreshing === true;
  const loadInbox = () => inboxQuery.refetch();
  const itemMutation = useMutation({
    mutationFn: ({ id, action }) => updateInboxItem(id, action),
    onMutate: async ({ id, action }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (current) => {
        if (!current) return current;
        const item = current.items?.find((entry) => entry.id === id);
        if (!item) return current;
        if (action === "dismiss") {
          return {
            ...current,
            items: current.items.filter((entry) => entry.id !== id),
            unreadCount: Math.max(0, Number(current.unreadCount || 0) - (item.isRead ? 0 : 1)),
          };
        }
        return {
          ...current,
          items: current.items.map((entry) =>
            entry.id === id ? { ...entry, isRead: true } : entry,
          ),
          unreadCount: Math.max(0, Number(current.unreadCount || 0) - (item.isRead ? 0 : 1)),
        };
      });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const readAllMutation = useMutation({
    mutationFn: markAllInboxItemsRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
        setFilterOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setFilterOpen(false);
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const handleOpen = (item) => {
    if (!item.isRead) {
      void itemMutation.mutateAsync({ id: item.id, action: "read" }).catch((error) => {
        showError(error?.response?.data?.error || error?.message || `Failed to read ${item.title}`);
      });
    }
    if (item.href) setOpen(false);
  };

  const handleRemove = async (item) => {
    const actionKey = `${item.id}:dismiss`;
    setPendingActions((current) => ({ ...current, [actionKey]: "dismiss" }));
    try {
      await itemMutation.mutateAsync({ id: item.id, action: "dismiss" });
    } catch (error) {
      showError(
        error?.response?.data?.message ||
          error?.response?.data?.error ||
          error?.message ||
          `Failed to update ${item.title}`,
      );
    } finally {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[actionKey];
        return next;
      });
    }
  };

  const handleReadAll = async () => {
    try {
      await readAllMutation.mutateAsync();
    } catch (error) {
      showError(
        error?.response?.data?.message ||
          error?.response?.data?.error ||
          error?.message ||
          "Failed to mark Inbox items as read",
      );
      return;
    }
  };

  const visibleItems = filter === "all" ? items : items.filter((item) => item.kind === filter);
  const selectedFilter = FILTER_OPTIONS.find((option) => option.value === filter) || FILTER_OPTIONS[0];

  if (!inboxEnabled || !Number.isInteger(Number(user?.id)) || Number(user.id) <= 0) return null;

  return (
    <div ref={menuRef} className="app-inbox-menu">
      <TooltipButton
        ref={triggerRef}
        label={unreadCount ? "Inbox, unread notifications" : "Inbox"}
        className={`app-header-link app-inbox-menu__trigger${open ? " is-open" : ""}${unreadCount > 0 ? " has-unread" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="inbox-notifications"
        onClick={() => {
          setOpen((current) => !current);
          if (!open) void loadInbox();
        }}
      >
        <Inbox aria-hidden="true" />
      </TooltipButton>

      {open ? (
        <div
          id="inbox-notifications"
          className="app-inbox-menu__dropdown"
          aria-label="Inbox notifications"
        >
          <div className="app-inbox-menu__header">
            <span>Inbox</span>
            <span className="app-inbox-menu__header-actions">
              <TooltipButton
                label="Filter inbox"
                className={`app-inbox-menu__header-action${filter !== "all" ? " is-active" : ""}`}
                aria-label="Filter inbox"
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen((current) => !current)}
              >
                <SlidersHorizontal aria-hidden="true" />
              </TooltipButton>
              {unreadCount > 0 ? (
                <button type="button" className="app-inbox-menu__read-all" onClick={handleReadAll}>
                  Mark all as read
                </button>
              ) : null}
            </span>
            {filterOpen ? (
              <div className="app-inbox-menu__filter-popover" role="menu" aria-label="Filter inbox notifications">
                {FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={filter === option.value}
                    className={`app-inbox-menu__filter-option${filter === option.value ? " is-active" : ""}`}
                    onClick={() => {
                      setFilter(option.value);
                      setFilterOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {(inboxQuery.isPending || (serverRefreshing && items.length === 0)) ? (
            <div className="app-inbox-menu__empty">
              <DotLoader size="sm" label={null} /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="app-inbox-menu__empty">Nothing to see here yet</div>
          ) : visibleItems.length === 0 ? (
            <div className="app-inbox-menu__empty">No {selectedFilter.label.toLowerCase()} yet</div>
          ) : (
            <ul className="app-inbox-menu__list">
              {visibleItems.map((item) => {
                const pendingAction = pendingActions[`${item.id}:dismiss`];
                return (
                  <InboxItem
                    key={item.id}
                    item={item}
                    onRemove={handleRemove}
                    onOpen={handleOpen}
                    pendingAction={pendingAction}
                  />
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default InboxMenu;
