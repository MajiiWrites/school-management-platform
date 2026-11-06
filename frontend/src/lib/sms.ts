// SMS part counting for the composer live counter.
// Mirrors backend/src/modules/messaging/templates.ts smsPartCount exactly:
// GSM 03.38 7-bit: 160 chars in one SMS, 153 per concatenated part;
// extension-table chars (^{}\[~]|€) cost 2 septets. Anything outside GSM-7
// (Urdu/Arabic, emoji, …) forces UCS-2: 70 in one SMS, 67 per part
// (length in UTF-16 code units).

const GSM_BASIC = new Set(
  [..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"],
);

const GSM_EXTENSION = new Set([...'^{}\\[~]|€']);

export interface SmsCount {
  isUnicode: boolean;
  length: number;
  singleLimit: number;
  partLimit: number;
  parts: number;
}

export function smsPartCount(body: string): SmsCount {
  let isUnicode = false;
  let septets = 0;
  for (const ch of body) {
    if (GSM_BASIC.has(ch)) {
      septets += 1;
    } else if (GSM_EXTENSION.has(ch)) {
      septets += 2;
    } else {
      isUnicode = true;
      break;
    }
  }
  if (isUnicode) {
    const length = body.length;
    return {
      isUnicode: true,
      length,
      singleLimit: 70,
      partLimit: 67,
      parts: length === 0 ? 0 : length <= 70 ? 1 : Math.ceil(length / 67),
    };
  }
  return {
    isUnicode: false,
    length: septets,
    singleLimit: 160,
    partLimit: 153,
    parts: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
  };
}
