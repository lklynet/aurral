import { Save } from "lucide-react";
import PropTypes from "prop-types";
import "./FlipSaveButton.css";

function FlipSaveButton({
  disabled,
  saving,
  onClick,
  label = "Save",
  savedLabel = "Saved",
  showSavedState,
}) {
  const handleClick = (e) => {
    if (disabled || saving) return;
    onClick(e);
  };
  const shouldFlip = showSavedState ?? disabled;

  return (
    <div className={`btn-flip-wrap${shouldFlip ? " flipped" : ""}`}>
      <button
        type="button"
        className="btn-flip"
        disabled={disabled || saving}
        onClick={handleClick}
      >
        <div className="btn-flip-inner">
          <span className="btn-flip-front">
            <Save aria-hidden="true" />
            {label}
          </span>
          <span className="btn-flip-back">
            <Save aria-hidden="true" />
            {savedLabel}
          </span>
        </div>
      </button>
    </div>
  );
}

FlipSaveButton.propTypes = {
  disabled: PropTypes.bool,
  saving: PropTypes.bool,
  onClick: PropTypes.func.isRequired,
  label: PropTypes.string,
  savedLabel: PropTypes.string,
  showSavedState: PropTypes.bool,
};

export default FlipSaveButton;
