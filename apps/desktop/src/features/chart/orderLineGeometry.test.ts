import { describe, expect, it } from 'vitest';
import {
  hitRows,
  layoutRow,
  type LineRow,
  onLineBody,
  pillAt,
  PILL_GAP,
  ROW_HEIGHT,
} from './orderLineGeometry';

/** Every glyph 10px wide, so pill widths are predictable. */
const measure = (label: string) => label.length * 10;

function row(y: number, id = 'o1'): LineRow {
  const pills = layoutRow(
    [
      { key: 'quantity', label: '1' },
      { key: 'kind', label: 'STP' },
      { key: 'orderType', label: 'MID' },
      { key: 'close', label: '✕' },
    ],
    measure,
    400,
  );
  return { id, y, pills, left: pills[0].x };
}

describe('layoutRow', () => {
  it('right-aligns the row so it ends at the given edge', () => {
    const pills = layoutRow(
      [
        { key: 'quantity', label: '1' },
        { key: 'close', label: '✕' },
      ],
      measure,
      400,
    );

    const last = pills[pills.length - 1];
    expect(last.x + last.width).toBe(400);
  });

  it('lays pills left-to-right in the order given, with no overlap', () => {
    const pills = row(100).pills;

    expect(pills.map((p) => p.key)).toEqual(['quantity', 'kind', 'orderType', 'close']);
    for (let i = 1; i < pills.length; i++) {
      expect(pills[i].x).toBe(pills[i - 1].x + pills[i - 1].width + PILL_GAP);
    }
  });
});

describe('pillAt', () => {
  it('resolves each pill to itself at its centre', () => {
    const line = row(100);

    for (const pill of line.pills) {
      expect(pillAt(line, pill.x + pill.width / 2, 100)).toBe(pill.key);
    }
  });

  it('treats the label pill as transparent so the chart keeps pan/zoom under it', () => {
    const pills = layoutRow(
      [
        { key: 'label', label: '500C 0DTE' },
        { key: 'quantity', label: '+1' },
        { key: 'close', label: '✕' },
      ],
      measure,
      400,
    );
    const line = { id: 'entry:X', y: 100, pills, left: pills[0].x };
    const label = pills.find((p) => p.key === 'label')!;
    const quantity = pills.find((p) => p.key === 'quantity')!;

    expect(pillAt(line, label.x + label.width / 2, 100)).toBeNull();
    expect(pillAt(line, quantity.x + quantity.width / 2, 100)).toBe('quantity');
  });

  it('never lets the execution pill steal the cancel tap', () => {
    const line = row(100);
    const orderType = line.pills.find((p) => p.key === 'orderType')!;
    const close = line.pills.find((p) => p.key === 'close')!;

    // Anywhere inside the cancel pill must cancel, including its left edge —
    // flipping MID/MKT when the user aimed at ✕ (or vice versa) is the exact
    // mis-hit this geometry exists to prevent.
    expect(pillAt(line, close.x, 100)).toBe('close');
    expect(pillAt(line, close.x + close.width, 100)).toBe('close');
    expect(pillAt(line, orderType.x + orderType.width - 1, 100)).toBe('orderType');
  });

  it('misses rows the pointer is not vertically on', () => {
    const line = row(100);
    const close = line.pills.find((p) => p.key === 'close')!;

    expect(pillAt(line, close.x + 2, 100 + ROW_HEIGHT)).toBeNull();
  });

  it('honours extra vertical slop for touch', () => {
    const line = row(100);
    const close = line.pills.find((p) => p.key === 'close')!;

    expect(pillAt(line, close.x + 2, 100 + ROW_HEIGHT, 14)).toBe('close');
  });
});

describe('onLineBody', () => {
  it('grabs the line to the left of its buttons', () => {
    const line = row(100);

    expect(onLineBody(line, line.left - 40, 100)).toBe(true);
    expect(onLineBody(line, line.left - 40, 112)).toBe(false);
  });

  it('does not treat the button row as line body', () => {
    const line = row(100);

    expect(onLineBody(line, line.left + 10, 100)).toBe(false);
  });
});

describe('hitRows', () => {
  it('picks the nearest row when lines are stacked', () => {
    const near = row(100, 'near');
    const far = row(118, 'far');

    expect(hitRows([far, near], near.left - 20, 101)?.row.id).toBe('near');
  });

  it('returns null in empty space', () => {
    expect(hitRows([row(100)], 200, 300)).toBeNull();
  });
});
