import type { OptionContract, OrderType, Position } from '@0dtetrader/shared-types';
import { midPrice } from '../../core/models/domain';

export function calculateLongOptionExpiryBreakEven({
  strike,
  optionType,
  premium,
}: {
  strike: number;
  optionType: OptionContract['optionType'];
  premium: number | null;
}): number | null {
  if (!Number.isFinite(strike) || premium === null || !Number.isFinite(premium) || premium <= 0) {
    return null;
  }
  return optionType === 'call' ? strike + premium : strike - premium;
}

export function selectedContractPremium({
  contract,
  orderType,
  customLimitPrice,
}: {
  contract: OptionContract | null;
  orderType: OrderType;
  customLimitPrice: number | null;
}): number | null {
  if (!contract) return null;
  switch (orderType) {
    case 'bid':
      return contract.bid > 0 ? contract.bid : null;
    case 'mid':
      return midPrice(contract.bid, contract.ask);
    case 'ask':
      return contract.ask > 0 ? contract.ask : null;
    case 'custom':
      return customLimitPrice !== null && customLimitPrice > 0 ? customLimitPrice : null;
    case 'market':
      return contract.ask > 0 ? contract.ask : midPrice(contract.bid, contract.ask);
  }
}

export function selectSelectedContractExpiryBreakEven({
  contract,
  orderType,
  customLimitPrice,
}: {
  contract: OptionContract | null;
  orderType: OrderType;
  customLimitPrice: number | null;
}): number | null {
  const premium = selectedContractPremium({ contract, orderType, customLimitPrice });
  if (!contract) return null;
  return calculateLongOptionExpiryBreakEven({
    strike: contract.strike,
    optionType: contract.optionType,
    premium,
  });
}

export function selectPositionExpiryBreakEven({
  position,
  contract,
}: {
  position: Position;
  contract: OptionContract | null;
}): number | null {
  if (!contract || position.assetClass !== 'option' || position.quantity <= 0) return null;
  return calculateLongOptionExpiryBreakEven({
    strike: contract.strike,
    optionType: contract.optionType,
    premium: position.avgPrice,
  });
}
