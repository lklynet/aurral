import assert from "node:assert/strict";

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

export function tableColumns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((column) => column.name),
  );
}

export function assertBetterAuthCoreSchema(db) {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((table) => table.name),
  );
  for (const table of ["users", "sessions", "accounts", "verifications"]) {
    assert.equal(tables.has(table), true, `Better Auth table ${table} is missing`);
  }

  for (const column of [
    "id",
    "name",
    "email",
    "email_verified",
    "created_at",
    "updated_at",
    "username",
    "display_username",
  ]) {
    assert.equal(tableColumns(db, "users").has(column), true, `users.${column} is missing`);
  }
  for (const column of [
    "id",
    "user_id",
    "token",
    "expires_at",
    "created_at",
    "updated_at",
    "ip_address",
    "user_agent",
  ]) {
    assert.equal(tableColumns(db, "sessions").has(column), true, `sessions.${column} is missing`);
  }
  for (const column of [
    "id",
    "user_id",
    "issuer",
    "account_id",
    "provider_id",
    "password",
    "created_at",
    "updated_at",
  ]) {
    assert.equal(tableColumns(db, "accounts").has(column), true, `accounts.${column} is missing`);
  }
  for (const column of [
    "id",
    "identifier",
    "value",
    "expires_at",
    "created_at",
    "updated_at",
  ]) {
    assert.equal(
      tableColumns(db, "verifications").has(column),
      true,
      `verifications.${column} is missing`,
    );
  }
}

function insertKnownColumns(db, table, values, requiredColumns = []) {
  const columns = tableColumns(db, table);
  for (const column of requiredColumns) {
    assert.equal(columns.has(column), true, `${table}.${column} is required by this fixture`);
  }
  const entries = Object.entries(values).filter(([column]) => columns.has(column));
  const names = entries.map(([column]) => quoteIdentifier(column)).join(", ");
  const placeholders = entries.map(() => "?").join(", ");
  db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders})`).run(
    ...entries.map(([, value]) => value),
  );
}

export function seedBetterAuthUser(
  db,
  {
    id,
    email,
    name,
    username,
    password,
    role = "user",
    permissions = {},
    issuer = "local:credential",
    providerId = "credential",
  },
) {
  const now = new Date().toISOString();
  insertKnownColumns(db, "users", {
    id,
    name,
    email,
    email_verified: 0,
    created_at: now,
    updated_at: now,
    username,
    display_username: username,
    role,
    permissions: JSON.stringify(permissions),
  }, ["role", "permissions"]);
  insertKnownColumns(db, "accounts", {
    user_id: id,
    issuer,
    account_id: String(id),
    provider_id: providerId,
    password,
    created_at: now,
    updated_at: now,
  });
  return readBetterAuthUser(db, id);
}

export function readBetterAuthUser(db, id) {
  return db.prepare(`SELECT * FROM ${quoteIdentifier("users")} WHERE id = ?`).get(id);
}

export function readBetterAuthAccount(db, userId) {
  return db
    .prepare(`SELECT * FROM ${quoteIdentifier("accounts")} WHERE user_id = ? ORDER BY created_at`)
    .all(userId);
}

export function readBetterAuthSessions(db, userId) {
  return db
    .prepare(`SELECT * FROM ${quoteIdentifier("sessions")} WHERE user_id = ? ORDER BY created_at`)
    .all(userId);
}

export async function requestBetterAuth(server, path, {
  method = "GET",
  body,
  token,
  headers = {},
} = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/auth${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return {
    response,
    payload,
    authToken: response.headers.get("set-auth-token"),
    cookie: response.headers.get("set-cookie"),
  };
}
