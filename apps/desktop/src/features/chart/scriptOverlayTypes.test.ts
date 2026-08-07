import { describe, expect, it } from 'vitest';
import {
  isValidScriptColor,
  mergeScriptRenderModels,
  type ScriptRenderModel,
  withScriptColorOpacity,
} from './scriptOverlayTypes';

function model(values: Partial<ScriptRenderModel> = {}): ScriptRenderModel {
  return {
    candleColors: null,
    markers: [],
    lines: [],
    fills: [],
    segments: [],
    bands: [],
    labels: [],
    banner: null,
    ...values,
  };
}

describe('script overlay color contract', () => {
  it('rejects malformed, non-finite and out-of-range functional colors', () => {
    for (const color of [
      'rgb(1,,3)',
      'rgbfoo(1,2,3)',
      'rgb(1,2)',
      'rgba(1,2,3)',
      'rgba(1,2,3,2)',
      'rgb(256,2,3)',
      'rgb(NaN,2,3)',
      'rgb(0x10,2,3)',
      '#12345',
    ]) {
      expect(isValidScriptColor(color), color).toBe(false);
    }
    expect(isValidScriptColor(' RGB(1, 2, 3) ')).toBe(true);
    expect(isValidScriptColor('rgba(1, 2, 3, 0.5)')).toBe(true);
  });

  it('clamps requested opacity and leaves invalid colors untouched', () => {
    expect(withScriptColorOpacity('#010203', 2)).toBe('rgba(1, 2, 3, 1)');
    expect(withScriptColorOpacity('rgba(1,2,3,0.5)', -1)).toBe('rgba(1, 2, 3, 0)');
    expect(withScriptColorOpacity('bad', 0.5)).toBe('bad');
  });

  it('merges every geometry collection while preserving first-owner singleton fields', () => {
    const first = model({
      candleColors: ['#010203'],
      segments: [{ x1: 0, y1: 1, x2: 2, y2: 3, color: '#010203', width: 1, style: 'solid' }],
      banner: { text: 'first', color: '#010203', position: 'top', size: 'small' },
    });
    const second = model({
      candleColors: ['#040506'],
      bands: [{ x1: 0, x2: 1, yTop: 2, yBottom: 1, fillColor: '#040506' }],
      banner: { text: 'second', color: '#040506', position: 'bottom', size: 'large' },
    });
    expect(mergeScriptRenderModels([null, first, second])).toEqual({
      ...model(),
      candleColors: first.candleColors,
      segments: first.segments,
      bands: second.bands,
      banner: first.banner,
    });
    expect(mergeScriptRenderModels([null, null])).toBeNull();
  });
});
