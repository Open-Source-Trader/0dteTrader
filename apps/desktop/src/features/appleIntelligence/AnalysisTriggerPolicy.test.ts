import { describe, expect, it } from 'vitest';
import { evaluateCandleCloseTrigger } from './AnalysisTriggerPolicy';

describe('evaluateCandleCloseTrigger', () => {
  it('triggers on the first candle close seen this session', () => {
    const decision = evaluateCandleCloseTrigger(
      { symbol: 'SPY', timeframe: '5m', candleCloseTime: 1000 },
      { lastTriggeredCloseTime: null },
    );
    expect(decision.shouldTrigger).toBe(true);
    expect(decision.priority).toBe('candle-close');
  });

  it('does not re-trigger for the same candle close time', () => {
    const decision = evaluateCandleCloseTrigger(
      { symbol: 'SPY', timeframe: '5m', candleCloseTime: 1000 },
      { lastTriggeredCloseTime: 1000 },
    );
    expect(decision.shouldTrigger).toBe(false);
  });

  it('triggers again for a genuinely new candle close', () => {
    const decision = evaluateCandleCloseTrigger(
      { symbol: 'SPY', timeframe: '5m', candleCloseTime: 1300 },
      { lastTriggeredCloseTime: 1000 },
    );
    expect(decision.shouldTrigger).toBe(true);
  });
});
