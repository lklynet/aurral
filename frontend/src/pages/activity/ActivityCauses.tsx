import type { ActivityCauseGroup } from "../../../../lib/activity.ts";
import {
  AudioWaveform,
  Bell,
  Download,
  ListMusic,
  Search,
  Share,
  TrendUp,
  type IconComponent,
} from "../../components/icons";
import RouteLink from "../../components/RouteLink";
import { SettingsLink } from "../../navigation/settingsRoute";
import { flowPath, playlistPath } from "../../navigation/playlistPaths";
import { formatDate } from "../../utils/dateTime.ts";
import { formatTimelineTime } from "./activityListUtils";

const CAUSE_ICONS = {
  request: Download,
  monitoring: Bell,
  missing: Search,
  upgrade: TrendUp,
  flow: AudioWaveform,
  playlist: ListMusic,
  share: Share,
} satisfies Record<ActivityCauseGroup["kind"], IconComponent>;

type CauseLink = { to: string; label: string; settings?: true };

const subjectText = ({ subject, subjects }: ActivityCauseGroup, noun: string) =>
  subject ?? (subjects > 1 ? `${subjects} ${noun}s` : null);

function describeCause(
  group: ActivityCauseGroup,
  isAdmin: boolean,
): { title: string; why: string | null; link: CauseLink | null } {
  switch (group.kind) {
    case "upgrade":
      return {
        title: "Quality upgrades",
        why: "below your quality cutoff",
        link: isAdmin
          ? { to: "downloads/quality", label: "Quality settings", settings: true }
          : null,
      };
    case "flow":
      return {
        title: group.name ?? "Flow",
        why: "flow refresh",
        link: group.playlistId ? { to: flowPath(group.playlistId), label: "Open flow" } : null,
      };
    case "playlist":
      return {
        title: group.name ?? "Playlist",
        why: group.syncedFrom ? `synced from ${group.syncedFrom}` : "added to the playlist",
        link: group.playlistId
          ? { to: playlistPath(group.playlistId), label: "Open playlist" }
          : null,
      };
    case "missing": {
      const albums = subjectText(group, "album");
      return {
        title: "Missing tracks",
        why: albums && `searching again on ${albums}`,
        link: { to: "/activity/missing", label: "Missing" },
      };
    }
    case "monitoring": {
      const artists = subjectText(group, "artist");
      return {
        title: "Artist monitoring",
        why: artists && `new music from ${artists}`,
        link: null,
      };
    }
    case "request":
      return { title: "Requests", why: null, link: null };
    case "share":
      return { title: "Share links", why: "music shared with you", link: null };
  }
}

function formatSince(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toDateString() === new Date().toDateString()
    ? formatTimelineTime(value)
    : formatDate(date, { month: "short", day: "numeric" });
}

export default function ActivityCauses({
  causes,
  active,
  isAdmin,
  onSelect,
}: {
  causes: ActivityCauseGroup[];
  active: string | null;
  isAdmin: boolean;
  onSelect: (key: string | null) => void;
}) {
  if (!causes.length) return null;
  return (
    <div className="activity-causes" role="group" aria-label="Why downloads are queued">
      {causes.map((group) => {
        const { title, why, link } = describeCause(group, isAdmin);
        const Icon = CAUSE_ICONS[group.kind];
        const selected = group.key === active;
        const since = formatSince(group.since);
        return (
          <div key={group.key} className={`activity-cause${selected ? " is-active" : ""}`}>
            <button
              type="button"
              className="activity-cause__filter"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : group.key)}
            >
              <Icon className="activity-cause__icon" aria-hidden="true" />
              <span className="activity-cause__text">
                <span className="activity-cause__title">{title}</span>
                {why ? <span className="activity-cause__why">{why}</span> : null}
              </span>
              <span className="activity-cause__count">
                {group.count}
                {since ? ` · since ${since}` : null}
              </span>
            </button>
            {link ? (
              link.settings ? (
                <SettingsLink to={link.to} className="activity-cause__link">
                  {link.label}
                </SettingsLink>
              ) : (
                <RouteLink to={link.to} className="activity-cause__link">
                  {link.label}
                </RouteLink>
              )
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
