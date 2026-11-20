/**
 * WhatsApp delivery links (Messaging Center, 2026-11-20).
 *
 * The website cannot send WhatsApp messages itself — WhatsApp has no free
 * server-side send API. What the website CAN do, for free, is build a
 * wa.me click-to-send link with the message pre-filled: the admin taps it,
 * WhatsApp (Web or the app) opens with the exact text, and one tap in
 * WhatsApp sends it. That is the default delivery channel now — no
 * companion app, no paid gateway.
 *
 * HONESTY RULE: opening a wa.me link is recorded as "opened in WhatsApp",
 * never as "delivered". The site cannot confirm WhatsApp delivery, so no
 * code path may mark a WhatsApp message 'delivered' — see
 * recordWhatsAppOpened() in service.ts.
 *
 * Phone format: wa.me takes the international number WITHOUT '+' and
 * without spaces/dashes, e.g. 923001234567. Only validated Pakistani
 * numbers are linked (isValidPK) — an invalid number yields null so the
 * UI can show "no valid number" instead of a broken link.
 */
import { isValidPK, normalizePK } from './phone';

/** E.164 (+923001234567) → wa.me digits (923001234567). Null when invalid. */
export function toWaNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e164 = normalizePK(raw);
  if (!e164 || !isValidPK(e164)) return null;
  return e164.replace(/^\+/, '').replace(/\D/g, '');
}

/**
 * Build a wa.me click-to-send link. The body is URL-encoded with
 * encodeURIComponent, so Urdu text, line breaks and punctuation survive
 * intact. Returns null when the phone is invalid or the body is empty.
 */
export function waLink(phone: string | null | undefined, body: string | null | undefined): string | null {
  const digits = toWaNumber(phone);
  if (!digits) return null;
  if (!body || !body.trim()) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(body)}`;
}
