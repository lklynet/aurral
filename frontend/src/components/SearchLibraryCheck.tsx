import type { ComponentProps } from "react";
import { CheckCircle2 } from "lucide-react";
const SIZE_CLASS = {
  sm: "library-check--sm",
  md: "library-check",
  action: "library-check--action",
  discover: "library-check--discover",
  overlay: "library-check--overlay",
};

type SearchLibraryCheckProps = ComponentProps<typeof CheckCircle2> & {
  action?: boolean;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
};

function SearchLibraryCheck({
  action = false,
  size,
  className = "",
  ...props
}: SearchLibraryCheckProps) {
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
