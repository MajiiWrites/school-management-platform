# MOUNT.md — how the Backend Agent wires the OCR module into app.ts

> OCR Agent owns ONLY `backend/src/modules/ocr/`. Do not edit this module
> without coordinating with the OCR Agent. This note is the integration contract.

## 1. Install dependencies (backend package.json)

```bash
npm i express multer@^2.0.0
npm i -D @types/express @types/multer
# @prisma/client already required by the backend; this module uses it via prisma-adapter.ts
```

## 2. Mount the router (in `src/app.ts`, Backend Agent only)

```ts
import { createOcrRouter, prismaOcrDb } from './modules/ocr/index.js';
import { prisma } from './lib/prisma.js';          // however the backend exposes the client
import { requireAuth } from './middleware/auth.js'; // sets req.schoolId + req.user

app.use('/api/v1', createOcrRouter({
  db: prismaOcrDb(prisma),
  auth: requireAuth,                 // JWT + tenant middleware
  uploadDir: process.env.UPLOAD_DIR, // optional; default ./uploads/ocr
  // encryptPhone: optional override — defaults to this module's AES-256-GCM
  // implementation (crypto.ts). If backend lib/crypto.ts exists, pass it here;
  // it MUST use the identical format: base64(iv):base64(ct):base64(tag).
}));
```

The router registers exactly these endpoints (contracts/API.md):

- `POST /api/v1/classes/:id/ocr-upload` (multipart `image`)
- `GET  /api/v1/ocr-uploads/:id`
- `POST /api/v1/classes/:id/ocr-upload/:upload_id/confirm` (`{rows: [...]}`)

## 3. Env vars required

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Prisma / PostgreSQL (Database Agent) |
| `PHONE_ENC_KEY` | 32-byte base64 key for AES-256-GCM phone encryption. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `UPLOAD_DIR` | Where uploaded list photos are stored (default `./uploads/ocr`). Must be writable and persistent; back it up with the DB. |
| `OCR_PROVIDER` | `tesseract` (default) or `ai-vision` (optional, off by default) |
| `OCR_LANGS` | Tesseract langs, default `eng+urd` |
| `OCR_AI_VISION_URL` / `OCR_AI_VISION_KEY` | Only when `OCR_PROVIDER=ai-vision` |

## 4. Server setup (DevOps)

```bash
sudo apt-get update && sudo apt-get install -y tesseract-ocr tesseract-ocr-urd
tesseract --list-langs   # must list eng AND urd
```

If tesseract is absent, `POST .../ocr-upload` returns **503 `OCR_UNAVAILABLE`**
with install instructions in the response — the module never returns a fake
OCR result.

## 5. Known integration notes

- **Phone encryption format** is `base64(iv):base64(ciphertext):base64(authTag)`
  (AES-256-GCM). Backend `lib/crypto.ts` must use the same format, or pass
  its encryptor as `encryptPhone` above.
- **Duplicate rule** (SCHEMA.md): same normalized name in the class OR same
  phone hash OR same roll number → flagged on review, skipped on confirm.
  The DB also enforces `UNIQUE (class_id, roll_no)`.
- **Phone numbers are never returned in full** — only `parent_phone_masked`
  (`+92 3XX XXXX678`) leaves this module.
- The module writes `audit_logs` rows on confirm (`action: ocr.confirm`).
- Uploads are stored on disk under `UPLOAD_DIR`; `ocr_uploads.file_path`
  records the path. Do not serve this directory publicly.
