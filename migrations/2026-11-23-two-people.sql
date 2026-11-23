-- 2026-11-23: two people. Run once on databases created before this date.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,              -- the Cloudflare Access sign-in email
  name TEXT,
  ntfy_topic TEXT,                -- this person's ntfy topic (user 1 falls back to the NTFY_TOPIC secret)
  service_token TEXT UNIQUE       -- Access service token Client ID for this person's Shortcuts (optional)
);
INSERT OR IGNORE INTO users (id, email, name) VALUES (1, 'aidan.mccoy6@gmail.com', 'Aidan');
ALTER TABLE items ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE items ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE habits ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meds ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS items_user ON items(user_id, status);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, start_at);
