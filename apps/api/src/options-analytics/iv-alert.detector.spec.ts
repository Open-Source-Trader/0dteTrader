import type { IVAlertConfiguration, IVAlertSymbol } from '@0dtetrader/shared-types';
import {
  DEFAULT_IV_ALERT_CONFIGURATION,
  advanceIvDetector,
  emptyIvDetectorState,
  median,
  type IvDetectorState,
} from './iv-alert.detector';

const config: IVAlertConfiguration = {
  ...DEFAULT_IV_ALERT_CONFIGURATION,
  enabled: true,
  symbols: ['SPX', 'NDX', 'RUT'],
};
const at = (minute: number) => new Date(Date.parse('2026-08-05T13:30:00.000Z') + minute * 60_000);

function feed(
  state: IvDetectorState,
  minute: number,
  atmIv: number | null,
  symbol: IVAlertSymbol = 'SPX',
) {
  return advanceIvDetector(state, { symbol, timestamp: at(minute), atmIv }, config);
}

function warmed(values = [0.19, 0.21, 0.2, 0.2, 0.19, 0.21, 0.2, 0.2, 0.19, 0.21]) {
  let state = emptyIvDetectorState();
  values.forEach((value, minute) => {
    state = feed(state, minute, value).state;
  });
  return state;
}

describe('IV alert detector', () => {
  it('computes the raw median without a consistency multiplier', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not mutate state for closed-session, unsupported, null, duplicate, or old captures', () => {
    const initial = warmed();
    const cases = [
      advanceIvDetector(
        initial,
        { symbol: 'SPY' as IVAlertSymbol, timestamp: at(10), atmIv: 0.2 },
        config,
      ),
      advanceIvDetector(
        initial,
        { symbol: 'SPX', timestamp: new Date('2026-08-05T21:00:00Z'), atmIv: 0.2 },
        config,
      ),
      feed(initial, 10, null),
      feed(initial, 9, 0.2),
    ];
    for (const result of cases) {
      expect(result.kind).toBe('ignored');
      expect(result.state).toEqual(initial);
    }
  });

  it('requires ten prior samples and ten elapsed minutes and excludes current from baseline', () => {
    const before = warmed();
    const result = feed(before, 10, 0.5);
    expect(result.kind).toBe('tracking');
    expect(result.baselineIv).toBeCloseTo(0.2, 12);
    expect(result.zScore).toBe(20);
    expect(result.state.samples).toHaveLength(11);
  });

  it('treats exactly two minutes as continuous and resets only after a larger gap', () => {
    const before = warmed();
    const exact = feed(before, 11, 0.2);
    expect(exact.reason).not.toBe('gap_reset');
    const gap = feed(before, 12, 0.2);
    expect(gap).toMatchObject({ kind: 'suppressed', reason: 'gap_reset' });
    expect(gap.state.samples).toEqual([{ timestamp: at(12).toISOString(), atmIv: 0.2 }]);
    expect(gap.state.streakCount).toBe(0);
  });

  it('handles zero MAD with finite signed clamping', () => {
    const state = warmed(Array(10).fill(0.2));
    expect(feed(state, 10, 0.2).zScore).toBe(0);
    expect(feed(state, 10, 0.3).zScore).toBe(20);
    expect(feed(state, 10, 0.1).zScore).toBe(-20);
  });

  it('emits expansion and crush only on two adjacent same-direction breaches', () => {
    const expansionFirst = feed(warmed(), 10, 0.5);
    expect(expansionFirst).toMatchObject({ kind: 'tracking', direction: 'expansion' });
    const expansion = feed(expansionFirst.state, 11, 0.5);
    expect(expansion).toMatchObject({
      kind: 'alert',
      alert: { symbol: 'SPX', direction: 'expansion', currentIv: 0.5 },
    });
    expect(expansion.alert?.baselineIv).toBeCloseTo(0.2, 12);

    const crushFirst = feed(warmed(), 10, 0.01);
    const crush = feed(crushFirst.state, 11, 0.01);
    expect(crush).toMatchObject({ kind: 'alert', alert: { direction: 'crush' } });

    const changed = feed(expansionFirst.state, 11, 0.01);
    expect(changed).toMatchObject({ kind: 'tracking', direction: 'crush' });
    expect(changed.state.streakCount).toBe(1);
  });

  it('updates history but clears pre-arming during cooldown, with equality eligible', () => {
    const first = feed(warmed(), 10, 0.5);
    const alert = feed(first.state, 11, 0.5);
    expect(alert.kind).toBe('alert');
    const within = feed(alert.state, 12, 0.5);
    expect(within).toMatchObject({ kind: 'suppressed', reason: 'cooldown' });
    expect(within.state.streakCount).toBe(0);
    expect(within.state.samples[within.state.samples.length - 1]?.timestamp).toBe(
      at(12).toISOString(),
    );
    const minute13 = feed(within.state, 13, 0.5);
    const minute14 = feed(minute13.state, 14, 0.5);
    const minute15 = feed(minute14.state, 15, 0.5);
    const eligible = feed(minute15.state, 16, 0.5);
    expect(eligible.reason).not.toBe('cooldown');
    expect(eligible.state.streakCount).toBe(1);
  });
});
