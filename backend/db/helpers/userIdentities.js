import { db } from "../../config/db-sqlite.js";

const findByProviderStmt = db.prepare(
  "SELECT * FROM user_identities WHERE provider_type = ? AND provider_key = ? AND subject = ?",
);
const getForUserStmt = db.prepare(
  "SELECT * FROM user_identities WHERE user_id = ? ORDER BY linked_at ASC",
);
const getByIdStmt = db.prepare("SELECT * FROM user_identities WHERE id = ?");
const countForUserStmt = db.prepare(
  "SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?",
);
const insertStmt = db.prepare(
  "INSERT INTO user_identities (user_id, provider_type, provider_key, subject, display_name, linked_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const deleteByIdStmt = db.prepare("DELETE FROM user_identities WHERE id = ?");

const toIdentity = (row) =>
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
  findByProvider(providerType, providerKey, subject) {
    return toIdentity(findByProviderStmt.get(providerType, providerKey, subject));
  },
  getForUser(userId) {
    return getForUserStmt.all(parseInt(userId, 10)).map(toIdentity);
  },
  getById(id) {
    return toIdentity(getByIdStmt.get(parseInt(id, 10)));
  },
  countForUser(userId) {
    return countForUserStmt.get(parseInt(userId, 10)).count;
  },
  unlink(id) {
    const result = deleteByIdStmt.run(parseInt(id, 10));
    return result.changes > 0;
  },
  link(userId, { providerType, providerKey, subject, displayName = null }) {
    const result = insertStmt.run(
      parseInt(userId, 10),
      providerType,
      providerKey,
      subject,
      displayName,
      Date.now(),
    );
    return toIdentity({
      id: result.lastInsertRowid,
      user_id: userId,
      provider_type: providerType,
      provider_key: providerKey,
      subject,
      display_name: displayName,
      linked_at: Date.now(),
    });
  },
};
