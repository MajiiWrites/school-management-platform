-- Round 5 (F11): Duplicate always 409'd — the old unique key
-- (schoolId, type, language) allowed exactly ONE custom template per
-- language, and duplicates are always created as type 'custom'. Widen the
-- key to (schoolId, type, language, name) so a school can hold several
-- custom templates with distinct names. Seeded defaults were created with
-- name NULL, and Postgres treats NULLs as distinct in a unique index, so
-- backfill them first (same "type (LANG)" naming the test seeds use);
-- template names are required on create, so no new NULL names appear.
UPDATE "message_templates" SET "name" = "type" || ' (' || UPPER("language") || ')' WHERE "name" IS NULL;
DROP INDEX IF EXISTS "message_templates_schoolId_type_language_key";
CREATE UNIQUE INDEX "message_templates_schoolId_type_language_name_key" ON "message_templates"("schoolId", "type", "language", "name");
