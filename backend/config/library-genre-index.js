const entities = ["artists", "albums", "tracks"];

function genreValues(kind, id, metadata, entityFrom = "") {
  const valid = `CASE WHEN json_valid(${metadata}) THEN ${metadata} ELSE '{}' END`;
  return ["$.genres", "$.genre", "$.common.genre", "$.tags.genre"].map((path) =>
    `SELECT '${kind}', ${id}, CAST(genre_value.value AS TEXT), TRIM(CAST(genre_value.value AS TEXT))
     FROM ${entityFrom ? `${entityFrom}, ` : ""}json_each(${valid}, '${path}') AS genre_value
     WHERE TRIM(CAST(genre_value.value AS TEXT)) <> ''`).join(" UNION ALL ");
}

export function initializeLibraryGenreIndex(db) {
  const current = () => Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'library_entity_genres'",
  ).get()) && db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'library_genres_*'",
  ).get().count === 9;
  if (current()) return;
  db.transaction(() => {
    if (current()) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_entity_genres (
        entity_kind TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        value TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (entity_kind, entity_id, value)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_library_genres_value
        ON library_entity_genres (lower(value), entity_kind, entity_id);
      DELETE FROM library_entity_genres;
      DELETE FROM settings WHERE key LIKE 'libraryGenreStats:%';
    `);
    for (const kind of entities) {
      const insert = `INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, value, name)
        ${genreValues(kind, "NEW.id", "NEW.metadata_json")};`;
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS library_genres_${kind}_insert
        AFTER INSERT ON library_${kind} BEGIN ${insert} END;
        CREATE TRIGGER IF NOT EXISTS library_genres_${kind}_update
        AFTER UPDATE OF metadata_json ON library_${kind}
        WHEN OLD.metadata_json IS NOT NEW.metadata_json BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = '${kind}' AND entity_id = OLD.id;
          ${insert}
        END;
        CREATE TRIGGER IF NOT EXISTS library_genres_${kind}_delete
        AFTER DELETE ON library_${kind} BEGIN
          DELETE FROM library_entity_genres WHERE entity_kind = '${kind}' AND entity_id = OLD.id;
        END;
        INSERT OR IGNORE INTO library_entity_genres (entity_kind, entity_id, value, name)
        ${genreValues(kind, "entity.id", "entity.metadata_json", `library_${kind} AS entity`)};
      `);
    }
  })();
}
