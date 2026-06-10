import PropTypes from "prop-types";
import { Plus, Loader } from "lucide-react";

const AddAlbumButton = ({
  onClick,
  isLoading,
  disabled,
  className,
  style,
  label = "Add to Lidarr",
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isLoading}
      className={`btn btn-add-album${className ? ` ${className}` : ""}`}
      style={style}
      title={label}
    >
      <div className="btn-add-album__icon">
        {isLoading ? (
          <Loader className="animate-spin" aria-hidden="true" />
        ) : (
          <Plus aria-hidden="true" />
        )}
      </div>
      <span className="btn-add-album__label">{label}</span>
    </button>
  );
};

AddAlbumButton.propTypes = {
  onClick: PropTypes.func.isRequired,
  isLoading: PropTypes.bool,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  style: PropTypes.object,
  label: PropTypes.string,
};

export default AddAlbumButton;
