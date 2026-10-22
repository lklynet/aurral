import { CheckCircle2 } from "lucide-react";
const SIZE_CLASS = {
  sm: "library-check--sm",
  md: "library-check",
  action: "library-check--action",
  discover: "library-check--discover",
  overlay: "library-check--overlay",
};

function SearchLibraryCheck({ action = false, size, className = "", ...props }) {
  const sizeClass = SIZE_CLASS[size || (action ? "action" : "md")];

  return (
    <CheckCircle2
      className={`library-check ${sizeClass}${className ? ` ${className}` : ""}`}
      aria-label="In library"
      {...props}
    />
  );
}

export default SearchLibraryCheck;
