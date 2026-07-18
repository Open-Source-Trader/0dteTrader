interface TradeActionButtonProps {
  title: string;
  color: string;
  isEnabled?: boolean;
  onClick: () => void;
}

/** Swap the bright text-on-dark hues for the AA-passing button fills. */
function fillColor(color: string): string {
  if (color === 'var(--buy-green)') return 'var(--buy-green-fill)';
  if (color === 'var(--sell-red)') return 'var(--sell-red-fill)';
  return color;
}

/** Large Buy/Sell action button (TradeButtons.swift): 52px, radius 12. */
export function TradeActionButton({
  title,
  color,
  isEnabled = true,
  onClick,
}: TradeActionButtonProps) {
  return (
    <button
      className="trade-action-button"
      style={{ background: fillColor(color) }}
      disabled={!isEnabled}
      onClick={onClick}
      aria-label={title}
    >
      {title}
    </button>
  );
}
