-- 2026-11-24: task model step 6. Dinner plans become tasks (kind = 'meal', shared, one per night).
-- details: { mkind: cook | out | leftovers | skip, name, link, notes }; "we ate" is a task_log entry.
-- The old meals table stays in place, unused, as a safety copy.
INSERT OR IGNORE INTO tasks (user_id, shared, kind, title, details, date, repeat, sort, archived, legacy_ref, created_at)
  SELECT 1, 1, 'meal',
    CASE m.kind WHEN 'cook' THEN COALESCE(m.title, 'Dinner') WHEN 'out' THEN 'Out' || COALESCE(': ' || m.title, '')
      WHEN 'leftovers' THEN 'Leftovers' || COALESCE(': ' || m.title, '') ELSE 'No dinner needed' END,
    json_object('mkind', m.kind, 'name', m.title, 'link', m.link, 'notes', m.notes),
    m.date, 'never', 0, 0, 'meal:' || m.date, COALESCE(m.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM meals m;
INSERT OR IGNORE INTO task_log (task_id, occ, status, at)
  SELECT t.id, m.date, 'done', COALESCE(m.updated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM meals m JOIN tasks t ON t.legacy_ref = 'meal:' || m.date WHERE m.eaten = 1;
