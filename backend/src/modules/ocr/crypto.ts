// Phone encryption — INTEGRATION (Phase 3): this module used to carry its own
// AES-256-GCM implementation with a DIFFERENT wire format
// (base64(iv):base64(ciphertext):base64(authTag)) from the canonical
// src/lib/crypto.ts (base64(iv||tag||ciphertext)). The canonical format is
// what the seed data and every other module use, so seeded parent numbers
// only decrypt under the canonical format. This file now re-exports the
// canonical implementation; nothing else changes for callers.
export { encryptPhone, decryptPhone } from '../../lib/crypto.js';
