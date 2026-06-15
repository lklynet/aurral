import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopDir = join(rootDir, "desktop");
const version = JSON.parse(
  readFileSync(join(rootDir, "package.json"), "utf8"),
).version;

const packageJsonPath = join(desktopDir, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const tauriConfigPath = join(desktopDir, "src-tauri", "tauri.conf.json");
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = version;
writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

const cargoTomlPath = join(desktopDir, "src-tauri", "Cargo.toml");
const cargoToml = readFileSync(cargoTomlPath, "utf8").replace(
  /^version = ".*"$/m,
  `version = "${version}"`,
);
writeFileSync(cargoTomlPath, cargoToml);

console.log(`Synced desktop version to ${version}`);
