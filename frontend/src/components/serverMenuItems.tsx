import { Check, Plus } from "./icons";
import { activeServer, hostOf, readServers, switchServer } from "../utils/server.ts";

export function serverMenuItems(itemClassName: string, iconClassName: string) {
  const items = readServers().servers.map((server) => {
    const active = server.address === activeServer?.address;
    return (
      <button
        key={server.address}
        type="button"
        role="menuitemradio"
        aria-checked={active}
        className={itemClassName}
        onClick={() => (active ? undefined : switchServer(server.address))}
      >
        {active ? (
          <Check className={iconClassName} />
        ) : (
          <span className={iconClassName} aria-hidden="true" />
        )}
        <span className="server-menu-item">
          <span className="server-menu-item__host">{server.name || hostOf(server.address)}</span>
          {server.username ? (
            <span className="server-menu-item__user">{server.username}</span>
          ) : null}
        </span>
      </button>
    );
  });
  return [
    ...items,
    <button
      key="add"
      type="button"
      role="menuitem"
      className={itemClassName}
      onClick={() => window.location.assign("/connect")}
    >
      <Plus className={iconClassName} />
      <span>Add a server</span>
    </button>,
  ];
}
