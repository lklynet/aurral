import { ArrowLeft, ArrowRight } from "./icons";
import TooltipButton from "./TooltipButton";

export default function Pagination({
  page,
  pageCount,
  hasMore = false,
  label,
  onChange,
}: {
  page: number;
  pageCount: number;
  hasMore?: boolean;
  label: string;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1 && !hasMore) return null;
  return (
    <nav className="native-library-pagination" aria-label={label}>
      <TooltipButton
        className="native-library-icon-button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        label="Previous page"
        aria-label="Previous page"
      >
        <ArrowLeft aria-hidden="true" />
      </TooltipButton>
      <span>{hasMore ? `Page ${page}` : `Page ${page} of ${pageCount}`}</span>
      <TooltipButton
        className="native-library-icon-button"
        onClick={() => onChange(page + 1)}
        disabled={page >= pageCount && !hasMore}
        label="Next page"
        aria-label="Next page"
      >
        <ArrowRight aria-hidden="true" />
      </TooltipButton>
    </nav>
  );
}
