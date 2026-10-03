const RETIRED_SETTING_PATTERNS = [
  "migration:*",
  "news:rssState",
  "user:*:newsPreferences",
  "aurral3Readiness",
  "storedDataMigration",
  "identityMarkerMigration",
  "playlistStartupMigration",
  "deprecatedUsage",
];

function deleteRetiredSettings(db) {
  const remove = db.prepare("DELETE FROM settings WHERE key GLOB ?");
  for (const pattern of RETIRED_SETTING_PATTERNS) remove.run(pattern);
}

export function upgradeFromAurral2(db) {
  deleteRetiredSettings(db);
}
