interface TradeActionButtonProps {
  title: string;
  color: string;
  isEnabled?: boolean;
  onClick: () => void;
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
      style={{ background: color, opacity: isEnabled ? 1 : 0.35 }}
      disabled={!isEnabled}
      onClick={onClick}
      aria-label={title}
    >
      {title}
    </button>
  );
}
