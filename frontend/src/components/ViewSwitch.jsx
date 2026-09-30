import { Link } from "react-router-dom";

const VIEWS = [
  { id: "discover", label: "Discover" },
  { id: "library", label: "Library" },
];

function ViewSwitch({ current, discover, library, className = "" }) {
  const targets = { discover, library };
  const other = VIEWS.find((view) => view.id !== current);
  if (!other || !targets[other.id]) return null;

  return (
    <nav className={`artist-segmented view-switch ${className}`.trim()} aria-label="View">
      {VIEWS.map((view) => {
        if (view.id === current) {
          return (
            <span key={view.id} className="artist-segmented-button is-active" aria-current="page">
              {view.label}
            </span>
          );
        }
        const target = targets[view.id];
        if (target.to) {
          return (
            <Link
              key={view.id}
              to={target.to}
              state={target.state}
              replace
              className="artist-segmented-button"
            >
              {view.label}
            </Link>
          );
        }
        return (
          <span
            key={view.id}
            className="artist-segmented-button view-switch__segment--disabled"
            aria-disabled="true"
          >
            {view.label}
            {target.status ? <span className="view-switch__status">{target.status}</span> : null}
          </span>
        );
      })}
    </nav>
  );
}

export default ViewSwitch;
