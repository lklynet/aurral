// Aurral keeps the albums it was asked for, with or without files: a requested album still
// downloading, or one unmonitored so artist monitoring leaves it out.
export const albumIsOwned = (alias: string) => `(
  CASE WHEN json_valid(${alias}.metadata_json)
    THEN json_extract(${alias}.metadata_json, '$.librarySource') IS NOT NULL
      OR COALESCE(json_extract(${alias}.metadata_json, '$.trackListComplete'), 0) = 1
    ELSE 0 END
  OR EXISTS (
    SELECT 1 FROM library_management AS owner
    WHERE owner.entity_kind = 'album' AND owner.entity_id = ${alias}.id
      AND owner.monitor_mode IS NOT NULL
  )
)`;

export const albumIsMonitored = (alias: string) => `(EXISTS (
  SELECT 1 FROM library_management AS monitor
  WHERE monitor.entity_kind = 'album'
    AND monitor.entity_id = ${alias}.id
    AND coalesce(monitor.monitor_mode, '') <> 'unmonitored'
) AND CASE WHEN json_valid(${alias}.metadata_json)
  THEN coalesce(json_extract(${alias}.metadata_json, '$.monitored') = 1, 0)
  ELSE 0 END)`;

export const albumIsBeingFetched = (alias: string) => `CASE WHEN json_valid(${alias}.metadata_json)
  THEN json_extract(${alias}.metadata_json, '$.librarySource') = 'aurral'
    AND json_extract(${alias}.metadata_json, '$.monitored') = 1
  ELSE 0 END`;

export const isAlbumMonitored = (
  metadata: { monitored?: unknown } | null | undefined,
  management: { monitorMode: string | null } | null | undefined,
) => metadata?.monitored === true && management != null && management.monitorMode !== "unmonitored";
