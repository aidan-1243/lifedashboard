-- Everything moved to tasks / task_log (2026-11-24 migrations). The app no longer reads these.
-- Back up first: npx wrangler d1 export DB --remote --output <file>
DROP TABLE IF EXISTS habit_logs;
DROP TABLE IF EXISTS habits;
DROP TABLE IF EXISTS med_nags;
DROP TABLE IF EXISTS med_logs;
DROP TABLE IF EXISTS meds;
DROP TABLE IF EXISTS home_log;
DROP TABLE IF EXISTS home_tasks;
DROP TABLE IF EXISTS meals;
