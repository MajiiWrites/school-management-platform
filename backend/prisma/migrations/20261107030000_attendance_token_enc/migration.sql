-- Fix C (Phase 9, 2026-11-07): the Classes page forgot attendance links on
-- reload because only the token HASH was stored — the raw token (and hence
-- the link URL) could never be reconstructed after generation. Store the
-- token AES-256-GCM-encrypted alongside the hash so the admin UI can show
-- the existing link (Copy / Regenerate / Revoke) after a reload. The raw
-- token is still never logged; only the admin JWT flow can read it back.
-- Safe on existing rows: NULL means "link created before this fix" — the UI
-- shows the active state and offers Regenerate to get a copyable link.
ALTER TABLE "classes" ADD COLUMN "attendance_token_enc" TEXT;
