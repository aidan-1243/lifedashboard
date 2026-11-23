-- 2026-11-24: task model step 7. Trips are groups: any task can belong to a trip.
ALTER TABLE items ADD COLUMN trip_id INTEGER;
UPDATE items SET trip_id = (SELECT t.id FROM trips t WHERE t.external_id IS NOT NULL AND items.external_id LIKE t.external_id || ':%')
  WHERE external_id IS NOT NULL;
