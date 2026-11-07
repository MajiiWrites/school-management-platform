// OCR engine: Tesseract CLI (primary) + optional AI-vision provider (off by default).
// Never fabricate a result: if no engine is available, throw OcrUnavailableError
// and the route returns 503 with install instructions.
import { execFile } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

export class OcrUnavailableError extends Error {
  readonly setup: string;
  constructor(message: string, setup: string) {
    super(message);
    this.name = 'OcrUnavailableError';
    this.setup = setup;
  }
}

export const TESSERACT_SETUP =
  'Tesseract OCR is not installed or the Urdu trained data is missing. ' +
  'Install it on the server: `sudo apt-get update && sudo apt-get install -y tesseract-ocr tesseract-ocr-urd` ' +
  '(or `brew install tesseract tesseract-lang` on macOS), then verify with `tesseract --list-langs` — ' +
  'both `eng` and `urd` must be listed. Set OCR_LANGS to override the language list.';

export interface OcrResult {
  raw_text: string;
  engine: 'tesseract' | 'ai-vision';
  langs: string;
  warnings: string[];
}

// Arabic letters ONLY (not digits/punctuation) — distinguishes a real Urdu
// name from the digit-garbage Tesseract's `urd` model emits on Latin lines.
// NOTE: Extended Arabic-Indic digits U+06F0–U+06F9 are deliberately excluded.
const URDU_LETTER = '\\u0621-\\u064A\\u066E\\u066F\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06BE\\u06C1\\u06CC\\u06D2\\u06D3\\u06FA-\\u06FC';
const URDU_LETTER_RE = new RegExp(`[${URDU_LETTER}]`);
const URDU_RUN_RE = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+(?:\s+[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+)*/g;
const PHONE_RE = /(\+?92[\s-]?|0)?3\d{2}[\s-]?\d{7}/;
const ROLL_PREFIX_RE = /^\s*(\d{1,3})\s*[.)\-–:]/;

/**
 * Merge two single-language Tesseract passes into one text.
 *
 * Why two passes: on a mixed-script line (Urdu name + Latin phone number)
 * a single `eng+urd` pass mangles the phone digits (RTL reordering), while
 * the `eng` pass reads phones/roll numbers perfectly but garbles Urdu names
 * and the `urd` pass reads Urdu names but garbles phones. Merging per line
 * takes the best of each: roll + phone from the eng pass, the Urdu name
 * from the urd pass. Lines are aligned by index — both passes produce the
 * same line structure for the same image.
 */
export function mergeDualPass(engText: string, urdText: string): string {
  const engLines = engText.split(/\r?\n/);
  const urdLines = urdText.split(/\r?\n/);
  const n = Math.max(engLines.length, urdLines.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const engLine = engLines[i] ?? '';
    const urdLine = urdLines[i] ?? '';
    // An Urdu row needs a REAL Urdu name, not model hallucination. The `urd`
    // model emits isolated letters ("ا", "ھ") and digit-letter mixes
    // ("۲٦٥٦کنا") on Latin lines, so a single letter-run is not enough.
    // Rule (validated against real Tesseract 5.3.4 output): the line must
    // contain >= 6 Urdu letters AND >= 2 letter-runs of >= 3 letters
    // (i.e. a two-word name like "احمد رضا"). Single-word names fall back
    // to the eng line — the phone still extracts and the admin fixes the
    // name on the review screen.
    const letterRuns = (urdLine.match(new RegExp(`[${URDU_LETTER}]+`, 'g')) ?? []);
    const letterCount = letterRuns.reduce((n, r) => n + r.length, 0);
    const longRuns = letterRuns.filter((r) => r.length >= 3).length;
    const hasUrduWord = letterCount >= 6 && longRuns >= 2;
    if (!hasUrduWord) {
      out.push(engLine);
      continue;
    }
    const urduRuns = (urdLine.match(URDU_RUN_RE) ?? []).filter((r) => URDU_LETTER_RE.test(r));
    // Urdu row: rebuild a clean line — roll + Urdu name + phone.
    const roll = engLine.match(ROLL_PREFIX_RE)?.[1];
    const phone = engLine.match(PHONE_RE)?.[0];
    const parts = [roll ? `${roll}.` : null, urduRuns.join(' '), phone ?? null].filter(Boolean);
    out.push(parts.join(' '));
  }
  return out.join('\n');
}

