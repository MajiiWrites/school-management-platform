# OCR Module — Student-list image upload → review → students

Extracts student names (English + Urdu), roll numbers and parent phone
numbers from a photo/scan of a class list, shows them on a review screen,
and saves the admin-edited rows as students (merge, no duplicates).

## How it works

1. **Upload** — `POST /api/v1/classes/:id/ocr-upload` (multipart `image`,
   JPG/PNG/WebP ≤ 10 MB). The file is stored under `UPLOAD_DIR/ocr/` and an
   `ocr_uploads` row is created with status `processing`.
2. **OCR** — Tesseract CLI, languages `eng+urd` (env `OCR_LANGS`), `--psm 6`.
   Mixed-script lines (Urdu name + Latin phone) break a single `eng+urd`
   pass (RTL digit reordering), so the engine runs a **dual pass** —
   `eng` for Latin names, roll numbers and phones, `urd` for Urdu names —
   and merges per line (`mergeDualPass` in `ocr-engine.ts`; a line is
   treated as Urdu only if it contains a real two-word Urdu name, so the
   `urd` model's hallucinated letters on Latin lines can't corrupt rows).
   If the binary or a language is missing, the endpoint returns **503
   `OCR_UNAVAILABLE`** with install instructions — never a fabricated result.
   Optional AI-vision provider behind `OCR_PROVIDER=ai-vision` (off by default).
3. **Parse** — `parser.ts` (pure, unit-tested) extracts per line:
   `{name, name_ur?, roll_no?, parent_phone?, confidence, duplicate?}`.
   Phones are normalized to E.164 (`+92…`), hashed (SHA-256) for duplicate
   detection, and only ever returned masked (`+92 3XX XXXX678`).
   Duplicates are flagged against existing students in the class (same
   normalized name, same phone hash, or same roll number) and within the
   upload itself.
4. **Review** — `GET /api/v1/ocr-uploads/:id` returns `raw_text` + parsed rows
   (re-parsed fresh, so duplicate flags are always current).
5. **Confirm** — `POST /api/v1/classes/:id/ocr-upload/:upload_id/confirm`
   `{rows: [...]}` saves the admin-edited rows, skipping duplicates and
   invalid rows, and returns `{saved, skipped_duplicates, skipped}`.
   An `audit_logs` row (`ocr.confirm`) is written. Upload status → `saved`.

## Files

| File | What it does |
|---|---|
| `routes.ts` | Express router factory `createOcrRouter(deps)` + envelope/error mapping |
| `service.ts` | `OcrService` (upload/parse/review/confirm) + narrow `OcrDb` interface |
| `prisma-adapter.ts` | Maps a Prisma client onto `OcrDb` |
| `parser.ts` | Pure OCR-text → rows parser (roll-no, phone, Urdu-name extraction) |
| `phone.ts` | PK phone normalize / SHA-256 hash / mask / name normalize |
| `crypto.ts` | AES-256-GCM phone encryption (`PHONE_ENC_KEY`), format `iv:ct:tag` (base64) |
| `ocr-engine.ts` | Tesseract CLI runner + optional AI-vision provider |
| `index.ts` | Public exports |
| `tests/` | Unit tests (parser, phone, service) + E2E fixture test |
| `MOUNT.md` | Integration instructions for the Backend Agent |

## Install (server)

```bash
sudo apt-get update && sudo apt-get install -y tesseract-ocr tesseract-ocr-urd
tesseract --list-langs   # must list eng AND urd
```

macOS: `brew install tesseract tesseract-lang`.

## Env vars

`DATABASE_URL`, `PHONE_ENC_KEY` (32-byte base64, required),
`UPLOAD_DIR` (default `./uploads/ocr`), `OCR_PROVIDER` (`tesseract` default,
`ai-vision` optional), `OCR_LANGS` (default `eng+urd`),
`OCR_AI_VISION_URL` / `OCR_AI_VISION_KEY` (only for `ai-vision`).

Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

## How to test

```bash
# from this module's test sandbox (see tests/README in tests/ if present):
npm install        # typescript, tsx, express, multer (dev-only harness)
npm test           # unit tests: parser, phone, crypto, service, engine merge
npm run test:e2e   # generates the fixture image, runs real Tesseract on it,
                   # asserts names/phones extract (skips cleanly if no tesseract)
npx tsx smoke.ts   # boots Express + router (fake DB), uploads the fixture
                   # over HTTP with real Tesseract, reviews, confirms, and
                   # checks the duplicate guard (needs PHONE_ENC_KEY set)
```

Test fixture: `tests/fixtures/generate-fixture.py` (PIL) builds a sample
Class 5-A list — 8 English + 4 Urdu names, roll numbers, parent phones —
at `tests/fixtures/sample-list.png`.

## Security / privacy notes

- Full phone numbers are never returned or logged; only masked forms leave
  the module. Phones are stored AES-256-GCM encrypted + SHA-256 hashed.
- Uploads are tenant-scoped by `school_id` from the JWT (never client input).
- Only `admin` role may call these endpoints (enforced by the injected `auth`
  middleware — the Backend Agent wires role checks; this module requires the
  middleware to be passed in).
- Uploaded images are stored on disk, never served publicly.
