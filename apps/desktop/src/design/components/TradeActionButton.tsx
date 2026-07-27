import { ChevronDownIcon, ChevronUpIcon } from '../icons';

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
  // Down on SELL, up on BUY: the direction the button bets on is vertical, and
  // the sideways pair inherited from the mockup said nothing. SVG rather than
  // `⌄`/`⌃`, which the display font has no glyph for and would substitute.
  const Chevron = sell ? ChevronDownIcon : ChevronUpIcon;
  const chevrons = (
    <span className="hud-chevrons" aria-hidden="true">
      <Chevron size={11} />
      <Chevron size={11} />
    </span>
  );
  return (
    <button
      className={`trade-action-button hud-btn ${variant}`}
      style={variant ? undefined : { background: color }}
      disabled={!isEnabled}
      onClick={onClick}
      aria-label={title}
    >
      {sell ? chevrons : null}
      <span>{title}</span>
      {!sell ? chevrons : null}
    </button>
  );
}
