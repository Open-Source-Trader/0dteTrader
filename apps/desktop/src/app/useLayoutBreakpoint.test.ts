import { describe, expect, it } from 'vitest';
import { breakpointForWidth } from './useLayoutBreakpoint';

describe('breakpointForWidth', () => {
  it('is compact below the standard boundary', () => {
    expect(breakpointForWidth(0)).toBe('compact');
    expect(breakpointForWidth(1023)).toBe('compact');
  });

  it('is standard from 1024 up to just under the wide boundary', () => {
    expect(breakpointForWidth(1024)).toBe('standard');
    expect(breakpointForWidth(1599)).toBe('standard');
  });

  it('is wide at and above 1600', () => {
    expect(breakpointForWidth(1600)).toBe('wide');
    expect(breakpointForWidth(3840)).toBe('wide');
  });
});
