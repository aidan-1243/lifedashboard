-- Talks with people live in the task log (on each person's catch-up task), like every other task.
-- `how` = talked / called / texted / saw; `who` = who reached out (me / them; NULL = not recorded).
ALTER TABLE task_log ADD COLUMN how TEXT;
ALTER TABLE task_log ADD COLUMN who TEXT;

-- Every person gets a catch-up task; with no check-in it has no date and never comes due.
INSERT INTO tasks (user_id, kind, title, details, date, repeat, nag, nag_mode, archived, legacy_ref, created_at)
  SELECT p.user_id, 'catchup', 'Catch up with ' || p.name,
    json_object('person_id', p.id, 'first', substr(p.name, 1, instr(p.name || ' ', ' ') - 1), 'every', p.checkin_days),
    NULL, 'never', 0, 'hourly', 0, 'catchup:' || p.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM people p WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.legacy_ref = 'catchup:' || p.id);
UPDATE tasks SET archived = 0 WHERE kind = 'catchup' AND legacy_ref IN (SELECT 'catchup:' || id FROM people);

-- Saved talks (contact_log) -> the catch-up log. Ones already copied (same time) just get their `how`.
UPDATE task_log SET how = (SELECT c.how FROM contact_log c JOIN tasks t ON t.legacy_ref = 'catchup:' || c.person_id
    WHERE t.id = task_log.task_id AND c.at = task_log.at ORDER BY c.id DESC LIMIT 1)
  WHERE how IS NULL AND task_id IN (SELECT id FROM tasks WHERE kind = 'catchup');
-- Any not copied yet (day in US Central; CST is close enough for a one-time move)
INSERT OR IGNORE INTO task_log (task_id, occ, status, at, by_user, how)
  SELECT t.id, date(c.at, '-6 hours'), 'done', c.at, t.user_id, c.how
  FROM contact_log c JOIN tasks t ON t.legacy_ref = 'catchup:' || c.person_id
  WHERE NOT EXISTS (SELECT 1 FROM task_log l WHERE l.task_id = t.id AND l.at = c.at);
UPDATE task_log SET how = 'talked' WHERE how IS NULL AND task_id IN (SELECT id FROM tasks WHERE kind = 'catchup');
-- contact_log stays as a safety copy for now; nothing reads or writes it.
