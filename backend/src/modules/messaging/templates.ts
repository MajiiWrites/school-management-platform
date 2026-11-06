/**
 * Message templates (SCHEMA.md message_templates).
 *
 * Variables (Section 11 — the v1 builder only rendered student_name / class
 * / date / school_name; the renderer now supports all eight):
 *   {student_name} {father_name} {class} {section} {date} {amount} {month}
 *   {school_name}
 * Templates are seeded EN + UR for the three v1 types (Database agent seeds
 * them; these defaults are the fallback if a school has no active template
 * row). The v2 types (result / announcement / custom) have built-in English
 * + Urdu fallbacks here too, so a school with no row for them still renders.
 * Urdu/Unicode is supported throughout — bodies are stored and sent as UTF-8.
 */

export type TemplateType =
  | 'absent'
  | 'fee_reminder'
  | 'teacher_reminder'
  | 'result'
  | 'announcement'
  | 'custom';
export type TemplateLanguage = 'en' | 'ur';

export const TEMPLATE_TYPES: TemplateType[] = [
  'absent',
  'fee_reminder',
  'teacher_reminder',
  'result',
  'announcement',
  'custom',
];

export const DEFAULT_TEMPLATES: Record<TemplateType, Record<TemplateLanguage, string>> = {
  absent: {
    en: 'Dear Parent, your child {student_name} (Class {class}) was marked ABSENT from school today ({date}). Please contact the school if needed. – {school_name}',
    ur: 'محترم والدین، آپ کا بچہ {student_name} (کلاس {class}) آج ({date}) اسکول سے غیر حاضر تھا۔ ضرورت ہو تو اسکول سے رابطہ کریں۔ – {school_name}',
  },
  fee_reminder: {
    en: 'Dear Parent, the fee of {student_name} (Class {class}) for {month} is due. Amount: {amount}. Please pay at the earliest. – {school_name}',
    ur: 'محترم والدین، {student_name} (کلاس {class}) کی {month} کی فیس واجب الادا ہے۔ رقم: {amount}۔ براہ کرم جلد از جلد ادا کریں۔ – {school_name}',
  },
  teacher_reminder: {
    en: 'Reminder: attendance for Class {class} has not been submitted today ({date}). Please submit it at the earliest. – {school_name}',
    ur: 'یاد دہانی: کلاس {class} کی حاضری آج ({date}) جمع نہیں ہوئی۔ براہ کرم جلد جمع کروائیں۔ – {school_name}',
  },
  result: {
    en: 'Dear Parent, the result of {student_name} (Class {class}) has been announced. Please contact the school for details. – {school_name}',
    ur: 'محترم والدین، {student_name} (کلاس {class}) کا نتیجہ جاری کر دیا گیا ہے۔ تفصیل کے لیے اسکول سے رابطہ کریں۔ – {school_name}',
  },
  announcement: {
    en: 'Dear Parent, an announcement from {school_name} ({date}): please contact the school for details.',
    ur: 'محترم والدین، {school_name} کی طرف سے اعلان ({date}): تفصیل کے لیے اسکول سے رابطہ کریں۔',
  },
  custom: {
    en: 'Dear Parent, a message from {school_name} about {student_name} (Class {class}) on {date}.',
    ur: 'محترم والدین، {school_name} کی طرف سے {student_name} (کلاس {class}) کے بارے میں پیغام ({date})۔',
  },
};

/**
 * All eight renderable variables (SCHEMA.md §11). `{class}` = class name
 * (e.g. '5'), `{section}` = section (e.g. 'A'); `{date}` = school-local
 * date; `{amount}` = PKR amount where applicable; `{month}` = YYYY-MM.
 * Callers pass only the variables they have — anything absent renders
 * literally (see renderTemplate), never crashes a send.
 */
export type TemplateVars = Partial<Record<
  | 'student_name'
  | 'father_name'
  | 'class'
  | 'section'
  | 'date'
  | 'month'
  | 'amount'
  | 'school_name',
  string
>>;

/** The eight variable names, for the composer chips + preview derivation. */
export const TEMPLATE_VARIABLES = [
  'student_name',
  'father_name',
  'class',
  'section',
  'date',
  'amount',
  'month',
  'school_name',
] as const;

/** Scan a body for `{...}` variables (derived "variables used" — SCHEMA.md §11). */
export function variablesUsed(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(/\{([a-z_]+)\}/g)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * Substitute {variables} in a template body. Unknown variables (or known
 * variables with no value in this context) are left untouched (so a bad
 * template is visible in review instead of silently sending a broken
 * message).
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    const value = (vars as Record<string, string | undefined>)[key];
    return value === undefined ? match : value;
  });
}

/** Character count for the admin UI counter (counts Unicode code points). */
export function templateCharCount(body: string): number {
  return [...body].length;
}

/* ------------------------------------------------------------------ */
/* SMS part counting (Section 11)                                      */
/*                                                                     */
/* GSM 03.38 7-bit alphabet: 160 chars in one SMS, 153 per part when   */
/* concatenated. Extension-table characters (^{}\[~]|€) cost 2        */
/* septets each. Anything outside GSM-7 (Urdu/Arabic script, emoji,    */
/* …) forces UCS-2: 70 chars in one SMS, 67 per part when              */
/* concatenated (length counted in UTF-16 code units, as UCS-2 does).  */
/* ------------------------------------------------------------------ */

/** GSM 03.38 default-alphabet characters (single-septet). */
const GSM_BASIC = new Set(
  [..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"],
);

/** GSM 03.38 extension-table characters (cost 2 septets each). */
const GSM_EXTENSION = new Set([...'^{}\\[~]|€']);

export interface SmsCount {
  /** True when the body needs UCS-2 (non-GSM characters present). */
  isUnicode: boolean;
  /** Billable length: septets for GSM, UTF-16 code units for UCS-2. */
  length: number;
  /** Chars in a single SMS (160 GSM / 70 UCS-2). */
  singleLimit: number;
  /** Chars per concatenated part (153 GSM / 67 UCS-2). */
  partLimit: number;
  /** Number of SMS parts the body will be sent as. */
  parts: number;
}

/** SMS segmentation for a rendered body. Pure function — no I/O. */
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
    // UCS-2: length is UTF-16 code units (astral chars = surrogate pair = 2).
    const length = body.length;
    const singleLimit = 70;
    const partLimit = 67;
    return {
      isUnicode: true,
      length,
      singleLimit,
      partLimit,
      parts: length === 0 ? 0 : length <= singleLimit ? 1 : Math.ceil(length / partLimit),
    };
  }
  const singleLimit = 160;
  const partLimit = 153;
  return {
    isUnicode: false,
    length: septets,
    singleLimit,
    partLimit,
    parts: septets === 0 ? 0 : septets <= singleLimit ? 1 : Math.ceil(septets / partLimit),
  };
}
