import { SettingsPage } from "../SettingsLayout";
import { AboutGroup } from "./status/AboutGroup";
import { StorageGroup } from "./status/StorageGroup";
import { TasksGroup } from "./status/TasksGroup";
import "./status.css";

export function StatusSection() {
  return (
    <SettingsPage title="Status">
      <StorageGroup />
      <TasksGroup />
      <AboutGroup />
    </SettingsPage>
  );
}
