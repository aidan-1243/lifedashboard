-- 2026-11-24: task model step 3. Home maintenance tasks become tasks (kind = 'home', shared).
-- Home keeps its own due rules (public/home.js); its settings live in tasks.details.
-- The old home_tasks / home_log tables stay in place, unused, as a safety copy.
INSERT OR IGNORE INTO tasks (user_id, shared, kind, title, details, date, repeat, nag, nag_mode, nag_time, nag_dow, remind_to, sort, archived, legacy_ref, created_at)
  SELECT 1, 1, 'home', h.name,
    json_object('lib_key', h.lib_key, 'room', h.room, 'type', h.type, 'freq', h.freq, 'months', h.months, 'who', h.who, 'est', h.est,
      'first_due', h.first_due, 'notes', h.notes, 'snooze', h.snooze_until, 'remind_dom', h.remind_dom),
    h.first_due,
    CASE h.freq WHEN 'Weekly' THEN 'weekly' WHEN 'Monthly' THEN 'monthly' WHEN 'Quarterly' THEN 'quarterly' WHEN 'Semi-annual' THEN 'semiannual'
      WHEN 'One-time' THEN 'never' ELSE 'yearly' END,
    CASE WHEN h.remind = 'none' THEN 0 ELSE 1 END, CASE WHEN h.remind = 'none' THEN 'hourly' ELSE h.remind END,
    h.remind_time, h.remind_dow, h.remind_to, h.id, h.hidden, 'home:' || h.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM home_tasks h;
INSERT OR IGNORE INTO task_log (task_id, occ, status, at)
  SELECT t.id, l.date, CASE WHEN l.skipped = 1 THEN 'skipped' ELSE 'done' END, l.date || 'T12:00:00Z'
  FROM home_log l JOIN tasks t ON t.legacy_ref = 'home:' || l.task_id;
