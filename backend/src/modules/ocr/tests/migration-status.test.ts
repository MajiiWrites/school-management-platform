// REGRESSION GUARD (2026-11-07): commit 862978a9 broke live OCR uploads.
// The speed round added 'reading'/'verifying' progress statuses to the
// service's UploadRecord type but never widened the ocr_uploads CHECK
// constraint (init migration allowed only processing/review/saved/failed),
// so the FIRST progress write threw Postgres 23514 and every upload
// failed ~1s after attach. The unit harness uses a fake in-memory DB with
// no CHECK, so it never caught this — this test ties the TS status union
// to the SQL constraint: the LATEST ocr_uploads_status_check definition
// across all migrations must allow exactly the statuses the service
// writes. Run with the OCR harness (node:test, sequential).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(DIR, '../../../../prisma/migrations');
const SERVICE_FILE = path.resolve(DIR, '../service.ts');

function sqlStatuses(): string[] {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  let last: string[] | null = null;
  for (const d of dirs) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, d, 'migration.sql'), 'utf8');
    // Match every (re)definition; the last one in migration order wins.
    const re =
      /ocr_uploads_status_check"\s+CHECK\s*\(\s*"status"\s+IN\s*\(([^)]*)\)\)/g;
    for (const m of sql.matchAll(re)) {
      last = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    }
  }
  assert.ok(last, 'no ocr_uploads_status_check definition found in migrations');
  return last as string[];
}

function tsStatuses(): string[] {
  const src = readFileSync(SERVICE_FILE, 'utf8');
  const m = src.match(/status:\s*((?:'[^']+'\s*\|\s*)+'[^']+')/);
  assert.ok(m, 'UploadRecord status union not found in service.ts');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

test('ocr_uploads CHECK allows every status the service writes', () => {
  const sql = sqlStatuses().sort();
  const ts = tsStatuses().sort();
  assert.deepEqual(
    sql,
    ts,
    `SQL CHECK (${sql.join(', ')}) != service status union (${ts.join(', ')}). ` +
      'Widen the constraint in a new migration when adding a status.',
  );
  assert.ok(sql.includes('reading'), "CHECK must allow 'reading'");
  assert.ok(sql.includes('verifying'), "CHECK must allow 'verifying'");
});
