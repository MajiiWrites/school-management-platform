-- REGRESSION FIX (2026-11-07): commit 862978a9 broke live OCR uploads.
-- The speed round made the upload write live progress statuses 'reading'
-- and 'verifying' (polled by the review page), but the original CHECK
-- (init migration) only allowed processing/review/saved/failed. The FIRST
-- progress write threw Postgres 23514, so EVERY upload failed ~1s after
-- attach with status 'failed' and a generic banner — before any OCR ran.
-- Widen the set to the six statuses the service actually writes.
ALTER TABLE "ocr_uploads" DROP CONSTRAINT "ocr_uploads_status_check";
ALTER TABLE "ocr_uploads" ADD CONSTRAINT "ocr_uploads_status_check" CHECK ("status" IN ('processing', 'reading', 'verifying', 'review', 'saved', 'failed'));
