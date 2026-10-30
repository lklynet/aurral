import { DotLoader } from "../../../../components/DotLoader";
import { useServerSettings } from "../../SettingsProviders";
import { SettingsGroup } from "../../SettingsLayout";

function formatUptime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return [days ? `${days}d` : null, hours || days ? `${hours}h` : null, `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

export function AboutGroup() {
  const { health } = useServerSettings();
  const system = health?.system;

  if (!system) {
    return (
      <SettingsGroup title="About">
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading…
        </p>
      </SettingsGroup>
    );
  }

  const facts = [
    {
      label: "Version",
      value: <code className="settings-code">{system.version || health.appVersion}</code>,
    },
    { label: "Uptime", value: formatUptime(system.uptimeSeconds) },
    { label: "Environment", value: `${system.mode} · ${system.hostname}` },
    { label: "Platform", value: `Node ${system.nodeVersion} · ${system.platform} ${system.arch}` },
    { label: "Container", value: system.docker ? "Docker" : "Host process" },
    { label: "Database", value: system.database.label },
    { label: "App data", value: <code className="settings-code">{system.dataDir}</code> },
    { label: "Database path", value: <code className="settings-code">{system.databasePath}</code> },
    {
      label: "Startup directory",
      value: <code className="settings-code">{system.startupDirectory}</code>,
    },
    {
      label: "Links",
      value: (
        <span className="status-facts__links">
          {system.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="settings-link"
            >
              {link.label}
            </a>
          ))}
        </span>
      ),
    },
  ];

  return (
    <SettingsGroup title="About">
      <dl className="status-facts">
        {facts.map(({ label, value }) => (
          <div key={label} className="status-facts__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </SettingsGroup>
  );
}
