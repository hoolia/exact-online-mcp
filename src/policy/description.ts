export const DESCRIPTION_PARTS = ['supplier', 'period', 'ref', 'short'] as const;
export type DescriptionPart = (typeof DESCRIPTION_PARTS)[number];
export type DescriptionParts = Record<DescriptionPart, string>;

export const DEFAULT_DESCRIPTION_TEMPLATE = '{supplier}|{period}|{ref}|{short}';

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$/;
const MIN_SHORT = 3;
const MIN_SUPPLIER = 8;

export class DescriptionError extends Error {
  constructor(message: string) { super(message); this.name = 'DescriptionError'; }
}

/** Rejects a template with an unknown placeholder or without the parts that identify an entry. */
export function checkTemplate(template: string): void {
  const used = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const unknown = used.filter((p) => !(DESCRIPTION_PARTS as readonly string[]).includes(p));
  if (unknown.length) throw new DescriptionError(`unknown placeholder(s) ${unknown.map((p) => `{${p}}`).join(', ')}`);
  for (const p of ['supplier', 'ref'] as const) if (!used.includes(p)) throw new DescriptionError(`must contain {${p}}`);
}

/** Literal characters of the template outside placeholders, e.g. "|"; a part must not contain them. */
const separators = (template: string) => new Set(template.replace(PLACEHOLDER, '').split('').filter((c) => c.trim()));

/**
 * Renders the entry description from caller-supplied parts. Parts are trimmed, must be non-empty, must not
 * contain a template separator or control character, and the period is YYYY, YYYY-MM or YYYY-Qn. When the
 * result is longer than maxLength the short text, then the supplier, is shortened; the reference never is.
 */
export function renderDescription(template: string, input: DescriptionParts, maxLength = 60): string {
  const seps = separators(template);
  const parts = {} as DescriptionParts;
  for (const k of DESCRIPTION_PARTS) {
    const v = String(input[k] ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!v) throw new DescriptionError(`description part ${k} is empty`);
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new DescriptionError(`description part ${k} contains a control character`);
    const bad = [...seps].find((c) => v.includes(c));
    if (bad) throw new DescriptionError(`description part ${k} must not contain "${bad}"`);
    parts[k] = v;
  }
  if (!PERIOD.test(parts.period)) throw new DescriptionError('description part period must be YYYY, YYYY-MM or YYYY-Qn');
  const render = (p: DescriptionParts) => template.replace(PLACEHOLDER, (_m, k: DescriptionPart) => p[k]);
  let out = render(parts);
  const over = () => out.length - maxLength;
  if (over() > 0 && parts.short.length > MIN_SHORT) {
    parts.short = parts.short.slice(0, Math.max(MIN_SHORT, parts.short.length - over())).trimEnd();
    out = render(parts);
  }
  if (over() > 0 && parts.supplier.length > MIN_SUPPLIER) {
    parts.supplier = parts.supplier.slice(0, Math.max(MIN_SUPPLIER, parts.supplier.length - over())).trimEnd();
    out = render(parts);
  }
  if (over() > 0) throw new DescriptionError(`description is ${out.length} characters, the maximum is ${maxLength}; shorten the reference`);
  return out;
}
