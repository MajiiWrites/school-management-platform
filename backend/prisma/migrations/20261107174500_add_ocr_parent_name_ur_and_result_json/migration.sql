-- OCR speed + Urdu names (2026-11-07): store the Urdu-script parent name on
-- the student record, and the finished OCR result JSON on the upload so a
-- re-opened review (and the polling review page) shows the same rows +
-- verification flags + warnings instead of re-parsing raw_text.
-- Both columns are nullable: old rows simply have no Urdu parent name /
-- no stored result (the review falls back to re-parsing raw_text).
ALTER TABLE "students" ADD COLUMN "parentNameUr" TEXT;
ALTER TABLE "ocr_uploads" ADD COLUMN "resultJson" TEXT;
