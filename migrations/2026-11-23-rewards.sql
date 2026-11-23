-- 2026-11-23: Rewards (merged from the Reward Tracker artifact). Shared by the household.
-- Card details stay as JSON (benefits, certificates, snoozes); see public/rewards.js.
CREATE TABLE IF NOT EXISTS rw_cards (
  id TEXT PRIMARY KEY,
  owner INTEGER NOT NULL,          -- user id whose card it is
  data TEXT NOT NULL,              -- JSON: name, issuer, fee, renews, currency, benefits, certs, ...
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS rw_logs (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  benefit_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  period TEXT,                     -- "2026-11", "2026-Q4", "2026-H2", "2026"
  kind TEXT NOT NULL DEFAULT 'use',-- use | ytd | bonus
  amount REAL NOT NULL,
  date TEXT,
  note TEXT,
  extra TEXT,                      -- JSON (points, cash, cpp for bonuses)
  by_user INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rw_logs_card ON rw_logs(card_id, year);
CREATE TABLE IF NOT EXISTS rw_points (
  user_id INTEGER PRIMARY KEY,
  balances TEXT NOT NULL DEFAULT '{}',
  updated TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS rw_config (key TEXT PRIMARY KEY, value TEXT NOT NULL); -- cpp, pcpp, transfers
