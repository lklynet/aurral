import PropTypes from 'prop-types';
import { LogOut } from 'lucide-react';
import './LogoutButton.css';

const LogoutButton = ({ onClick, collapsed }) => {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="btn btn-ghost btn-icon-square logout-button--collapsed"
        aria-label="Log out"
      >
        <LogOut className="artist-icon-xs" aria-hidden="true" />
        <span className="logout-button__tooltip">Log out</span>
      </button>
    );
  }

  return (
    <div className="logout-trapdoor" onClick={onClick} role="button" tabIndex={0}>
      <div className="logout-content">
        <span>Log Out</span>
      </div>

      <div className="logout-door top">
        <div className="logout-door-inner">
          <LogOut aria-hidden="true" />
        </div>
      </div>

      <div className="logout-door bottom">
        <div className="logout-door-inner">
          <LogOut aria-hidden="true" />
        </div>
      </div>
    </div>
  );
};

LogoutButton.propTypes = {
  onClick: PropTypes.func.isRequired,
  collapsed: PropTypes.bool,
};

export default LogoutButton;
