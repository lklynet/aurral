import PropTypes from "prop-types";
import { AlertCircle, CheckCircle, XCircle } from "lucide-react";

const STEP_ICONS = {
  pass: CheckCircle,
  fail: XCircle,
  warn: AlertCircle,
};

export function LidarrLibraryAccessCheck({ result }) {
  if (!result?.steps?.length) return null;

  return (
    <div className="settings-page__access-check" role="status">
      <p className="settings-page__access-check-title">Library access check</p>
      <ul className="settings-page__access-check-list">
        {result.steps.map((entry) => {
          const Icon = STEP_ICONS[entry.status] || AlertCircle;
          return (
            <li
              key={entry.id}
              className={`settings-page__access-step is-${entry.status}`}
            >
              <Icon className="settings-page__access-step-icon" aria-hidden />
              <div className="settings-page__access-step-body">
                <span className="settings-page__access-step-label">
                  {entry.label}
                </span>
                {entry.detail ? (
                  <span className="settings-page__access-step-detail">
                    {entry.detail}
                  </span>
                ) : null}
                {entry.fix ? (
                  <p className="settings-page__access-step-fix">{entry.fix}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {result.sample?.path ? (
        <p className="settings-page__access-sample">
          <span className="settings-page__access-sample-label">Example</span>
          {result.sample.artistName} — {result.sample.trackTitle}
          <code className="settings-page__access-sample-path">
            {result.sample.path}
          </code>
        </p>
      ) : null}
    </div>
  );
}

LidarrLibraryAccessCheck.propTypes = {
  result: PropTypes.shape({
    steps: PropTypes.arrayOf(
      PropTypes.shape({
        id: PropTypes.string.isRequired,
        status: PropTypes.oneOf(["pass", "fail", "warn"]).isRequired,
        label: PropTypes.string.isRequired,
        detail: PropTypes.string,
        fix: PropTypes.string,
      }),
    ),
    sample: PropTypes.shape({
      path: PropTypes.string,
      artistName: PropTypes.string,
      albumTitle: PropTypes.string,
      trackTitle: PropTypes.string,
    }),
  }),
};
