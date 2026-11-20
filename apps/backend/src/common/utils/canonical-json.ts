/**
 * Canonical JSON serialization conforming to RFC 8785 (JSON Canonicalization Scheme - JCS) principles.
 * Ensures consistent, deterministic serialization:
 * - Object keys are sorted lexicographically by UTF-16 code units.
 * - Array elements are preserved in index order, with null/undefined distinguished correctly:
 *   - `[]` serializes as `[]`
 *   - `[null]` serializes as `[null]`
 *   - `undefined` values inside arrays serialize as `null` (standard JSON behavior).
 * - Primitive values (`null`, `true`, `false`, numbers, strings) serialize unambiguously.
 * - Non-enumerable properties, functions, and symbols in objects are omitted.
 */

export function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  return serialize(value, new Set());
}

function serialize(val: unknown, seen: Set<object>): string {
  if (val === null) {
    return 'null';
  }

  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new TypeError('Cannot canonically serialize non-finite numbers (NaN, Infinity)');
    }
    // Handle negative zero per JCS
    if (Object.is(val, -0)) {
      return '0';
    }
    return JSON.stringify(val);
  }

  if (typeof val === 'string') {
    return JSON.stringify(val);
  }

  if (typeof val === 'bigint') {
    return val.toString();
  }

  if (typeof val === 'object') {
    if (seen.has(val as object)) {
      throw new TypeError('Cannot canonically serialize circular object structure');
    }
    seen.add(val as object);

    try {
      if (Array.isArray(val)) {
        const elements = val.map((elem) => {
          if (elem === undefined || typeof elem === 'function' || typeof elem === 'symbol') {
            return 'null';
          }
          return serialize(elem, seen);
        });
        return `[${elements.join(',')}]`;
      }

      // Check if value has a custom toJSON method (like Date)
      if (typeof (val as { toJSON?: () => unknown }).toJSON === 'function') {
        return serialize((val as { toJSON: () => unknown }).toJSON(), seen);
      }

      const obj = val as Record<string, unknown>;
      const sortedKeys = Object.keys(obj).sort();
      const entries: string[] = [];

      for (const key of sortedKeys) {
        const propVal = obj[key];
        if (
          propVal !== undefined &&
          typeof propVal !== 'function' &&
          typeof propVal !== 'symbol'
        ) {
          entries.push(`${JSON.stringify(key)}:${serialize(propVal, seen)}`);
        }
      }

      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(val as object);
    }
  }

  // Functions, symbols, undefined at object property level are omitted by caller
  return 'null';
}
