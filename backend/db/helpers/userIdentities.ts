import { db } from "../../config/db-sqlite.ts";
import type { UserIdentitiesRow } from "../rows.ts";

export interface UserIdentity {
  id: number;
  userId: number;
  providerType: string;
  providerKey: string;
  subject: string;
  displayName: string | null;
  linkedAt: number;
}

interface IdentityLink {
  providerType: string;
  providerKey: string;
  subject: string;
  displayName?: string | null;
}

const findByProviderStmt = db.prepare<[string, string, string], UserIdentitiesRow>(
  "SELECT * FROM user_identities WHERE provider_type = ? AND provider_key = ? AND subject = ?",
);
const getForUserStmt = db.prepare<[number], UserIdentitiesRow>(
  "SELECT * FROM user_identities WHERE user_id = ? ORDER BY linked_at ASC",
);
const getByIdStmt = db.prepare<[number], UserIdentitiesRow>(
  "SELECT * FROM user_identities WHERE id = ?",
);
const countForUserStmt = db.prepare<[number], { count: number }>(
  "SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?",
);
const insertStmt = db.prepare<[number, string, string, string, string | null, number]>(
  "INSERT INTO user_identities (user_id, provider_type, provider_key, subject, display_name, linked_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const deleteByIdStmt = db.prepare<[number]>("DELETE FROM user_identities WHERE id = ?");
const deleteProviderForUserStmt = db.prepare<[number, string]>(
  "DELETE FROM user_identities WHERE user_id = ? AND provider_type = ?",
);

const toIdentity = (row: UserIdentitiesRow | undefined): UserIdentity | null =>
  row
    ? {
        id: row.id,
        userId: row.user_id,
        providerType: row.provider_type,
        providerKey: row.provider_key,
        subject: row.subject,
        displayName: row.display_name,
        linkedAt: row.linked_at,
      }
    : null;

export const userIdentityOps = {
  findByProvider(providerType: string, providerKey: string, subject: string) {
    return toIdentity(findByProviderStmt.get(providerType, providerKey, subject));
  },
  getForUser(userId: number) {
    return getForUserStmt.all(parseInt(String(userId), 10)).map(toIdentity);
  },
  getById(id: number) {
    return toIdentity(getByIdStmt.get(parseInt(String(id), 10)));
  },
  countForUser(userId: number) {
    return countForUserStmt.get(parseInt(String(userId), 10))!.count;
  },
  unlink(id: number) {
    const result = deleteByIdStmt.run(parseInt(String(id), 10));
    return result.changes > 0;
  },
  replaceForUser(
    userId: number,
    { providerType, providerKey, subject, displayName = null }: IdentityLink,
  ) {
    return db.transaction(() => {
      deleteProviderForUserStmt.run(parseInt(String(userId), 10), providerType);
      const linkedAt = Date.now();
      const result = insertStmt.run(
        parseInt(String(userId), 10),
        providerType,
        providerKey,
        subject,
        displayName,
        linkedAt,
      );
      return toIdentity({
        id: result.lastInsertRowid as number,
        user_id: userId,
        provider_type: providerType,
        provider_key: providerKey,
        subject,
        display_name: displayName,
        linked_at: linkedAt,
      });
    })();
  },
  link(userId: number, { providerType, providerKey, subject, displayName = null }: IdentityLink) {
    const result = insertStmt.run(
      parseInt(String(userId), 10),
      providerType,
      providerKey,
      subject,
      displayName,
      Date.now(),
    );
    return toIdentity({
      id: result.lastInsertRowid as number,
      user_id: userId,
      provider_type: providerType,
      provider_key: providerKey,
      subject,
      display_name: displayName,
      linked_at: Date.now(),
    });
  },
};
