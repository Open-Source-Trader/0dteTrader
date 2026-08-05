import { useState } from 'react';
import { useStore } from '../../core/observable';
import type { AuthStore } from './AuthStore';

/** Versioned, server-recorded Terms and risk gate shown after authentication. */
export function LegalGateView({ store }: { store: AuthStore }) {
  const { legalDocuments, isLoading, errorMessage } = useStore(store);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const allAccepted = legalDocuments.every((document) => accepted[document.slug] === true);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-4)',
        padding: 'var(--pad-screen)',
      }}
    >
      <h1 className="hud-title" style={{ color: 'var(--hud-amber)', textAlign: 'center' }}>
        Required Disclosures
      </h1>
      <p className="text-secondary" style={{ textAlign: 'center' }}>
        Review and accept the current versions before placing orders.
      </p>
      <div className="hide-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {legalDocuments.map((document) => (
          <section key={document.slug} style={{ marginBottom: 'var(--space-6)' }}>
            <h2 className="hud-title" style={{ fontSize: 'var(--fs-title3)' }}>
              {document.title}
            </h2>
            <div
              style={{
                marginTop: 'var(--space-3)',
                whiteSpace: 'pre-wrap',
                fontSize: 'var(--fs-subheadline)',
                lineHeight: 1.5,
              }}
            >
              {document.markdown}
            </div>
            <label style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
              <input
                type="checkbox"
                checked={accepted[document.slug] === true}
                onChange={(event) =>
                  setAccepted((current) => ({ ...current, [document.slug]: event.target.checked }))
                }
              />
              <span>I have reviewed and accept version {document.version}.</span>
            </label>
          </section>
        ))}
      </div>
      {errorMessage ? <p style={{ color: 'var(--sell-red)' }}>{errorMessage}</p> : null}
      <button
        className="button-primary"
        disabled={!allAccepted || isLoading}
        onClick={() => void store.acceptRequiredLegal()}
      >
        {isLoading ? 'Recording acceptance…' : 'Accept and Continue'}
      </button>
    </div>
  );
}
