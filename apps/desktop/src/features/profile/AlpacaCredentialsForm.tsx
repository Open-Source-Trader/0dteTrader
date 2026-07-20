import { useState } from 'react';
import type { TradingMode } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { Spinner } from '../../design/components/Spinner';
import { XCircleFillIcon } from '../../design/icons';
import type { ProfileStore } from './ProfileStore';

type Field = 'apiKey' | 'apiSecret';

/** Write-only Alpaca credential entry for one environment; stored values are never shown.
 *  Alpaca v2 is key-scoped, so there is no account id to discover. */
export function AlpacaCredentialsForm({
  store,
  environment,
}: {
  store: ProfileStore;
  environment: TradingMode;
}) {
  const state = useStore(store);
  const { apiKey, apiSecret, isSaving } = state.alpaca[environment];
  const canSave = store.canSaveAlpaca(environment) && !isSaving;
  const [reveal, setReveal] = useState(false);
  const inputType = reveal ? 'text' : 'password';
  const inputClassName = `secret-input${reveal ? ' revealed' : ''}`;
  const envTitle = environment === 'live' ? 'Live' : 'Practice';

  const renderField = (field: Field, id: string, label: string, value: string) => (
    <div className="grouped-row">
      <label className="credential-label" htmlFor={id}>
        {label}
      </label>
      <div className="credential-field">
        <input
          id={id}
          name={`${environment}-alpaca-${field}`}
          className={inputClassName}
          type={inputType}
          placeholder="Required"
          autoComplete="off"
          spellCheck={false}
          required
          value={value}
          onChange={(event) => store.setAlpacaField(environment, field, event.target.value)}
        />
        {value !== '' ? (
          <button
            type="button"
            className="clear-field"
            aria-label={`Clear ${envTitle} ${label}`}
            onClick={() => store.setAlpacaField(environment, field, '')}
          >
            <XCircleFillIcon size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <form
      className="credentials-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void store.saveAlpacaCredentials(environment);
      }}
    >
      {renderField('apiKey', `ap-${environment}-api-key`, 'API Key', apiKey)}
      {renderField('apiSecret', `ap-${environment}-api-secret`, 'API Secret', apiSecret)}
      <div className="grouped-row footnote" style={{ color: 'var(--text-secondary)' }}>
        Alpaca is key-scoped: the key/secret identify your account, so no account id is needed.
      </div>
      <button
        type="button"
        className="grouped-row button-row footnote"
        onClick={() => setReveal((value) => !value)}
      >
        {reveal ? 'Hide values' : 'Show values'}
      </button>
      <button type="submit" className="grouped-row button-row" disabled={!canSave}>
        {isSaving ? <Spinner size={14} /> : 'Save Credentials'}
      </button>
    </form>
  );
}
