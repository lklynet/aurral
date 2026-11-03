import fs from "node:fs/promises";

export async function isRunningInDocker() {
  try {
    await fs.access("/.dockerenv");
    return true;
  } catch {}
  try {
    const cgroup = await fs.readFile("/proc/1/cgroup", "utf8");
    return /docker|kubepods|containerd|podman/i.test(cgroup);
  } catch {
    return false;
  }
}
