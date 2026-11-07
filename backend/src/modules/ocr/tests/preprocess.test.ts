// Unit tests for image preprocessing helpers (ocr-engine.ts).
// Pure Buffer parsing — no Tesseract binary, no image library needed.
// Run: npx tsx --test tests/preprocess.test.ts  (from the tests/ harness dir)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJpegOrientation, orientationToDegrees } from '../ocr-engine.js';

/** Build a minimal JPEG carrying an EXIF orientation tag (value `orientation`). */
function jpegWithExif(orientation: number, littleEndian = true): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
  if (littleEndian) {
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8); // one IFD entry
    tiff.writeUInt16LE(0x0112, 10); // orientation tag
    tiff.writeUInt16LE(3, 12); // SHORT
    tiff.writeUInt32LE(1, 14); // count 1
    tiff.writeUInt16LE(orientation, 18); // value (entry value field = +8)
    tiff.writeUInt32LE(0, 22); // next IFD
  } else {
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    tiff.writeUInt32BE(0, 22);
  }
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(2 + 2 + exif.length);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exif.length + 2, 2);
  exif.copy(app1, 4);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

test('readJpegOrientation reads the EXIF tag (little- and big-endian)', () => {
  assert.equal(readJpegOrientation(jpegWithExif(1)), 1);
  assert.equal(readJpegOrientation(jpegWithExif(6)), 6);
  assert.equal(readJpegOrientation(jpegWithExif(8)), 8);
  assert.equal(readJpegOrientation(jpegWithExif(3, false)), 3);
  assert.equal(readJpegOrientation(jpegWithExif(6, false)), 6);
});

test('readJpegOrientation returns null without EXIF / for non-JPEGs', () => {
  assert.equal(readJpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null); // bare JPEG
  assert.equal(readJpegOrientation(Buffer.from('not an image at all')), null);
  assert.equal(readJpegOrientation(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null); // PNG magic
  assert.equal(readJpegOrientation(Buffer.alloc(0)), null);
});

test('orientationToDegrees maps EXIF values to rotation', () => {
  assert.equal(orientationToDegrees(1), 0);
  assert.equal(orientationToDegrees(null), 0);
  assert.equal(orientationToDegrees(3), 180);
  assert.equal(orientationToDegrees(6), 90);
  assert.equal(orientationToDegrees(8), 270);
});

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { detectOrientation, preprocessImage } from '../ocr-engine.js';

async function tmpPng(width: number, height: number): Promise<string> {
  const p = join(tmpdir(), `smp-prep-test-${randomUUID()}.png`);
  await sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toFile(p);
  return p;
}

test('preprocessImage returns a readable grayscale image with applied steps', async () => {
  const src = await tmpPng(120, 40);
  try {
    const res = await preprocessImage(src);
    try {
      assert.equal(res.skipped, false);
      assert.ok(res.applied.includes('grayscale'));
      assert.ok(res.applied.includes('contrast'));
      const meta = await sharp(res.path).metadata();
      assert.equal(meta.width, 120);
      assert.equal(meta.height, 40);
    } finally {
      await res.cleanup();
    }
  } finally {
    await unlink(src).catch(() => {});
  }
});

test('preprocessImage auto-rotates an EXIF-6 JPEG upright (dimensions swap)', async () => {
  // 60x30 stored pixels, EXIF orientation 6 (rotate 90° clockwise to view).
  const jpeg = await sharp({ create: { width: 60, height: 30, channels: 3, background: { r: 200, g: 200, b: 200 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const src = join(tmpdir(), `smp-prep-test-${randomUUID()}.jpg`);
  await writeFile(src, jpeg);
  try {
    const res = await preprocessImage(src);
    try {
      assert.equal(res.skipped, false);
      assert.ok(res.applied.includes('exif-rotate'));
      const meta = await sharp(res.path).metadata();
      assert.equal(meta.width, 30);
      assert.equal(meta.height, 60);
    } finally {
      await res.cleanup();
    }
  } finally {
    await unlink(src).catch(() => {});
  }
});

test('preprocessImage falls back to the original file for non-images', async () => {
  const src = join(tmpdir(), `smp-prep-test-${randomUUID()}.txt`);
  await writeFile(src, 'not an image at all');
  try {
    const res = await preprocessImage(src);
    assert.equal(res.skipped, true);
    assert.equal(res.path, src);
    await res.cleanup();
  } finally {
    await unlink(src).catch(() => {});
  }
});

test('preprocessImage OSD-deskews a 90°-rotated text image back to 0°', async () => {
  const lines = ['HELLO WORLD', 'STUDENT LIST', 'CLASS FIVE A', 'AHMED RAZA', 'BILAL KHAN', 'CHANDNI BIBI'];
  const svg =
    `<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="400" fill="white"/>` +
    lines.map((l, i) => `<text x="20" y="${60 + i * 55}" font-family="sans-serif" font-size="40" fill="black">${l}</text>`).join('') +
    `</svg>`;
  const upright = await sharp(Buffer.from(svg)).png().toBuffer();
  const sideways = await sharp(upright).rotate(90).png().toBuffer();
  const src = join(tmpdir(), `smp-prep-test-${randomUUID()}.png`);
  await writeFile(src, sideways);
  try {
    const before = await detectOrientation(src);
    assert.ok(before && before.degrees !== 0, `expected rotated input, got ${JSON.stringify(before)}`);
    const res = await preprocessImage(src);
    try {
      assert.equal(res.skipped, false);
      const after = await detectOrientation(res.path);
      assert.ok(after && after.degrees === 0, `expected 0° after deskew, got ${JSON.stringify(after)}`);
    } finally {
      await res.cleanup();
    }
  } finally {
    await unlink(src).catch(() => {});
  }
});
