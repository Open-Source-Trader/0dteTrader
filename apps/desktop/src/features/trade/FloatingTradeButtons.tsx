import type { OrderSide } from '@0dtetrader/shared-types';
import { TradeActionButton } from '../../design/components/TradeActionButton';

interface FloatingTradeButtonsProps {
  isEnabled: boolean;
  /** Explains why the buttons are disabled; shown above the row. */
  disabledReason?: string | null;
  onSide: (side: OrderSide) => void;
}

/** Floating Buy/Sell buttons overlaid on the fullscreen chart (Layout A). */
export function FloatingTradeButtons({
  isEnabled,
  disabledReason = null,
  onSide,
}: FloatingTradeButtonsProps) {
  return (
    <>
      {!isEnabled && disabledReason ? (
        <span
          role="status"
          className="text-secondary"
          style={{ fontSize: 'var(--fs-caption)', textAlign: 'center' }}
        >
          {disabledReason}
        </span>
      ) : null}
      {/* Glow is baked into the buttons' HUD frames — no shadow wrappers. */}
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
    </>
  );
}
