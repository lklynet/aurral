import { Search, X } from "../../components/icons";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import TooltipButton from "../../components/TooltipButton";

interface ActivityToolbarProps {
  filterValue: string;
  onFilterChange: (value: string) => void;
  action?: ReactNode;
  placeholder?: string;
}

export default function ActivityToolbar({
  filterValue,
  onFilterChange,
  action = null,
  placeholder = "Filter activity",
}: ActivityToolbarProps) {
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
      <div className="activity-toolbar__group activity-toolbar__group--end">
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
              <TooltipButton
                label="Clear filter"
                onClick={() => onFilterChange("")}
                className="btn"
              >
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
        {action}
      </div>
    </div>
  );
}
