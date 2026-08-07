import "./PillToggle.css";

function PillToggle({ checked = false, onChange, disabled = false, id, className, ...buttonProps }) {
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
