/**
 * Message templates (SCHEMA.md message_templates).
 *
 * Variables: {student_name} {class} {date} {month} {amount} {school_name}
 * Templates are seeded EN + UR for all three types (Database agent seeds them;
 * these defaults are the fallback if a school has no active template row).
 * Urdu/Unicode is supported throughout — bodies are stored and sent as UTF-8.
 */

export type TemplateType = 'absent' | 'fee_reminder' | 'teacher_reminder';
export type TemplateLanguage = 'en' | 'ur';

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
};

export type TemplateVars = Partial<Record<
  'student_name' | 'class' | 'date' | 'month' | 'amount' | 'school_name',
  string
>>;

/**
 * Substitute {variables} in a template body. Unknown variables are left
 * untouched (so a bad template is visible in review instead of silently
 * sending a broken message).
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
