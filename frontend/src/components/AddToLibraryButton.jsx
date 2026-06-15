import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Plus, Check, Loader } from "lucide-react";

const AddToLibraryButton = ({
  onClick,
  className,
  disabled = false,
  isLoading,
  label = "Add to Library",
}) => {
  const [isSuccess, setIsSuccess] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  const handleClick = async (e) => {
    e.preventDefault();
    if (disabled || isLoading) return;
    if (onClick) {
      const success = await onClick();
      if (isMounted.current && success !== false) {
        setIsSuccess(true);
      }
    }
  };

  return (
    <button
      type="button"
      className={`btn btn-add-library${isSuccess ? " is-success" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleClick}
      disabled={disabled || isLoading}
    >
      <span>{label}</span>
      <div className="btn-add-library__icon">
        {isLoading ? (
          <Loader className="animate-spin" aria-hidden="true" />
        ) : (
          <>
            <Plus className="plus-icon" aria-hidden="true" />
            <Check className="check-icon" aria-hidden="true" />
          </>
        )}
      </div>
    </button>
  );
};

AddToLibraryButton.propTypes = {
  onClick: PropTypes.func,
  className: PropTypes.string,
  disabled: PropTypes.bool,
  isLoading: PropTypes.bool,
  label: PropTypes.string,
};

export default AddToLibraryButton;
