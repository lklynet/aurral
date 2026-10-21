import "./PillToggle.css";
import type { ComponentPropsWithoutRef } from "react";

type PillToggleProps = Omit<ComponentPropsWithoutRef<"button">, "onChange"> & {
  checked?: boolean;
  onChange?: (event: { target: { checked: boolean } }) => void;
};

function PillToggle({
  checked = false,
  onChange,
  disabled = false,
  id,
  className,
  ...buttonProps
}: PillToggleProps) {
  const handleClick = () => onChange?.({ target: { checked: !checked } });

  return (
    <button
      type="button"
      id={id}
      className={`pill-toggle ${className || ""}`.trim()}
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={buttonProps["aria-label"] || "Toggle"}
      disabled={disabled}
      onClick={handleClick}
      {...buttonProps}
    />
  );
}

export default PillToggle;
