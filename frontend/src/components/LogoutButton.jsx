import PropTypes from 'prop-types';
import { LogOut } from 'lucide-react';
import './LogoutButton.css';

const LogoutButton = ({ onClick, collapsed }) => {
  if (collapsed) {
    return (
      <button
        onClick={onClick}
        className="group relative p-2 rounded-md transition-colors hover:bg-white/5"
        style={{ color: "#c1c1c3" }}
        aria-label="Log out"
      >
        <LogOut className="w-4 h-4" />
        <span
          className="absolute left-full ml-2 px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 z-[100]"
          style={{
            backgroundColor: "#2a2a2e",
            color: "#fff",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
          }}
        >
          Log out
        </span>
      </button>
    );
  }

  return (
    <div className="logout-trapdoor" onClick={onClick} role="button" tabIndex={0}>
      {/* Content hidden behind doors */}
      <div className="logout-content">
        <span>Log Out</span>
      </div>

      {/* Top Door */}
      <div className="logout-door top">
        <div className="logout-door-inner">
          <LogOut className="w-4 h-4" />
        </div>
      </div>

      {/* Bottom Door */}
      <div className="logout-door bottom">
        <div className="logout-door-inner">
          <LogOut className="w-4 h-4" />
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