async function tesseractLangs(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('tesseract', ['--list-langs'], { timeout: 10_000 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface OcrWord {
  text: string;
  /** Tesseract word confidence 0..100 (-1 = no word, e.g. punctuation-only). */
  conf: number;
  left: number;
  top: number;
  width: number;
  height: number;
  line: number;
}

/**
 * EXIF orientation (JPEG APP1) read with stdlib Buffer parsing only.
 * Phone photos are usually stored un-rotated with an EXIF orientation tag
 * (6 = rotate 90° CW, 8 = 90° CCW, 3 = 180°); Tesseract reads raw pixels
 * and does NOT apply the tag, so such photos OCR sideways. Returns the raw
 * EXIF orientation value (1 = normal), or null when there is no EXIF tag.
 */
export function readJpegOrientation(buf: Buffer): number | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1]!;
    const len = buf.readUInt16BE(off + 2);
    if (len < 2 || off + 2 + len > buf.length) return null;
    if (marker === 0xe1) {
      const seg = buf.subarray(off + 4, off + 2 + len);
      if (seg.length < 6 || seg.toString('ascii', 0, 6) !== 'Exif\0\0') return null;
      return readTiffOrientation(seg.subarray(6));
    }
    if (marker === 0xda || marker === 0xd9) return null; // start-of-scan / end-of-image
    off += 2 + len;
  }
  return null;
}

function readTiffOrientation(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const le = tiff.toString('ascii', 0, 2) === 'II';
  if (tiff.toString('ascii', 0, 2) !== 'II' && tiff.toString('ascii', 0, 2) !== 'MM') return null;
  const u16 = (o: number): number => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number): number => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifdOff = u32(4);
  if (ifdOff + 2 > tiff.length) return null;
  const count = u16(ifdOff);
  for (let i = 0; i < count; i++) {
    const e = ifdOff + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (u16(e) === 0x0112) return u16(e + 8); // orientation tag, SHORT value inline
  }
  return null;
}

/** EXIF orientation value -> rotation the pixels need (degrees clockwise). */
export function orientationToDegrees(orientation: number | null): number {
  if (orientation === 3) return 180;
  if (orientation === 6) return 90;
  if (orientation === 8) return 270;
  return 0; // 1 = normal; 2/4/5/7 are mirrors (no pure rotation fixes them)
}

/**
 * Detect the page orientation with Tesseract's OSD (`--psm 0 -l osd`).
 * Best-effort: returns null when OSD data is unavailable. Never throws.
 */
export async function detectOrientation(filePath: string): Promise<{ degrees: number; confidence: number } | null> {
  try {
    const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '--psm', '0', '-l', 'osd'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const deg = stdout.match(/Orientation in degrees:\s*(\d+)/);
    const conf = stdout.match(/Orientation confidence:\s*([\d.]+)/);
    if (!deg) return null;
    return { degrees: parseInt(deg[1]!, 10), confidence: conf ? parseFloat(conf[1]!) : 0 };
  } catch {
    return null;
  }
}

export interface PreprocessResult {
  /** Path to the image Tesseract should read (a temp file, or the original). */
  path: string;
  /** Steps actually applied, e.g. ['exif-rotate', 'osd-deskew:90', 'grayscale', 'contrast']. */
  applied: string[];
  /** True when preprocessing failed and the original file is used as-is. */
  skipped: boolean;
  /** Delete any temp files created. Safe to call repeatedly. */
  cleanup: () => Promise<void>;
}

/**
 * Preprocess an uploaded photo for OCR with sharp:
 * EXIF auto-rotate, OSD-based orientation correction (deskew for 90° steps),
 * grayscale + contrast normalisation, width capped at 3000px.
 * NEVER throws and NEVER fails the upload: on any error the original file
 * is returned with skipped: true and OCR runs on it unmodified.
 */
export async function preprocessImage(filePath: string): Promise<PreprocessResult> {
  const noop = async (): Promise<void> => {};
  try {
    const tmpFiles: string[] = [];
    const cleanup = async (): Promise<void> => {
      for (const f of tmpFiles) {
        try {
          await unlink(f);
        } catch {
          /* already gone */
        }
      }
    };
    const applied: string[] = [];
    // 1. EXIF auto-rotate (sharp .rotate() reads the Orientation tag).
    let buf = await sharp(filePath).rotate().toBuffer();
    try {
      const raw = await readFile(filePath);
      const o = readJpegOrientation(raw);
      if (o !== null && o !== 1 && orientationToDegrees(o) !== 0) applied.push('exif-rotate');
    } catch {
      /* orientation read is best-effort */
    }
    // 2. OSD orientation correction (deskew): write the rotated image to a
    // temp file, ask Tesseract OSD for its orientation, rotate back if needed.
    const tmp1 = join(tmpdir(), `smp-ocr-${randomUUID()}.png`);
    await writeFile(tmp1, buf);
    tmpFiles.push(tmp1);
    const osd = await detectOrientation(tmp1);
    if (osd && osd.degrees !== 0 && osd.confidence >= 1) {
      const correction = (360 - osd.degrees) % 360;
      if (correction !== 0) {
        buf = await sharp(buf).rotate(correction).toBuffer();
        applied.push(`osd-deskew:${osd.degrees}`);
      }
    }
    // 3. Grayscale + contrast stretch + width cap, as PNG for Tesseract.
    const out = join(tmpdir(), `smp-ocr-${randomUUID()}.png`);
    await sharp(buf).resize({ width: 3000, withoutEnlargement: true }).greyscale().normalise().png().toFile(out);
    tmpFiles.push(out);
    applied.push('grayscale', 'contrast');
    return { path: out, applied, skipped: false, cleanup };
  } catch {
    return { path: filePath, applied: [], skipped: true, cleanup: noop };
  }
}

