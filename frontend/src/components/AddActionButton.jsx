import { forwardRef } from "react";
import { ChevronDown, Plus } from "lucide-react";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { ADD_TO_MENU_LABEL, getAddToManagerLabel } from "../utils/libraryDestination";

const AddActionButton = forwardRef(function AddActionButton(
  {
    label,
    destination = null,
    onAdd,
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
  const primary = destination?.primary || null;
  const alternative = label ? null : destination?.alternative || null;
  const isDisabled = disabled || isLoading || (destination ? !destination.ready : false);
  const handleClick = onAdd && primary
    ? (event) => {
        event.stopPropagation();
        onAdd(primary, event);
      }
    : buttonProps.onClick;

  const button = (
    <TooltipButton
      {...buttonProps}
      ref={ref}
      label={buttonProps.title ?? label ?? getAddToManagerLabel(primary)}
      type={type}
      className={classes}
      disabled={isDisabled}
      onClick={handleClick}
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

  if (!alternative || !onAdd) return button;

  return (
    <div className="btn-add-action-group">
      {button}
      <LibraryItemMenu
        label={ADD_TO_MENU_LABEL}
        menuLabel={ADD_TO_MENU_LABEL}
        triggerLabel={ADD_TO_MENU_LABEL}
        triggerClassName="btn-add-action-options"
        triggerIcon={<ChevronDown aria-hidden="true" />}
        disabled={isDisabled}
        contextMenu={false}
        items={[
          {
            id: alternative,
            label: getAddToManagerLabel(alternative),
            icon: Plus,
            onSelect: () => onAdd(alternative),
          },
        ]}
      />
    </div>
  );
});

export default AddActionButton;
