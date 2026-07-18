import type { AuthStore } from './AuthStore';

const DISCLAIMER_PARAGRAPHS = [
  'Trading securities, options, and futures involves substantial risk of loss and is not suitable for every investor. You may lose all of your invested capital.',
  'Options on their expiration date ("0DTE") are especially volatile: prices can move violently in minutes, liquidity can disappear, and positions can expire worthless the same day. Futures trading involves leverage and can result in losses exceeding your initial investment.',
  '0dteTrader is an order-entry tool only. It does not provide investment advice, recommendations, or analysis, and nothing in the app should be interpreted as such. Order routing, contract selection, and pricing are validated by the backend, but market conditions, connectivity, or broker outages may prevent or delay execution.',
  'By tapping "I Understand and Accept" you acknowledge these risks and agree that you are solely responsible for every order submitted through this app.',
];

/** First-launch risk disclosure; must accept before any other screen. */
export function RiskDisclaimerView({ store }: { store: AuthStore }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        padding: 'var(--pad-screen)',
      }}
    >
      <h1
        style={{
          fontSize: 'var(--fs-title)',
          fontWeight: 700,
          paddingTop: 32,
          textAlign: 'center',
        }}
      >
        Risk Disclosure
      </h1>

      <div className="hide-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div
          className="text-secondary"
          style={{
            fontSize: 'var(--fs-footnote)',
            padding: '0 4px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {DISCLAIMER_PARAGRAPHS.map((paragraph) => (
            <p key={paragraph.slice(0, 24)}>{paragraph}</p>
          ))}
        </div>
      </div>

      <button
        className="button-primary"
        style={{ marginBottom: 8 }}
        onClick={() => store.acceptDisclaimer()}
      >
        I Understand and Accept
      </button>
    </div>
  );
}
