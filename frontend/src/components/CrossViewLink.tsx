import { Link } from "react-router";
import { Library, Sparkles } from "./icons";
import Tooltip from "./Tooltip";

const VIEWS = {
  discover: { label: "Open in Discover", Icon: Sparkles },
  library: { label: "Open in library", Icon: Library },
};

interface CrossViewLinkProps {
  view: keyof typeof VIEWS;
  to: string;
  state?: unknown;
}

function CrossViewLink({ view, to, state }: CrossViewLinkProps) {
  const { label, Icon } = VIEWS[view];
  return (
    <Tooltip content={label}>
      <Link to={to} state={state} className="cross-view-link" aria-label={label}>
        <Icon aria-hidden="true" />
      </Link>
    </Tooltip>
  );
}

export default CrossViewLink;
