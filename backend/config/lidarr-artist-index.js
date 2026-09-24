function hasUniqueLidarrArtistIdIndex(db) {
  return db.prepare("PRAGMA index_list(lidarr_artist_id_map)").all()
    .some(({ name, unique }) => name === "idx_lidarr_artist_id_map_foreign_id" && unique);
}

export function ensureUniqueLidarrArtistIdIndex(db) {
  if (hasUniqueLidarrArtistIdIndex(db)) return;

  db.transaction(() => {
    if (hasUniqueLidarrArtistIdIndex(db)) return;

    const duplicateLidarrArtistIds = db
      .prepare(
        `SELECT lidarr_foreign_artist_id
         FROM lidarr_artist_id_map
         GROUP BY lidarr_foreign_artist_id
         HAVING COUNT(*) > 1`,
      )
      .all();

    if (duplicateLidarrArtistIds.length > 0) {
      const deleteDuplicateLidarrArtistId = db.prepare(
        `DELETE FROM lidarr_artist_id_map
         WHERE lidarr_foreign_artist_id = ?
           AND musicbrainz_id NOT IN (
             SELECT musicbrainz_id
             FROM lidarr_artist_id_map
             WHERE lidarr_foreign_artist_id = ?
             ORDER BY updated_at DESC, musicbrainz_id ASC
             LIMIT 1
           )`,
      );
      for (const duplicate of duplicateLidarrArtistIds) {
        deleteDuplicateLidarrArtistId.run(
          duplicate.lidarr_foreign_artist_id,
          duplicate.lidarr_foreign_artist_id,
        );
      }
    }

    db.exec(`
      DROP INDEX IF EXISTS idx_lidarr_artist_id_map_foreign_id;
      CREATE UNIQUE INDEX idx_lidarr_artist_id_map_foreign_id
        ON lidarr_artist_id_map (lidarr_foreign_artist_id);
    `);
  }).immediate();
}
