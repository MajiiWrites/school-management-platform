export { createOcrRouter, default } from './routes.js';
export { OcrService, OcrUnavailableError } from './service.js';
export { parseStudentList, parseLine, extractPhone, extractRollNo, extractUrduName } from './parser.js';
export type { ParsedRow, ExistingStudent } from './parser.js';
export { normalizePkPhone, hashPhone, maskPhone, normalizeName } from './phone.js';
export { encryptPhone, decryptPhone } from './crypto.js';
export { runOcr, runTesseract, runAiVision, mergeDualPass } from './ocr-engine.js';
export { prismaOcrDb } from './prisma-adapter.js';
export type { PrismaLike } from './prisma-adapter.js';
