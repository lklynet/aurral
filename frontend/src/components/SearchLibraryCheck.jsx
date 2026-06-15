import { CheckCircle2 } from "lucide-react";
import PropTypes from "prop-types";

const SIZE_CLASS = {
  sm: "library-check--sm",
  md: "library-check",
  action: "library-check--action",
  discover: "library-check--discover",
  overlay: "library-check--overlay",
};

function SearchLibraryCheck({
  action = false,
  size,
  className = "",
  ...props
}) {
  const sizeClass = SIZE_CLASS[size || (action ? "action" : "md")];

  return (
    <CheckCircle2
      className={`library-check ${sizeClass}${className ? ` ${className}` : ""}`}
      aria-label="In library"
      {...props}
    />
  );
}

SearchLibraryCheck.propTypes = {
  action: PropTypes.bool,
  size: PropTypes.oneOf(["sm", "md", "action", "discover", "overlay"]),
  className: PropTypes.string,
};

export default SearchLibraryCheck;
