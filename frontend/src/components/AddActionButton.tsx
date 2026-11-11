import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ForwardedRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { MoreVertical, Plus, type IconComponent } from "./icons";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";
import { LibraryItemMenu, type LibraryMenuItem } from "./LibraryItemMenu";

export type AddActionButtonProps = ComponentPropsWithoutRef<"button"> & {
  label?: string | null;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  items?: LibraryMenuItem[] | null;
  icon?: IconComponent;
  isLoading?: boolean;
  busy?: boolean;
  loadingLabel?: string | null;
  disabled?: boolean;
  showLabel?: boolean;
  className?: string;
  children?: ReactNode;
  type?: "button" | "submit" | "reset";
};

const keepActivationKeysLocal = (event: KeyboardEvent) => {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
};

const AddActionButton = forwardRef(function AddActionButton(
  {
    label = "Add to library",
    onAdd,
    items = null,
    icon: Icon = Plus,
    isLoading = false,
    busy = false,
    loadingLabel = null,
    disabled = false,
    showLabel = false,
    className = "",
    children,
    type = "button",
    ...buttonProps
  }: AddActionButtonProps,
  ref: ForwardedRef<HTMLButtonElement>,
) {
  const classes = [
    "btn",
    children ? null : "btn-add-action",
    showLabel && !children ? "btn-add-action--labeled" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const visibleLabel = showLabel ? (
    <span className="btn-add-action__label">Add to library</span>
  ) : null;
  const opensMenu = !children && buttonProps["aria-haspopup"] === "menu";
  const isDisabled = disabled || isLoading;
  const handleClick = onAdd
    ? (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onAdd(event);
      }
    : buttonProps.onClick;

  if (items) {
    const menuLabel = ((isLoading || busy) && loadingLabel) || label || "Add to library";
    return (
      <div onKeyDown={keepActivationKeysLocal}>
        <LibraryItemMenu
          label={menuLabel}
          menuLabel={menuLabel}
          triggerLabel={menuLabel}
          triggerClassName={`${classes} btn-add-action--menu`}
          triggerIcon={
            <>
              <span className="btn-add-action__icon">
                {isLoading || busy ? (
                  <DotLoader size="sm" label={null} />
                ) : (
                  <Icon aria-hidden="true" />
                )}
              </span>
              {visibleLabel}
              <MoreVertical className="btn-add-action__more" aria-hidden="true" />
            </>
          }
          disabled={isDisabled}
          contextMenu={false}
          align="start"
          items={items}
        />
      </div>
    );
  }

  return (
    <TooltipButton
      {...buttonProps}
      ref={ref}
      label={
        ((isLoading || busy) && loadingLabel) || buttonProps.title || label || "Add to library"
      }
      type={type}
      className={opensMenu ? `${classes} btn-add-action--menu` : classes}
      disabled={isDisabled}
      onClick={handleClick}
      onKeyDown={(event) => {
        keepActivationKeysLocal(event);
        buttonProps.onKeyDown?.(event);
      }}
    >
      {children ?? (
        <span className="btn-add-action__icon">
          {isLoading || busy ? <DotLoader size="sm" label={null} /> : <Icon aria-hidden="true" />}
        </span>
      )}
      {children ? null : visibleLabel}
      {opensMenu ? <MoreVertical className="btn-add-action__more" aria-hidden="true" /> : null}
    </TooltipButton>
  );
});

export default AddActionButton;
