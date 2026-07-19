import type { AuthStore } from './AuthStore';

const DISCLAIMER_PARAGRAPHS = [
  'Trading securities and options involves substantial risk of loss and is not suitable for every investor. You may lose all of your invested capital.',
  'Options on their expiration date ("0DTE") are especially volatile: prices can move violently in minutes, liquidity can disappear, and positions can expire worthless the same day.',
  '0dteTrader is an order-entry tool only. It does not provide investment advice, recommendations, or analysis, and nothing in the app should be interpreted as such. Order routing, contract selection, and pricing are validated by the backend, but market conditions, connectivity, or broker outages may prevent or delay execution.',
  'By tapping "I Understand and Accept" you acknowledge these risks and agree that you are solely responsible for every order submitted through this app.',
];

// Reuses the shared toast-in keyframes (base.css) for a staggered entrance;
// the global prefers-reduced-motion rule collapses it for motion-sensitive users.
const ENTRANCE = 'toast-in 250ms cubic-bezier(0.32, 0.72, 0, 1) both';

// Fade the scrollable edges so clipped text is discoverable without a scrollbar.
const SCROLL_FADE =
  'linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)';

/** First-launch risk disclosure; must accept before any other screen. */
export function RiskDisclaimerView({ store }: { store: AuthStore }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
        padding: 'var(--pad-screen)',
      }}
    >
      <h1
        className="hud-title"
        style={{
          fontSize: 'var(--fs-title3)',
          textAlign: 'center',
          animation: ENTRANCE,
          color: 'var(--hud-amber)',
          textShadow: '0 0 6px rgba(255, 197, 61, 0.5), 0 0 18px rgba(255, 197, 61, 0.3)',
        }}
      >
        Risk Disclosure
      </h1>

      <div
        className="hide-scrollbar"
        tabIndex={0}
        role="region"
        aria-label="Risk disclosure text"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          maskImage: SCROLL_FADE,
          WebkitMaskImage: SCROLL_FADE,
          animation: ENTRANCE,
          animationDelay: '60ms',
        }}
      >
        {/* margin auto centers the block when it underflows and still scrolls
            correctly when it overflows (unlike align-items: center). */}
        <div
          style={{
            width: '100%',
            margin: 'auto 0',
            fontSize: 'var(--fs-subheadline)',
            lineHeight: 1.47,
            color: 'var(--label-primary)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          {DISCLAIMER_PARAGRAPHS.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      </div>

      <button
        className="button-primary"
        style={{ marginBottom: 'var(--space-2)', animation: ENTRANCE, animationDelay: '120ms' }}
        onClick={() => store.acceptDisclaimer()}
      >
        I Understand and Accept
      </button>
    </div>
  );
}
