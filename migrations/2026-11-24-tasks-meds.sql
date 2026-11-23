-- 2026-11-24: task model step 2. Medications become tasks (kind = 'med'); the old meds /
-- med_logs tables stay in place, unused, as a safety copy.
-- A single daily time stays a plain "Daily" repeat; anything else becomes a Custom repeat.
INSERT OR IGNORE INTO tasks (user_id, kind, title, details, date, time, repeat, custom, nag, nag_mode, sort, archived, legacy_ref, created_at)
  SELECT m.user_id, 'med', m.name,
    json_object('dose', m.dose, 'notes', m.notes),
    COALESCE(m.start_date, substr(m.created_at, 1, 10), date('now', '-6 hours')),
    CASE WHEN m.freq = 'daily' AND m.interval_n = 1 AND instr(m.times, ',') = 0 AND m.dose_times IS NULL THEN m.times END,
    CASE WHEN m.freq = 'daily' AND m.interval_n = 1 AND instr(m.times, ',') = 0 AND m.dose_times IS NULL THEN 'daily' ELSE 'custom' END,
    CASE WHEN m.freq = 'daily' AND m.interval_n = 1 AND instr(m.times, ',') = 0 AND m.dose_times IS NULL THEN NULL
      ELSE json_object('freq', m.freq, 'interval_n', m.interval_n, 'weekdays', CASE WHEN m.freq = 'weekly' THEN m.weekdays END,
        'month_days', CASE WHEN m.freq = 'monthly' THEN COALESCE(m.month_days, CAST(m.month_day AS TEXT)) END,
        'times', m.times, 'dose_times', json(m.dose_times)) END,
    CASE WHEN m.remind = 'none' THEN 0 ELSE 1 END, 'hourly', m.id, CASE WHEN m.active = 1 THEN 0 ELSE 1 END,
    'med:' || m.id, COALESCE(m.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM meds m;
INSERT OR IGNORE INTO task_log (task_id, occ, status, at)
  SELECT t.id, l.date || ' ' || l.slot, CASE WHEN l.status = 'skipped' THEN 'skipped' ELSE 'done' END, l.taken_at
  FROM med_logs l JOIN tasks t ON t.legacy_ref = 'med:' || l.med_id;
