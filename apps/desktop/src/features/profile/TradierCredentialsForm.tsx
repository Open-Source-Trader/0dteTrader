import { useState } from 'react';
import type { TradingMode } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { Spinner } from '../../design/components/Spinner';
import { XCircleFillIcon } from '../../design/icons';
import type { ProfileStore } from './ProfileStore';

/** Write-only Tradier API key entry for one environment; the stored key is
 *  never shown. Tradier auth is a single bearer token — one field. */
export function TradierCredentialsForm({
  store,
  environment,
}: {
  store: ProfileStore;
  environment: TradingMode;
}) {
  const state = useStore(store);
  const { apiKey, isSaving } = state.tradier[environment];
  const canSave = store.canSaveTradier(environment) && !isSaving;
  const [reveal, setReveal] = useState(false);
  const envTitle = environment === 'live' ? 'Live' : 'Practice';
  const id = `tr-${environment}-api-key`;

  return (
    <form
      className="credentials-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void store.saveTradierCredentials(environment);
      }}
    >
      <div className="grouped-row">
        <label className="credential-label" htmlFor={id}>
          API Key
        </label>
        <div className="credential-field">
          <input
            id={id}
            name={`${environment}-tradier-apiKey`}
            className={`secret-input${reveal ? ' revealed' : ''}`}
            type={reveal ? 'text' : 'password'}
            placeholder="Required"
            autoComplete="off"
            spellCheck={false}
            required
            value={apiKey}
            onChange={(event) => store.setTradierApiKey(environment, event.target.value)}
          />
          {apiKey !== '' ? (
            <button
              type="button"
              className="clear-field"
              aria-label={`Clear ${envTitle} API Key`}
              onClick={() => store.setTradierApiKey(environment, '')}
            >
              <XCircleFillIcon size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="grouped-row button-row footnote"
        onClick={() => setReveal((value) => !value)}
      >
        {reveal ? 'Hide value' : 'Show value'}
      </button>
      <button type="submit" className="grouped-row button-row" disabled={!canSave}>
        {isSaving ? <Spinner size={14} /> : 'Save API Key'}
      </button>
    </form>
  );
}
