import { RefreshCw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import TooltipButton from "../../components/TooltipButton";

export default function ActivityToolbar({
  filterValue,
  onFilterChange,
  onRefresh,
  refreshing = false,
  placeholder = "Filter activity",
}) {
  const [filterOpen, setFilterOpen] = useState(Boolean(filterValue));

  useEffect(() => {
    if (filterValue) setFilterOpen(true);
  }, [filterValue]);

  const toggleFilter = () => {
    if (filterOpen) onFilterChange("");
    setFilterOpen((open) => !open);
  };

  return (
    <div className="activity-toolbar">
      <div className="activity-toolbar__group">
        <TooltipButton
          className="native-library-icon-button"
          onClick={onRefresh}
          disabled={refreshing}
          label={refreshing ? "Refreshing" : "Refresh"}
          aria-label="Refresh activity"
        >
          <RefreshCw className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
        </TooltipButton>
      </div>
      <div className="activity-toolbar__group">
        {filterOpen ? (
          <label className="activity-toolbar__filter">
            <Search aria-hidden="true" />
            <input
              type="search"
              value={filterValue}
              onChange={(event) => onFilterChange(event.target.value)}
              placeholder={placeholder}
              aria-label={placeholder}
              autoFocus
            />
            {filterValue ? (
              <TooltipButton label="Clear filter" onClick={() => onFilterChange("")}>
                <X aria-hidden="true" />
              </TooltipButton>
            ) : null}
          </label>
        ) : null}
        <TooltipButton
          className={`native-library-icon-button${filterOpen ? " is-active" : ""}`}
          onClick={toggleFilter}
          label={filterOpen ? "Close filter" : "Filter"}
          aria-label={filterOpen ? "Close activity filter" : "Filter activity"}
          aria-pressed={filterOpen}
        >
          <Search aria-hidden="true" />
        </TooltipButton>
      </div>
    </div>
  );
}
