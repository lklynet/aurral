import { forwardRef } from "react";
import { Loader, Plus } from "lucide-react";
import TooltipButton from "./TooltipButton";

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
          <Loader className="animate-spin" aria-hidden="true" />
        ) : (
          <Icon aria-hidden="true" />
        )}
      </span>
    </TooltipButton>
  );
});

export default AddActionButton;
