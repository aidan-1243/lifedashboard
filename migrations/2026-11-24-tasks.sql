-- 2026-11-24: the one task model (docs/tasks-design.md). Habits move here first; the old
-- habits / habit_logs tables are left in place (no longer used) as a safety copy.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'task',   -- habit (more kinds move in later)
  title TEXT NOT NULL,
  details TEXT,                        -- JSON, per kind
  date TEXT,                           -- first / next date, YYYY-MM-DD
  time TEXT,                           -- HH:MM or NULL (date only)
  repeat TEXT NOT NULL DEFAULT 'never',
  custom TEXT,                         -- JSON for repeat = custom
  nag INTEGER NOT NULL DEFAULT 0,
  nag_mode TEXT NOT NULL DEFAULT 'hourly', -- hourly | daily | weekly
  nag_time TEXT,
  nag_dow INTEGER,
  remind_to INTEGER,                   -- user id, 0 = both, NULL = owner
  snooze_until TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  legacy_ref TEXT UNIQUE,              -- where it came from (habit:12)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, kind, archived);
CREATE TABLE IF NOT EXISTS task_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  occ TEXT NOT NULL,                   -- YYYY-MM-DD or "YYYY-MM-DD HH:MM"
  status TEXT NOT NULL DEFAULT 'done', -- done | partial | skipped
  amount REAL,
  at TEXT NOT NULL,
  by_user INTEGER,
  UNIQUE (task_id, occ)
);
CREATE TABLE IF NOT EXISTS task_nags (key TEXT PRIMARY KEY, last_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1);

-- Move habits in (daily, date-only, starting at their first log or today)
INSERT OR IGNORE INTO tasks (user_id, kind, title, date, repeat, sort, archived, legacy_ref, created_at)
  SELECT h.user_id, 'habit', h.name,
    COALESCE((SELECT MIN(date) FROM habit_logs l WHERE l.habit_id = h.id), date('now', '-6 hours')),
    'daily', h.sort, h.archived, 'habit:' || h.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM habits h;
INSERT OR IGNORE INTO task_log (task_id, occ, status, at)
  SELECT t.id, l.date, 'done', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM habit_logs l JOIN tasks t ON t.legacy_ref = 'habit:' || l.habit_id;
