import type { OrderSide } from '@0dtetrader/shared-types';
import { TradeActionButton } from '../../design/components/TradeActionButton';

interface FloatingTradeButtonsProps {
  isEnabled: boolean;
  onSide: (side: OrderSide) => void;
}

/** Floating Buy/Sell buttons overlaid on the fullscreen chart (Layout A). */
export function FloatingTradeButtons({ isEnabled, onSide }: FloatingTradeButtonsProps) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '0 20px' }}>
      <TradeActionButton
        title="SELL"
        color="var(--sell-red)"
        isEnabled={isEnabled}
        onClick={() => onSide('sell')}
      />
      <TradeActionButton
        title="BUY"
        color="var(--buy-green)"
        isEnabled={isEnabled}
        onClick={() => onSide('buy')}
      />
    </div>
  );
}
