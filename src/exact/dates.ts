const MS_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

/** Recursively convert Exact "/Date(ms)/" strings to ISO 8601 and drop OData metadata. */
export function convertDates<T>(value: T): T {
  if (typeof value === 'string') {
    const m = MS_DATE.exec(value);
    return (m ? new Date(Number(m[1])).toISOString() : value) as T;
  }
  if (Array.isArray(value)) return value.map(convertDates) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__metadata' || k === '__deferred') continue;
      out[k] = convertDates(v);
    }
    return out as T;
  }
  return value;
}
