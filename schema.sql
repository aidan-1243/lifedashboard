-- Life Dashboard schema. Safe to re-run.

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT,
  area TEXT,                      -- hoa | travel | people | home | work
  kind TEXT NOT NULL DEFAULT 'task', -- task | note
  due_at TEXT,                    -- ISO UTC
  nag TEXT NOT NULL DEFAULT 'once', -- none | once | hourly | 15m
  repeat_days INTEGER,            -- recurring (e.g. HVAC filter every 90 days)
  top3 INTEGER NOT NULL DEFAULT 0,
  person_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open', -- open | done
  snooze_until TEXT,
  last_notified_at TEXT,
  notify_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | wayfare | ...
  external_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS items_open ON items(status, due_at);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  birthday TEXT,                  -- YYYY-MM-DD or --MM-DD (year unknown)
  phone TEXT,
  email TEXT,
  notes TEXT,
  checkin_days INTEGER,           -- null = not tracked for reach-outs
  last_contact_at TEXT,
  last_contact_how TEXT,
  external_id TEXT UNIQUE,        -- vCard UID
  bday_remind INTEGER NOT NULL DEFAULT 0, -- nag hourly on their birthday until done
  bday_notify INTEGER NOT NULL DEFAULT 1  -- 0 = keep the date, but don't show it on Today or in the briefing
);
-- Older databases, run once:  ALTER TABLE people ADD COLUMN bday_notify INTEGER NOT NULL DEFAULT 1;

-- Your settings for synced calendar events. Key: "one:<title>|<start>" or "all:<lowercased title>".
CREATE TABLE IF NOT EXISTS event_prefs (
  key TEXT PRIMARY KEY,
  hidden INTEGER,                 -- 1 hide, 0 show (overrides the "hide birthday events" setting)
  leave INTEGER,                  -- 1 always leave-by alert, 0 never, NULL = when it has a location
  travel_min INTEGER,
  note TEXT,
  label TEXT
);
-- For databases created before bday_remind existed, run once:
--   ALTER TABLE people ADD COLUMN bday_remind INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS contact_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  how TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  travel_min INTEGER              -- minutes from home, sent by the Shortcut (optional)
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,       -- YYYY-MM-DD
  end_date TEXT,
  link TEXT,                      -- e.g. the Wayfare artifact
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT UNIQUE
);

-- Passport, Global Entry, etc. Each one keeps a linked renewal reminder in items.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  expires_on TEXT NOT NULL,       -- YYYY-MM-DD
  remind_months INTEGER NOT NULL DEFAULT 9,
  notes TEXT
);

-- Close circle. people.circle: 'family' | 'close' | 'friends' | NULL
--   Older databases, run once: ALTER TABLE people ADD COLUMN circle TEXT;
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  idea TEXT NOT NULL,
  link TEXT,
  status TEXT NOT NULL DEFAULT 'idea',   -- idea | bought | given
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  label TEXT NOT NULL,            -- Anniversary, etc.
  date TEXT NOT NULL,             -- YYYY-MM-DD or --MM-DD
  remind INTEGER NOT NULL DEFAULT 0,
  UNIQUE (person_id, label, date)
);

-- ---- Old tables, replaced by tasks / task_log (docs/tasks-design.md) ----
-- Kept here only so the older migrations still run on a new database;
-- migrations/2026-11-25-drop-old-tables.sql removes them (meds, med_logs, med_nags, meals,
-- home_tasks, home_log, habits, habit_logs). Nothing in the app reads them.

-- Medications: scheduled doses, a taken log, and reminder state
CREATE TABLE IF NOT EXISTS meds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dose TEXT,
  times TEXT NOT NULL,            -- "08:00,20:00"
  freq TEXT NOT NULL DEFAULT 'daily',   -- daily | weekly | monthly (see public/meds.js)
  interval_n INTEGER NOT NULL DEFAULT 1,
  weekdays TEXT,                  -- weekly: "1,4" (0 = Sunday)
  month_day INTEGER,              -- monthly: 1-31
  start_date TEXT,                -- YYYY-MM-DD; anchors "every N"
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS med_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  med_id INTEGER NOT NULL,
  date TEXT NOT NULL,             -- local YYYY-MM-DD
  slot TEXT NOT NULL,             -- "08:00"
  taken_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'taken',  -- taken | skipped
  UNIQUE (med_id, date, slot)
);
CREATE TABLE IF NOT EXISTS med_nags (
  key TEXT PRIMARY KEY,
  last_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);

-- Meals: one dinner plan per day
CREATE TABLE IF NOT EXISTS meals (
  date TEXT PRIMARY KEY,          -- YYYY-MM-DD
  title TEXT,                     -- what you're making (or where you're eating)
  kind TEXT NOT NULL DEFAULT 'cook',  -- cook | out | leftovers | skip
  link TEXT,                      -- recipe
  notes TEXT,
  updated_at TEXT,
  eaten INTEGER NOT NULL DEFAULT 0   -- 1 = already ate; hides it from Today
);
-- Older databases, run once: ALTER TABLE meals ADD COLUMN eaten INTEGER NOT NULL DEFAULT 0;

-- Home maintenance (merged from the Home Maintenance artifact; logic in public/home.js)
CREATE TABLE IF NOT EXISTS home_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lib_key TEXT UNIQUE,            -- "lib:<n>" for library tasks, NULL for your own
  name TEXT NOT NULL,
  room TEXT,
  type TEXT,
  freq TEXT NOT NULL,
  months TEXT NOT NULL DEFAULT '*',
  who TEXT,
  est TEXT,
  first_due TEXT,
  notes TEXT,
  snooze_until TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS home_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  UNIQUE (task_id, date)
);

CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS habit_logs (
  habit_id INTEGER NOT NULL,
  date TEXT NOT NULL,             -- YYYY-MM-DD, local
  PRIMARY KEY (habit_id, date)
);

-- ---- end of old tables ----

-- Leave-by alerts already sent (so a re-sync doesn't repeat them)
CREATE TABLE IF NOT EXISTS event_alerts (
  key TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
-- Events gained travel time for leave-by alerts. Older databases, run once:
--   ALTER TABLE events ADD COLUMN travel_min INTEGER;

CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_ip ON auth_failures(ip, at);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,              -- the Cloudflare Access sign-in email
  name TEXT,
  ntfy_topic TEXT,                -- old; dropped by migrations/2026-11-25-drop-ntfy.sql
  service_token TEXT UNIQUE       -- Access service token Client ID for this person's Shortcuts (optional)
);
INSERT OR IGNORE INTO users (id, email, name) VALUES (1, 'aidan.mccoy6@gmail.com', 'Aidan');
-- Per-person columns (user_id on items, people, habits, meds, events, documents; items.shared) are
-- added by migrations/2026-11-23-two-people.sql. Run it after this file on a new database too.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('quiet_start', '22'),
  ('quiet_end', '7'),
  ('briefing_hour', '7'),
  ('last_briefing', ''),
  ('events_synced_at', '');
