import { describe, expect, it } from 'vitest';
import { shallowEqual } from './observable';

describe('shallowEqual', () => {
  it('is true for the same reference', () => {
    const obj = { a: 1 };
    expect(shallowEqual(obj, obj)).toBe(true);
  });

  it('is true for different objects with the same own keys/values', () => {
    expect(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
  });

  it('is false when a value differs', () => {
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('is false when key counts differ', () => {
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 } as unknown as { a: number })).toBe(false);
  });

  it('compares nested objects by reference, not deep equality', () => {
    const nested = { x: 1 };
    expect(shallowEqual({ n: nested }, { n: { x: 1 } })).toBe(false);
    expect(shallowEqual({ n: nested }, { n: nested })).toBe(true);
  });
});
