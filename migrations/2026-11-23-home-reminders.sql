-- 2026-11-23: optional reminders per Home task.
--   remind: none | hourly | daily | weekly | monthly   (only while the task is on the Home "To do" list)
--   remind_time "HH:MM", remind_dow 0-6 (weekly), remind_dom 1-31 (monthly), remind_to: user id, 0 = both of you
ALTER TABLE home_tasks ADD COLUMN remind TEXT NOT NULL DEFAULT 'none';
ALTER TABLE home_tasks ADD COLUMN remind_time TEXT;
ALTER TABLE home_tasks ADD COLUMN remind_dow INTEGER;
ALTER TABLE home_tasks ADD COLUMN remind_dom INTEGER;
ALTER TABLE home_tasks ADD COLUMN remind_to INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS home_nags (key TEXT PRIMARY KEY, last_at TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1);
