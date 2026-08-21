import { forwardRef } from "react";
import { Plus } from "lucide-react";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";

const AddActionButton = forwardRef(function AddActionButton(
  {
    label = "Add to Lidarr",
    icon: Icon = Plus,
    isLoading = false,
    disabled = false,
    className = "",
    type = "button",
    ...buttonProps
  },
  ref,
) {
  const classes = ["btn", "btn-add-action", className].filter(Boolean).join(" ");

  return (
    <TooltipButton
      {...buttonProps}
      ref={ref}
      label={buttonProps.title ?? label}
      type={type}
      className={classes}
      disabled={disabled || isLoading}
    >
      <span className="btn-add-action__icon">
        {isLoading ? (
          <DotLoader size="sm" label={null} />
        ) : (
          <Icon aria-hidden="true" />
        )}
      </span>
    </TooltipButton>
  );
});

export default AddActionButton;
