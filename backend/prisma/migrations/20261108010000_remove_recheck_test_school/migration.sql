-- One-time recheck cleanup (ONE test school).
-- Deletes ONLY the "Recheck School Nov 2026" TEST school below. The WHERE
-- clause is the safety guard, so no other school can ever be affected.
-- All tenant tables cascade from schools (ON DELETE CASCADE), so the
-- school's users, classes, students, attendance, fees, messages, results
-- and every other record go with it in the same statement.
-- Safe on a fresh/empty database: the DELETE simply affects 0 rows.
--
-- TIMING — CRITICAL: push this migration ONLY AFTER the recheck live
-- re-test has finished and the TEST school exists in the live DB. Prisma
-- migrations run once, at deploy time: if this is pushed before the TEST
-- school is created, it deletes 0 rows and will NOT clean it up later.
-- The site must end clean-empty again after this migration is pushed.
--
-- SCHOOL:
--   "Recheck School Nov 2026" -> recheck-school-nov-2026 (VERIFIED slug,
--     school id 45e644bf-a553-4882-8720-71f366e14b88; admin
--     recheck-20261108@example.com).
-- Email fallback (delete by school id via users.email): the admin is
-- recheck-20261108@example.com, a fake address used only by this TEST
-- school, so the OR condition cannot match a real school. It is the
-- safety net if the slug ever differs (e.g. signup appends a random
-- suffix when a slug already exists).
DELETE FROM schools
WHERE slug IN ('recheck-school-nov-2026')
   OR id IN (SELECT "schoolId" FROM users WHERE email IN ('recheck-20261108@example.com'));
