export function SettingsTabsNav({
  tabs,
  activeTab,
  setActiveTab,
  navRef,
  activeBubbleRef,
  hoverBubbleRef,
  linkRefs,
  setHoveredTabIndex,
}) {
  return (
    <div className="settings-tabs-nav-wrap" aria-label="Settings sections">
      <div ref={navRef} className="settings-tabs-nav-wrap__inner sidebar-nav-wrap">
        <div
          ref={activeBubbleRef}
          className="sidebar-bubble sidebar-bubble--active"
        />
        <div ref={hoverBubbleRef} className="sidebar-bubble sidebar-bubble--hover" />
        <nav
          className="settings-tabs-nav sidebar-nav"
          onMouseLeave={() => setHoveredTabIndex(null)}
        >
          {tabs.map((tab, index) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                ref={(el) => {
                  if (el) linkRefs.current[index] = el;
                }}
                onClick={() => setActiveTab(tab.id)}
                onMouseEnter={() => setHoveredTabIndex(index)}
                className={`sidebar-link sidebar-link--full settings-tabs-nav__link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="sidebar-link__icon" aria-hidden="true" />
                <span className="sidebar-link__label">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
