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

-- One row per support case. The conversation itself lives in the case's
-- Durable Object; this is what the console and the metrics read.
CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  subject TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'waiting_on_approval', 'escalated', 'resolved', 'human_only')),
  agent_version TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  first_response_at INTEGER,
  resolved_at INTEGER,
  escalated_at INTEGER,
  summary TEXT
);
CREATE INDEX cases_by_status ON cases (status, opened_at);

-- Changes the agent wants to make. Nothing here runs until every gate has
-- said yes: policy, reviewer, then a person (or the low-risk flag).
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  params TEXT NOT NULL,
  rationale TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'high')),
  status TEXT NOT NULL CHECK (status IN ('denied', 'rejected_by_reviewer', 'awaiting_human', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  gate_notes TEXT NOT NULL DEFAULT '[]',
  requested_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  result TEXT
);
CREATE INDEX actions_waiting ON actions (status, requested_at);
