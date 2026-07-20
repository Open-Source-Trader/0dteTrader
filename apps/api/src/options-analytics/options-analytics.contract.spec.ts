import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  OPTIONS_ANALYTICS_EXPOSURE_UNIT,
  type OptionsAnalyticsSnapshot,
} from '@0dtetrader/shared-types';

describe('OptionsAnalyticsSnapshot shared contract', () => {
  it('exports the canonical exposure unit literal', () => {
    expect(OPTIONS_ANALYTICS_EXPOSURE_UNIT).toBe('$ delta change per 1% underlying move');
  });

  it('parses the canonical cross-client version 1 fixture with the exact response shape', () => {
    const fixturePath = resolve(
      __dirname,
      '../../../../packages/shared-types/fixtures/options-analytics-v1.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as OptionsAnalyticsSnapshot;

    expect(Object.keys(fixture)).toEqual([
      'scope',
      'exposureUnit',
      'quality',
      'structure',
      'scenarios',
      'impliedRange',
      'strikes',
    ]);
    expect(fixture.scope).toMatchObject({
      symbol: 'SPX',
      rootSymbol: 'SPXW',
      settlementStyle: 'pm',
    });
    expect(fixture.exposureUnit).toBe(OPTIONS_ANALYTICS_EXPOSURE_UNIT);
    expect(fixture.quality.calculationVersion).toBe('options-analytics-v1');
    expect(fixture.strikes.some((strike) => 'callPutDealerProxyExposure' in strike)).toBe(false);
    expect(fixture.scenarios.callPutDealerProxy).toHaveProperty('strikeGammaExposures');
    expect(
      fixture.strikes.every(
        (strike, index, rows) => index === 0 || rows[index - 1].strike < strike.strike,
      ),
    ).toBe(true);
  });
});
