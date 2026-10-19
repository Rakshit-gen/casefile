-- Customer data the agent can look at. Fictional accounts and zones.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'business', 'enterprise')),
  contact_email TEXT NOT NULL
);

CREATE TABLE zones (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL UNIQUE,
  ssl_mode TEXT NOT NULL CHECK (ssl_mode IN ('off', 'flexible', 'full', 'strict')),
  origin_https_only INTEGER NOT NULL DEFAULT 0,
  origin_cert_valid INTEGER NOT NULL DEFAULT 1,
  origin_up INTEGER NOT NULL DEFAULT 1,
  error_rate_5xx REAL NOT NULL DEFAULT 0,
  cache_purged_at INTEGER
);

CREATE TABLE kb_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL
);
