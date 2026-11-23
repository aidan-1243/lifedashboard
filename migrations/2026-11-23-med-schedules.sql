-- 2026-11-23: flexible medication schedules and reminder choice (see public/meds.js)
ALTER TABLE meds ADD COLUMN month_days TEXT;
ALTER TABLE meds ADD COLUMN dose_times TEXT;
ALTER TABLE meds ADD COLUMN remind TEXT NOT NULL DEFAULT 'hourly';
