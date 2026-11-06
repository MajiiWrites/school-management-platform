-- One-time demo-account removal (Phase 6A; user decision 2026-11-06 22:53 PKT).
-- The live site must be completely empty. This deletes ONLY the demo school
-- (slug = 'demo-public-school'); the WHERE clause is the safety guard, so no
-- other school can ever be affected by this statement.
-- All tenant tables cascade from schools (ON DELETE CASCADE), so the school's
-- users, classes, students, attendance, fees, messages, results and every
-- other record go with it in the same statement.
-- Safe on a fresh/empty database: the DELETE simply affects 0 rows.
DELETE FROM schools WHERE slug = 'demo-public-school';
