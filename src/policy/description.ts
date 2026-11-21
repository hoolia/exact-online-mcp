export const DESCRIPTION_PARTS = ['date', 'supplier', 'period', 'ref', 'short'] as const;
export type DescriptionPart = (typeof DESCRIPTION_PARTS)[number];
export type DescriptionParts = Record<DescriptionPart, string>;

export const DEFAULT_DESCRIPTION_TEMPLATE = '{date} {supplier} - {short} {period}';

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MIN_SHORT = 3;
const MIN_SUPPLIER = 8;

export class DescriptionError extends Error {
  constructor(message: string) { super(message); this.name = 'DescriptionError'; }
}

const placeholders = (template: string) => [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);

/** Rejects a template with an unknown placeholder, without {supplier}, or without {ref} or {date} to tell entries apart. */
export function checkTemplate(template: string): void {
  const used = placeholders(template);
  const unknown = used.filter((p) => !(DESCRIPTION_PARTS as readonly string[]).includes(p));
  if (unknown.length) throw new DescriptionError(`unknown placeholder(s) ${unknown.map((p) => `{${p}}`).join(', ')}`);
  if (!used.includes('supplier')) throw new DescriptionError('must contain {supplier}');
  if (!used.includes('ref') && !used.includes('date')) throw new DescriptionError('must contain {ref} or {date}');
}

/**
 * Literal text between placeholders that is more than whitespace, e.g. "|" or " - "; a part must not contain it.
 * A separator of spaces alone is not checked, so a name with spaces or a hyphen stays valid.
 */
const separators = (template: string) =>
  new Set(template.split(PLACEHOLDER).filter((_s, i) => i % 2 === 0).filter((s) => s.trim()).map((s) => s.replace(/\s+/g, ' ')));

/**
 * Renders the entry description from the parts. Parts are trimmed, must be non-empty, must not contain a
 * template separator or control character; the period is YYYY, YYYY-MM or YYYY-Qn and the date YYYY-MM-DD.
 * Only parts the template uses are checked. When the result is longer than maxLength the short text, then
 * the supplier, is shortened; the reference and the date never are.
 */
export function renderDescription(template: string, input: DescriptionParts, maxLength = 60): string {
  const seps = separators(template);
  const used = new Set(placeholders(template));
  const parts = {} as DescriptionParts;
  for (const k of DESCRIPTION_PARTS) {
    const v = String(input[k] ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    parts[k] = v;
    if (!used.has(k)) continue;
    if (!v) throw new DescriptionError(`description part ${k} is empty`);
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new DescriptionError(`description part ${k} contains a control character`);
    const bad = [...seps].find((c) => v.includes(c));
    if (bad) throw new DescriptionError(`description part ${k} must not contain "${bad.trim()}"`);
  }
  if (used.has('period') && !PERIOD.test(parts.period)) throw new DescriptionError('description part period must be YYYY, YYYY-MM or YYYY-Qn');
  if (used.has('date') && !DATE.test(parts.date)) throw new DescriptionError('description part date must be YYYY-MM-DD');
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