/**
 * Inspect an uploaded image for rotation problems BEFORE OCR runs.
 * Returns human-readable warnings; never throws (a failed inspection must
 * not block the upload).
 *
 * Rotation itself is fixed by preprocessImage (EXIF auto-rotate + OSD
 * deskew), so only mirrored EXIF orientations (2/4/5/7 — no pure rotation
 * fixes them) still warn here.
 */
export async function inspectImage(filePath: string): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const buf = await readFile(filePath);
    const orientation = readJpegOrientation(buf);
    // Mirrored EXIF orientations (2/4/5/7) cannot be fixed by rotation —
    // warn the admin. Plain rotations (3/6/8) are auto-corrected by
    // preprocessImage, so they need no warning.
    if (orientation !== null && orientation !== 1 && orientationToDegrees(orientation) === 0) {
      warnings.push(
        `This photo has a mirrored EXIF orientation (${orientation}) — it may read incorrectly. Re-take it upright if names look wrong.`,
      );
    }
  } catch {
    // unreadable file — OCR below will surface the real error.
  }
  return warnings;
}

/** Run Tesseract TSV output: one row per word, with bounding boxes + confidence. Preprocesses the image first (rotate/deskew/contrast). */
export async function runTesseractTsv(
  filePath: string,
  langs = 'eng+urd',
  psm = '6',
  timeoutMs = 180_000,
): Promise<OcrWord[]> {
  const prep = await preprocessImage(filePath);
  try {
    return await runTesseractTsvOnFile(prep.path, langs, psm, timeoutMs);
  } finally {
    await prep.cleanup();
  }
}

async function runTesseractTsvOnFile(
  filePath: string,
  langs = 'eng+urd',
  psm = '6',
  timeoutMs = 180_000,
): Promise<OcrWord[]> {
  const available = await tesseractLangs();
  if (available.length === 0) {
    throw new OcrUnavailableError('Tesseract OCR binary not found on this server.', TESSERACT_SETUP);
  }
  const requested = langs.split('+').map((l) => l.trim()).filter(Boolean);
  const usable = requested.filter((l) => available.includes(l));
  if (usable.length === 0) {
    throw new OcrUnavailableError(
      `No requested Tesseract languages available (${langs}). Installed: ${available.join(', ') || 'none'}.`,
      TESSERACT_SETUP,
    );
  }
  const { stdout } = await execFileAsync(
    'tesseract',
    [filePath, 'stdout', '--psm', psm, '-l', usable.join('+'), 'tsv'],
    { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
  );
  const lines = stdout.split(/\r?\n/);
  const words: OcrWord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const cols = line.split('\t');
    // level page block par line word left top width height conf text
    if (cols.length < 12) continue;
    if (cols[0] !== '5') continue; // word level only
    const text = (cols[11] ?? '').trim();
    if (!text) continue;
    words.push({
      text,
      conf: Number(cols[10] ?? -1),
      left: Number(cols[6] ?? 0),
      top: Number(cols[7] ?? 0),
      width: Number(cols[8] ?? 0),
      height: Number(cols[9] ?? 0),
      line: Number(cols[4] ?? 0),
    });
  }
  return words;
}

/** Run Tesseract CLI on an image file. `langs` e.g. "eng+urd". Preprocesses the image first (rotate/deskew/contrast); falls back to the original on any preprocessing failure. */
export async function runTesseract(
  filePath: string,
  langs = 'eng+urd',
  timeoutMs = 180_000,
  psm = '6',
): Promise<OcrResult> {
  const prep = await preprocessImage(filePath);
  try {
    return await runTesseractOnFile(prep.path, langs, timeoutMs, psm, prep);
  } finally {
    await prep.cleanup();
  }
}

