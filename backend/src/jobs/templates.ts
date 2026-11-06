// Tiny template renderer for SMS bodies.
// Variables: {student_name} {class} {date} {month} {amount} {school_name}.
// Unknown variables are left untouched and reported in `missing` so a bad
// template is visible instead of silently sending "{amount}" to a parent.

export interface RenderResult {
  body: string;
  missing: string[];
}

export function renderTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): RenderResult {
  const missing: string[] = [];
  const body = template.replace(/\{([a-z_]+)\}/gi, (match, key: string) => {
    const value = vars[key];
    if (value === null || value === undefined || value === '') {
      if (!missing.includes(key)) missing.push(key);
      return match;
    }
    return String(value);
  });
  return { body, missing };
}
