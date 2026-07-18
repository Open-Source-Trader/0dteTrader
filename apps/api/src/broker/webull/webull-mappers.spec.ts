import {
  contractSymbolOf,
  INTERVAL_TO_TIMESPAN,
  mapOrderStatus,
  toCandle,
  toFuturesContract,
  toOrderResult,
  toPosition,
  toProjectFuturesSymbol,
  toQuote,
  toWebullFuturesSymbol,
} from './webull-mappers';

describe('futures symbol translation', () => {
  it('converts project 2-digit years to Webull 1-digit years', () => {
    expect(toWebullFuturesSymbol('ESZ25')).toBe('ESZ5');
    expect(toWebullFuturesSymbol('MNQH26')).toBe('MNQH6');
  });

  it('expands Webull symbols using contract_month when present', () => {
    expect(toProjectFuturesSymbol('ESZ5', '202512')).toBe('ESZ25');
    expect(toProjectFuturesSymbol('GCM4', '203406')).toBe('GCM34');
  });

  it('expands the year digit to the next matching year without contract_month', () => {
    expect(toProjectFuturesSymbol('ESZ5', undefined, new Date('2025-01-01'))).toBe('ESZ25');
    expect(toProjectFuturesSymbol('ESZ5', undefined, new Date('2026-07-17'))).toBe('ESZ35');
    expect(toProjectFuturesSymbol('ESH6', undefined, new Date('2026-01-01'))).toBe('ESH26');
  });

  it('passes through symbols that do not match either format', () => {
    expect(toWebullFuturesSymbol('SPY')).toBe('SPY');
    expect(toProjectFuturesSymbol('SPY')).toBe('SPY');
  });
});

describe('mapOrderStatus', () => {
  it('maps the documented Webull statuses', () => {
    expect(mapOrderStatus('PENDING')).toBe('submitted');
    expect(mapOrderStatus('SUBMITTED')).toBe('submitted');
    expect(mapOrderStatus('PARTIAL_FILLED')).toBe('partially_filled');
    expect(mapOrderStatus('FILLED')).toBe('filled');
    expect(mapOrderStatus('CANCELLED')).toBe('cancelled');
    expect(mapOrderStatus('FAILED')).toBe('rejected');
  });

  it('defaults unknown statuses to submitted', () => {
    expect(mapOrderStatus(undefined)).toBe('submitted');
    expect(mapOrderStatus('SOMETHING_NEW')).toBe('submitted');
  });
});

describe('toQuote / toCandle', () => {
  it('tolerates Webull string numbers', () => {
    const quote = toQuote('AAPL', {
      symbol: 'AAPL',
      bid: '210.55',
      ask: '210.60',
      price: '210.58',
      bid_size: '3',
      ask_size: '5',
      volume: '12345678',
      last_trade_time: 1752768000000,
    });
    expect(quote).toMatchObject({
      symbol: 'AAPL',
      bid: 210.55,
      ask: 210.6,
      last: 210.58,
      bidSize: 3,
      askSize: 5,
      volume: 12345678,
    });
    expect(quote.timestamp).toBe(new Date(1752768000000).toISOString());
  });

  it('maps bars with epoch-second times', () => {
    const candle = toCandle({
      time: 1752768000,
      open: '5',
      high: '6',
      low: '4',
      close: '5.5',
      volume: '100',
    });
    expect(candle).toEqual({
      time: new Date(1752768000000).toISOString(),
      open: 5,
      high: 6,
      low: 4,
      close: 5.5,
      volume: 100,
    });
  });

  it('covers every app interval', () => {
    expect(INTERVAL_TO_TIMESPAN).toEqual({
      '1m': 'M1',
      '5m': 'M5',
      '15m': 'M15',
      '1h': 'M60',
      '1d': 'D',
    });
  });
});

describe('contractSymbolOf / toOrderResult', () => {
  const optionOrder = {
    client_order_id: 'abc123',
    order_id: 'WB-1',
    status: 'FILLED',
    instrument_type: 'OPTION',
    symbol: 'SPY',
    side: 'BUY',
    order_type: 'LIMIT',
    limit_price: '1.25',
    filled_price: '1.20',
    quantity: '2',
    place_time_at: '2026-07-17T14:30:00Z',
    legs: [
      {
        symbol: 'SPY',
        strike_price: '505',
        option_expire_date: '2026-07-17',
        option_type: 'CALL',
      },
    ],
  };

  it('builds the OCC symbol from option legs', () => {
    expect(contractSymbolOf(optionOrder)).toBe('SPY260717C00505000');
  });

  it('maps a filled option order, keyed by client_order_id', () => {
    expect(toOrderResult(optionOrder)).toEqual({
      orderId: 'abc123',
      status: 'filled',
      contractSymbol: 'SPY260717C00505000',
      side: 'buy',
      quantity: 2,
      orderType: 'mid',
      limitPrice: 1.25,
      filledPrice: 1.2,
      timestamp: '2026-07-17T14:30:00.000Z',
    });
  });

  it('translates futures order symbols to project format', () => {
    expect(
      contractSymbolOf({
        instrument_type: 'FUTURES',
        symbol: 'ESZ5',
        contract_month: '202512',
      }),
    ).toBe('ESZ25');
  });
});

describe('toPosition', () => {
  it('maps option positions via legs and ignores equities', () => {
    expect(
      toPosition({
        instrument_type: 'OPTION',
        symbol: 'SPY',
        quantity: '-1',
        cost_price: '2.0',
        last_price: '1.5',
        unrealized_profit_loss: '50',
        legs: [
          {
            symbol: 'SPY',
            strike_price: '500',
            option_expire_date: '2026-07-17',
            option_type: 'PUT',
          },
        ],
      }),
    ).toEqual({
      symbol: 'SPY260717P00500000',
      assetClass: 'option',
      quantity: -1,
      avgPrice: 2,
      markPrice: 1.5,
      unrealizedPnl: 50,
      multiplier: 100,
    });
    expect(toPosition({ instrument_type: 'EQUITY', symbol: 'AAPL' })).toBeNull();
  });
});

describe('toFuturesContract', () => {
  it('combines instrument metadata with a snapshot', () => {
    expect(
      toFuturesContract(
        'es',
        {
          symbol: 'ESZ5',
          contract_month: '202512',
          contract_type: 'MONTHLY',
          last_trading_date: '2025-12-19',
        },
        { symbol: 'ESZ5', bid: '6001', ask: '6001.5', price: '6001.25' },
        true,
      ),
    ).toEqual({
      symbol: 'ESZ25',
      root: 'ES',
      expiration: '2025-12-19',
      frontMonth: true,
      bid: 6001,
      ask: 6001.5,
      last: 6001.25,
    });
  });
});
