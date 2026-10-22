export function isOwnKey<Table extends object>(table: Table, key: PropertyKey): key is keyof Table {
  return Object.hasOwn(table, key);
}
