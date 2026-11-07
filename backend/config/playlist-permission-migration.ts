import type Database from "better-sqlite3";

export function renamePlaylistPermission(db: Database.Database) {
  const hasPermissions = db
    .prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'permissions'")
    .get();
  if (hasPermissions) {
    db.exec(`
      UPDATE users
      SET permissions = json_remove(
        json_insert(
          permissions,
          '$.accessPlaylists',
          json(iif(json_extract(permissions, '$.accessFlow') = 1, 'true', 'false'))
        ),
        '$.accessFlow'
      )
      WHERE json_valid(permissions) AND json_type(permissions, '$.accessFlow') IS NOT NULL
    `);
  }
  db.exec(`
    UPDATE settings
    SET value = json_remove(
      json_insert(
        value,
        '$.defaultPermissions.accessPlaylists',
        json(iif(json_extract(value, '$.defaultPermissions.accessFlow') = 1, 'true', 'false'))
      ),
      '$.defaultPermissions.accessFlow'
    )
    WHERE key = 'security'
      AND json_valid(value)
      AND json_type(value, '$.defaultPermissions.accessFlow') IS NOT NULL
  `);
}
