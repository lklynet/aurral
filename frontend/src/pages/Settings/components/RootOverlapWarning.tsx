import { describeRootOverlapWarning } from "../utils/librarySettings";

export function RootOverlapWarning({ rootWarnings }) {
  const warning = describeRootOverlapWarning(rootWarnings);
  if (!warning) return null;
  return (
    <div className="arr-info arr-info--warning" role="status">
      <p className="arr-info__lead">{warning.summary}</p>
      {warning.details.map((detail) => (
        <p key={detail} className="arr-info__help">
          {detail}
        </p>
      ))}
    </div>
  );
}
