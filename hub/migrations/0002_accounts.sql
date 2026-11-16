create table "accounts" ("id" text not null primary key, "name" text not null, "email" text not null unique, "email_verified" integer not null, "image" text, "created_at" date not null, "updated_at" date not null);

create table "sessions" ("id" text not null primary key, "expires_at" date not null, "token" text not null unique, "created_at" date not null, "updated_at" date not null, "ip_address" text, "user_agent" text, "account_id" text not null references "accounts" ("id") on delete cascade);

create table "identities" ("id" text not null primary key, "provider_account_id" text not null, "provider" text not null, "account_id" text not null references "accounts" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" date, "refresh_token_expires_at" date, "scope" text, "password" text, "created_at" date not null, "updated_at" date not null);

create table "verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expires_at" date not null, "created_at" date not null, "updated_at" date not null);

create index "sessions_account_id_idx" on "sessions" ("account_id");

create index "identities_account_id_idx" on "identities" ("account_id");

create index "verifications_identifier_idx" on "verifications" ("identifier");
create unique index "identities_provider_account_idx" on "identities" ("provider", "provider_account_id");

CREATE TABLE handles (
  handle TEXT PRIMARY KEY,
  account_id TEXT UNIQUE REFERENCES accounts (id) ON DELETE SET NULL,
  released_at INTEGER
);
