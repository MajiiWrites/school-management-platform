-- Registration profile (2026-11-08): signup collects the school's
-- address / tehsil / district / province / category / org type and the
-- admin's name + phone. All new columns are nullable, so this is safe on
-- an empty database and on existing schools (old rows simply have NULLs
-- until the profile is filled in) — no data migration needed.
--
-- CHECK constraints live in migration SQL only (Prisma 6.x has no
-- @@check). The values match the zod enums in
-- backend/src/modules/auth/routes.ts and the constants in
-- backend/src/modules/auth/service.ts — keep all three in sync.

ALTER TABLE schools
  ADD COLUMN "address" TEXT,
  ADD COLUMN "tehsil" TEXT,
  ADD COLUMN "district" TEXT,
  ADD COLUMN "province" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "orgType" TEXT;

ALTER TABLE users
  ADD COLUMN "name" TEXT,
  ADD COLUMN "phoneEnc" TEXT,
  ADD COLUMN "phoneHash" TEXT;

ALTER TABLE schools
  ADD CONSTRAINT schools_province_check CHECK ("province" IS NULL OR "province" IN (
    'Punjab', 'Sindh', 'Khyber Pakhtunkhwa', 'Balochistan',
    'Gilgit-Baltistan', 'Azad Jammu & Kashmir', 'Islamabad Capital Territory'
  )),
  ADD CONSTRAINT schools_category_check CHECK ("category" IS NULL OR "category" IN (
    'Private', 'Public', 'Semi-Government'
  )),
  ADD CONSTRAINT schools_org_type_check CHECK ("orgType" IS NULL OR "orgType" IN (
    'School', 'College'
  ));
