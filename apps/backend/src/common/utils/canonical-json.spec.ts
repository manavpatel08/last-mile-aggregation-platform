import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { canonicalJsonStringify } from './canonical-json.js';

describe('canonicalJsonStringify (RFC 8785 Canonical JSON Serialization)', () => {
  function hash(value: unknown): string {
    return crypto
      .createHash('sha256')
      .update(canonicalJsonStringify(value))
      .digest('hex');
  }

  it('should serialize primitives unambiguously', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify(0)).toBe('0');
    expect(canonicalJsonStringify(-0)).toBe('0');
    expect(canonicalJsonStringify(123)).toBe('123');
    expect(canonicalJsonStringify('hello')).toBe('"hello"');
    expect(canonicalJsonStringify('')).toBe('""');
    expect(canonicalJsonStringify(undefined)).toBe('');
  });

  it('should strictly distinguish [] from [null] and produce distinct hashes', () => {
    const emptyArrayStr = canonicalJsonStringify([]);
    const nullArrayStr = canonicalJsonStringify([null]);

    expect(emptyArrayStr).toBe('[]');
    expect(nullArrayStr).toBe('[null]');
    expect(emptyArrayStr).not.toBe(nullArrayStr);

    const emptyArrayHash = hash([]);
    const nullArrayHash = hash([null]);
    expect(emptyArrayHash).not.toBe(nullArrayHash);
  });

  it('should distinguish nested arrays: [[]] vs [[null]] vs [null, []]', () => {
    expect(canonicalJsonStringify([[]])).toBe('[[]]');
    expect(canonicalJsonStringify([[null]])).toBe('[[null]]');
    expect(canonicalJsonStringify([null, []])).toBe('[null,[]]');
    expect(canonicalJsonStringify([[], null])).toBe('[[],null]');

    expect(hash([[]])).not.toBe(hash([[null]]));
    expect(hash([null, []])).not.toBe(hash([[], null]));
  });

  it('should strictly distinguish null, empty string, 0, and false in objects', () => {
    const objNull = { a: null };
    const objEmptyStr = { a: '' };
    const objZero = { a: 0 };
    const objFalse = { a: false };

    expect(canonicalJsonStringify(objNull)).toBe('{"a":null}');
    expect(canonicalJsonStringify(objEmptyStr)).toBe('{"a":""}');
    expect(canonicalJsonStringify(objZero)).toBe('{"a":0}');
    expect(canonicalJsonStringify(objFalse)).toBe('{"a":false}');

    const hashes = new Set([
      hash(objNull),
      hash(objEmptyStr),
      hash(objZero),
      hash(objFalse),
    ]);
    expect(hashes.size).toBe(4);
  });

  it('should sort object keys deterministically regardless of insertion order', () => {
    const obj1 = { b: 2, a: 1, c: { y: 20, x: 10 } };
    const obj2 = { c: { x: 10, y: 20 }, a: 1, b: 2 };

    const str1 = canonicalJsonStringify(obj1);
    const str2 = canonicalJsonStringify(obj2);

    expect(str1).toBe('{"a":1,"b":2,"c":{"x":10,"y":20}}');
    expect(str2).toBe('{"a":1,"b":2,"c":{"x":10,"y":20}}');
    expect(str1).toBe(str2);
    expect(hash(obj1)).toBe(hash(obj2));
  });

  it('should omit undefined properties from objects but convert undefined to null in arrays', () => {
    const obj = { a: 1, b: undefined, c: [1, undefined, 3] };
    expect(canonicalJsonStringify(obj)).toBe('{"a":1,"c":[1,null,3]}');
  });

  it('should serialize Date objects via toJSON deterministically', () => {
    const date = new Date('2026-11-20T12:00:00.000Z');
    expect(canonicalJsonStringify({ date })).toBe('{"date":"2026-11-20T12:00:00.000Z"}');
  });

  it('should throw TypeError on non-finite numbers and circular references', () => {
    expect(() => canonicalJsonStringify(NaN)).toThrow(TypeError);
    expect(() => canonicalJsonStringify(Infinity)).toThrow(TypeError);

    const circular: any = { a: 1 };
    circular.self = circular;
    expect(() => canonicalJsonStringify(circular)).toThrow(TypeError);
  });
});
