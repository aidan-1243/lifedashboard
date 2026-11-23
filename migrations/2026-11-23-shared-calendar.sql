-- 2026-11-23: events remember which calendar they came from; the household's shared
-- calendar (Settings › Shared calendar, default "Aidan & Logan") is visible to both people.
ALTER TABLE events ADD COLUMN calendar TEXT;
ALTER TABLE events ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
