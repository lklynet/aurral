import type Database from "better-sqlite3";
import { createAurral3Schema } from "./aurral-3-schema.ts";

type Migration = (db: Database.Database) => void;

export const migrations: Migration[] = [createAurral3Schema];

export function migrate(db: Database.Database, steps: readonly Migration[] = migrations) {
  const applied = () => Number(db.pragma("user_version", { simple: true }));
  if (applied() >= steps.length) return;
  db.transaction(() => {
    for (const step of steps.slice(applied())) step(db);
    db.pragma(`user_version = ${steps.length}`);
  }).immediate();
}
