import { Clock } from "./icons";
import Tooltip from "./Tooltip";
import { formatReleaseWait } from "../utils/aurralAlbumStatus.ts";

export default function ReleaseWaitBadge({
  releaseDate,
}: {
  releaseDate: string | null | undefined;
}) {
  const label = formatReleaseWait(releaseDate);
  return (
    <Tooltip content={label}>
      <span className="release-wait-badge" role="img" aria-label={label} tabIndex={0}>
        <span className="btn-add-action__icon">
          <Clock aria-hidden="true" />
        </span>
      </span>
    </Tooltip>
  );
}
