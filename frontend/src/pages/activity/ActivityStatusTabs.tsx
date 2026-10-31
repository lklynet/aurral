import type { ActivityStatus } from "../../navigation/activityNavConfig";

type StatusTab = { id: ActivityStatus; label: string; count: number };

interface ActivityStatusTabsProps {
  total: number | null;
  filters: StatusTab[];
  active: ActivityStatus | null;
  onChange: (status: ActivityStatus | null) => void;
}

export default function ActivityStatusTabs({
  total,
  filters,
  active,
  onChange,
}: ActivityStatusTabsProps) {
  const tabs = [{ id: null, label: "All", count: total }, ...filters];
  return (
    <div className="activity-toolbar">
      <div className="activity-status-tabs" role="group" aria-label="Filter by status">
        {tabs.map((tab) => (
          <button
            key={tab.id ?? "all"}
            type="button"
            className={`activity-status-tab${tab.id === active ? " is-active" : ""}`}
            aria-pressed={tab.id === active}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count != null ? (
              <span className="activity-status-tab__count">{tab.count}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
