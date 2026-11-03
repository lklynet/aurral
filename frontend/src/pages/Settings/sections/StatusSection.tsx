import { useStorageHealth } from "../../../hooks/useStorageHealth";
import {
  SettingsGroup,
  SettingsPage,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";
import { AboutGroup } from "./status/AboutGroup";
import { LogsPage, logsServiceStatus, useLogProblems } from "./status/LogsPage";
import { StoragePage, storageServiceStatus } from "./status/StoragePage";
import { TasksPage, tasksServiceStatus, useTasksStatus } from "./status/TasksPage";
import "./status.css";

export function StatusSection() {
  const item = useSettingsItem();
  if (item === "storage") return <StoragePage />;
  if (item === "tasks") return <TasksPage />;
  if (item === "logs") return <LogsPage />;
  return <StatusSummary />;
}

function StatusSummary() {
  const storage = useStorageHealth({ enabled: true, pollMs: 120000 });
  const tasks = useTasksStatus();
  const problems = useLogProblems();
  return (
    <SettingsPage title="Status">
      <SettingsGroup>
        <SettingsServiceRow
          to="status/storage"
          name="Storage"
          status={storageServiceStatus(storage.result)}
        />
        <SettingsServiceRow
          to="status/tasks"
          name="Tasks"
          status={tasksServiceStatus(tasks.data)}
        />
        <SettingsServiceRow
          to="status/logs"
          name="Logs"
          status={logsServiceStatus(problems.data?.problems)}
        />
      </SettingsGroup>
      <AboutGroup />
    </SettingsPage>
  );
}
