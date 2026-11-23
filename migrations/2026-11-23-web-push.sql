-- 2026-11-23: Life's own notifications (Web Push). One row per device that turned them on.
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs(user_id);
