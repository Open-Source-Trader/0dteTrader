interface TradeActionButtonProps {
  title: string;
  color: string;
  isEnabled?: boolean;
  onClick: () => void;
}

/** Map the accent color to the HUD button variant (frame, tint, glow). */
function variantClass(color: string): string {
  if (color === 'var(--buy-green)') return 'hud-btn--buy';
  if (color === 'var(--sell-red)') return 'hud-btn--sell';
  return '';
}

/** Large Buy/Sell action button: chamfered double-frame HUD chrome. */
export function TradeActionButton({
  title,
  color,
  isEnabled = true,
  onClick,
}: TradeActionButtonProps) {
  const variant = variantClass(color);
  const sell = variant === 'hud-btn--sell';
  return (
    <button
      className={`trade-action-button hud-btn ${variant}`}
      style={variant ? undefined : { background: color }}
      disabled={!isEnabled}
      onClick={onClick}
      aria-label={title}
    >
      {sell ? (
        <span className="hud-chevrons" aria-hidden="true">
          ❮❮
        </span>
      ) : null}
      <span>{title}</span>
      {!sell ? (
        <span className="hud-chevrons" aria-hidden="true">
          ❯❯
        </span>
      ) : null}
    </button>
  );
}
