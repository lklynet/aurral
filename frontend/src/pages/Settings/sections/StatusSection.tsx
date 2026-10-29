import { useStorageHealth } from "../../../hooks/useStorageHealth";
import {
  SettingsGroup,
  SettingsPage,
  SettingsServiceRow,
  useSettingsItem,
} from "../SettingsLayout";
import { AboutGroup } from "./status/AboutGroup";
import { StoragePage, storageServiceStatus } from "./status/StoragePage";
import { TasksPage, tasksServiceStatus, useTasksStatus } from "./status/TasksPage";
import "./status.css";

export function StatusSection() {
  const item = useSettingsItem();
  if (item === "storage") return <StoragePage />;
  if (item === "tasks") return <TasksPage />;
  return <StatusSummary />;
}

function StatusSummary() {
  const storage = useStorageHealth({ enabled: true, pollMs: 120000 });
  const tasks = useTasksStatus();
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
      </SettingsGroup>
      <AboutGroup />
    </SettingsPage>
  );
}
