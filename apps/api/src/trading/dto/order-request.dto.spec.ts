import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { OrderRequestDto, OrderSelectionDto } from './order-request.dto';

/**
 * `POST /v1/orders` is public input, so the DTO — not the trade panel — is what
 * stands between a typed number and the broker. These exercise the pairing rule
 * (`limitPrice` iff `custom`) and the bounds on the one field the server does
 * not recompute for itself.
 */
function errorsFor(overrides: Record<string, unknown>): string[] {
  const dto = plainToInstance(OrderRequestDto, {
    underlying: 'SPY',
    assetClass: 'option',
    side: 'buy',
    quantity: 1,
    orderType: 'mid',
    selection: { mode: 'auto_otm', optionType: 'call' },
    ...overrides,
  });
  return validateSync(dto).flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('OrderRequestDto', () => {
  it('accepts all five order types', () => {
    for (const orderType of ['bid', 'mid', 'ask', 'market']) {
      expect(errorsFor({ orderType })).toEqual([]);
    }
    expect(errorsFor({ orderType: 'custom', limitPrice: 2.45 })).toEqual([]);
  });

  it('rejects an order type outside the five', () => {
    expect(errorsFor({ orderType: 'limit' }).join(' ')).toMatch(/orderType/);
    expect(errorsFor({ orderType: 'MID' }).join(' ')).toMatch(/orderType/);
  });

  it('requires a limitPrice for custom and only for custom', () => {
    expect(errorsFor({ orderType: 'custom' }).join(' ')).toMatch(
      /required when orderType is custom/,
    );
    expect(errorsFor({ orderType: 'mid', limitPrice: 2.45 }).join(' ')).toMatch(
      /only accepted when orderType is custom/,
    );
    expect(errorsFor({ orderType: 'market', limitPrice: 2.45 }).join(' ')).toMatch(
      /only accepted when orderType is custom/,
    );
  });

  it('rejects a custom price that is not a bounded, tick-aligned number', () => {
    expect(errorsFor({ orderType: 'custom', limitPrice: 0 }).join(' ')).toMatch(/between/);
    expect(errorsFor({ orderType: 'custom', limitPrice: -1 }).join(' ')).toMatch(/between/);
    expect(errorsFor({ orderType: 'custom', limitPrice: 1e9 }).join(' ')).toMatch(/between/);
    expect(errorsFor({ orderType: 'custom', limitPrice: 2.455 }).join(' ')).toMatch(/ticks/);
    expect(errorsFor({ orderType: 'custom', limitPrice: 'cheap' }).join(' ')).toMatch(/finite/);
  });
});

describe('OrderSelectionDto.otmOffset', () => {
  function selectionErrors(overrides: Record<string, unknown>): string[] {
    const dto = plainToInstance(OrderSelectionDto, {
      mode: 'auto_otm',
      optionType: 'call',
      ...overrides,
    });
    return validateSync(dto).flatMap((error) => Object.values(error.constraints ?? {}));
  }

  it('accepts 0 through 10, and absence', () => {
    expect(selectionErrors({})).toEqual([]);
    expect(selectionErrors({ otmOffset: 0 })).toEqual([]);
    expect(selectionErrors({ otmOffset: 1 })).toEqual([]);
    expect(selectionErrors({ otmOffset: 10 })).toEqual([]);
  });

  it('rejects negative, fractional, oversized, and non-numeric offsets', () => {
    expect(selectionErrors({ otmOffset: -1 }).join(' ')).toMatch(/otmOffset/);
    expect(selectionErrors({ otmOffset: 1.5 }).join(' ')).toMatch(/otmOffset/);
    expect(selectionErrors({ otmOffset: 11 }).join(' ')).toMatch(/otmOffset/);
    expect(selectionErrors({ otmOffset: 'two' }).join(' ')).toMatch(/otmOffset/);
  });
});
