// OCR engine: Tesseract CLI (primary) + optional AI-vision provider (off by default).
// Never fabricate a result: if no engine is available, throw OcrUnavailableError
// and the route returns 503 with install instructions.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

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

/** Run Tesseract CLI on an image file. `langs` e.g. "eng+urd". */
export async function runTesseract(
  filePath: string,
  langs = 'eng+urd',
  timeoutMs = 180_000,
): Promise<OcrResult> {
  const available = await tesseractLangs();
  if (available.length === 0) {
    throw new OcrUnavailableError('Tesseract OCR binary not found on this server.', TESSERACT_SETUP);
  }
  const warnings: string[] = [];
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
        execFileAsync('tesseract', [filePath, 'stdout', '--psm', '6', '-l', lang], {
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
    const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '--psm', '6', '-l', usable.join('+')], {
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
