import { forwardRef } from "react";
import { MoreVertical, Plus, RefreshCw, SlidersHorizontal } from "lucide-react";
import Tooltip from "./Tooltip";
import TooltipButton from "./TooltipButton";
import SearchLibraryCheck from "./SearchLibraryCheck";
import { DotLoader } from "./DotLoader";
import { LibraryItemMenu } from "./LibraryItemMenu";
import { ADD_TO_MENU_LABEL, getAddToManagerLabel } from "../utils/libraryDestination";

const keepActivationKeysLocal = (event) => {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
};

const AddActionButton = forwardRef(function AddActionButton(
  {
    label,
    destination = null,
    onAdd,
    onCustomize,
    items = null,
    ownerConflict = null,
    icon: Icon = Plus,
    isLoading = false,
    disabled = false,
    showLabel = false,
    className = "",
    children,
    type = "button",
    ...buttonProps
  },
  ref,
) {
  if (ownerConflict) {
    return (
      <Tooltip content={ownerConflict.message}>
        <span
          className="btn-add-action btn-add-action--managed"
          role="img"
          aria-label={ownerConflict.message}
          tabIndex={0}
        >
          <SearchLibraryCheck action aria-hidden="true" aria-label={undefined} />
        </span>
      </Tooltip>
    );
  }

  const classes = [
    "btn",
    children ? null : "btn-add-action",
    showLabel && !children ? "btn-add-action--labeled" : null,
    className,
  ].filter(Boolean).join(" ");
  const visibleLabel = showLabel ? <span className="btn-add-action__label">Add to library</span> : null;
  const opensMenu = !children && buttonProps["aria-haspopup"] === "menu";
  const primary = destination?.primary || null;
  const alternative = destination?.alternative || null;
  const isDisabled = disabled || isLoading || (destination ? !destination.ready : false);
  const handleClick = onAdd && primary
    ? (event) => {
        event.stopPropagation();
        onAdd(primary, event);
      }
    : buttonProps.onClick;

  if (destination?.error) {
    return (
      <TooltipButton
        ref={ref}
        label="Could not check library destinations. Retry"
        aria-label="Retry library destinations"
        className={classes}
        disabled={disabled || isLoading}
        onClick={(event) => {
          event.stopPropagation();
          destination.retry?.();
        }}
        onKeyDown={keepActivationKeysLocal}
      >
        <span className="btn-add-action__icon"><RefreshCw aria-hidden="true" /></span>
      </TooltipButton>
    );
  }

  const managers = ["lidarr", "aurral"].filter(
    (manager) => manager === primary || manager === alternative,
  );
  const menuItems = items ?? (alternative && onAdd
    ? [
        ...managers.map((manager) => ({
          id: manager,
          label: getAddToManagerLabel(manager),
          icon: Plus,
          onSelect: () => onAdd(manager),
        })),
        ...(onCustomize && managers.includes("lidarr")
          ? [{
              id: "customize-lidarr",
              label: "Customize Lidarr add…",
              icon: SlidersHorizontal,
              separatorBefore: true,
              closeBeforeSelect: true,
              onSelect: onCustomize,
            }]
          : []),
      ]
    : null);

  if (menuItems) {
    return (
      <div onKeyDown={keepActivationKeysLocal}>
        <LibraryItemMenu
          label={ADD_TO_MENU_LABEL}
          menuLabel={ADD_TO_MENU_LABEL}
          triggerLabel={ADD_TO_MENU_LABEL}
          triggerClassName={`${classes} btn-add-action--menu`}
          triggerIcon={
            <>
              <span className="btn-add-action__icon">
                {isLoading ? <DotLoader size="sm" label={null} /> : <Icon aria-hidden="true" />}
              </span>
              {visibleLabel}
              <MoreVertical className="btn-add-action__more" aria-hidden="true" />
            </>
          }
          disabled={isDisabled}
          contextMenu={false}
          align="start"
          items={menuItems}
        />
      </div>
    );
  }

  return (
    <TooltipButton
      {...buttonProps}
      ref={ref}
      label={destination && !destination.ready
        ? "Checking library destinations"
        : buttonProps.title ?? label ?? getAddToManagerLabel(primary)}
      type={type}
      className={opensMenu ? `${classes} btn-add-action--menu` : classes}
      disabled={isDisabled}
      onClick={handleClick}
      onKeyDown={(event) => {
        keepActivationKeysLocal(event);
        buttonProps.onKeyDown?.(event);
      }}
    >
      {children ?? <span className="btn-add-action__icon">
        {isLoading || (destination && !destination.ready) ? (
          <DotLoader size="sm" label={null} />
        ) : (
          <Icon aria-hidden="true" />
        )}
      </span>}
      {children ? null : visibleLabel}
      {opensMenu ? <MoreVertical className="btn-add-action__more" aria-hidden="true" /> : null}
    </TooltipButton>
  );
});

export default AddActionButton;
