import fs from "node:fs";
import path from "node:path";

const dataDir = process.env.AURRAL_DATA_DIR;
const username = process.env.AURRAL_LAB_ADMIN_USER;
const password = process.env.AURRAL_LAB_ADMIN_PASSWORD;

if (!dataDir || !username || !password) {
  console.error("AURRAL_DATA_DIR, AURRAL_LAB_ADMIN_USER, and AURRAL_LAB_ADMIN_PASSWORD are required.");
  process.exit(1);
}
process.env.AURRAL_DB_PATH = path.join(dataDir, "aurral.db");
if (fs.existsSync(process.env.AURRAL_DB_PATH)) {
  console.error(`${dataDir} already contains an Aurral database. Seed only empty Lab state.`);
  process.exit(1);
}

const backend = (file) => import(new URL(`../../backend/${file}`, import.meta.url));
const { db } = await backend("config/db-sqlite.js");
const { dbOps, userOps } = await backend("db/helpers/index.js");
const { hashPassword } = await backend("middleware/passwordHash.js");

const settings = dbOps.getSettings();
dbOps.updateSettings({
  ...settings,
  onboardingComplete: true,
  integrations: {
    ...settings.integrations,
    general: { ...settings.integrations?.general, authUser: username, authPassword: password },
  },
  security: { ...settings.security, localNetworkBypass: { enabled: false } },
});
userOps.createUser(username, hashPassword(password), "admin", null, true, true, password);
db.close();
