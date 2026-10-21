import SearchLibraryCheck from "../../../components/SearchLibraryCheck";
import Tooltip from "../../../components/Tooltip";

function ReleaseStatusCheck({ partial = false }) {
  const label = partial ? "Partially available" : "Complete";
  return (
    <Tooltip content={label}>
      <span className="artist-release-card__status">
        <SearchLibraryCheck size="overlay" className={partial ? "library-check--partial" : ""} />
        <span className="sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

export default ReleaseStatusCheck;