async function runTesseractOnFile(
  filePath: string,
  langs: string,
  timeoutMs: number,
  psm: string,
  prep: PreprocessResult,
): Promise<OcrResult> {
  const available = await tesseractLangs();
  if (available.length === 0) {
    throw new OcrUnavailableError('Tesseract OCR binary not found on this server.', TESSERACT_SETUP);
  }
  const warnings: string[] = [];
  if (prep.skipped) {
    warnings.push('Image preprocessing was skipped (unreadable image?) — OCR ran on the original file.');
  } else if (prep.applied.length > 0) {
    warnings.push(`Image preprocessed for OCR: ${prep.applied.join(', ')}.`);
  }
  const requested = langs.split('+').map((l) => l.trim()).filter(Boolean);
  const usable = requested.filter((l) => available.includes(l));
  const missing = requested.filter((l) => !available.includes(l));
  if (missing.length > 0) {
    warnings.push(`Trained data missing for: ${missing.join(', ')} — continuing with ${usable.join('+') || 'none'}.`);
  }
  if (usable.length === 0) {
    throw new OcrUnavailableError(
      `No requested Tesseract languages available (${langs}). Installed: ${available.join(', ') || 'none'}.`,
      TESSERACT_SETUP,
    );
  }
  try {
    // Dual-pass for mixed English+Urdu lists: `eng` reads Latin names,
    // roll numbers and phones; `urd` reads Urdu names. Merge per line
    // (see mergeDualPass). A single `eng+urd` pass mangles phone digits
    // on mixed-script lines (RTL reordering), so it is not used.
    if (usable.includes('eng') && usable.includes('urd')) {
      const run = (lang: string) =>
        execFileAsync('tesseract', [filePath, 'stdout', '--psm', psm, '-l', lang], {
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });
      // Sequential, not parallel: two Tesseract instances thrash the CPU
      // (the `urd` model is slow on large photos) and can time out.
      const eng = await run('eng');
      const urd = await run('urd');
      return {
        raw_text: mergeDualPass(eng.stdout, urd.stdout),
        engine: 'tesseract',
        langs: usable.join('+'),
        warnings: [...warnings, 'Dual-pass OCR (eng + urd merged per line) for mixed-script lists.'],
      };
    }
    const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '--psm', psm, '-l', usable.join('+')], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { raw_text: stdout, engine: 'tesseract', langs: usable.join('+'), warnings };
  } catch (err: unknown) {
    const e = err as { code?: string; killed?: boolean; message?: string };
    if (e.code === 'ENOENT') {
      throw new OcrUnavailableError('Tesseract OCR binary not found on this server.', TESSERACT_SETUP);
    }
    throw new Error(`Tesseract failed: ${e.message ?? String(err)}`);
  }
}

/**
 * Optional AI-vision provider (OCR_PROVIDER=ai-vision). Generic HTTP endpoint:
 * POST {OCR_AI_VISION_URL} with {image_base64}, Authorization: Bearer {OCR_AI_VISION_KEY},
 * expects JSON {text: string}. Off by default; NOT required for the platform.
 */
export async function runAiVision(filePath: string): Promise<OcrResult> {
  const url = process.env.OCR_AI_VISION_URL;
  const key = process.env.OCR_AI_VISION_KEY;
  if (!url || !key) {
    throw new OcrUnavailableError(
      'AI-vision provider selected (OCR_PROVIDER=ai-vision) but OCR_AI_VISION_URL / OCR_AI_VISION_KEY are not set.',
      'Set OCR_PROVIDER=tesseract (default), or configure OCR_AI_VISION_URL and OCR_AI_VISION_KEY for an AI-vision endpoint that accepts {image_base64} and returns {text}.',
    );
  }
  const buf = await readFile(filePath);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ image_base64: buf.toString('base64') }),
  });
  if (!res.ok) throw new Error(`AI-vision provider returned HTTP ${res.status}`);
  const body = (await res.json()) as { text?: string };
  if (typeof body.text !== 'string') throw new Error('AI-vision provider returned no `text` field.');
  return { raw_text: body.text, engine: 'ai-vision', langs: 'n/a', warnings: [] };
}

/** Dispatch to the configured provider. Default: tesseract. */
export async function runOcr(
  filePath: string,
  opts: { provider?: string; langs?: string; timeoutMs?: number } = {},
): Promise<OcrResult> {
  const provider = opts.provider ?? process.env.OCR_PROVIDER ?? 'tesseract';
  if (provider === 'ai-vision') return runAiVision(filePath);
  if (provider === 'tesseract') {
    return runTesseract(filePath, opts.langs ?? process.env.OCR_LANGS ?? 'eng+urd', opts.timeoutMs);
  }
  throw new OcrUnavailableError(
    `Unknown OCR provider "${provider}".`,
    'Set OCR_PROVIDER to "tesseract" (default) or "ai-vision".',
  );
}
