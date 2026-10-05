/** Helpers to build safe OData v2 filter fragments for Exact Online. */
export const str = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const guid = (g: string) => {
  if (!/^[0-9a-fA-F-]{36}$/.test(g)) throw new Error(`Invalid GUID: ${g}`);
  return `guid'${g}'`;
};
export const date = (iso: string) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) throw new Error(`Invalid date: ${iso}`);
  return `datetime'${iso.slice(0, 10)}'`;
};
export const and = (parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' and ') || undefined;
