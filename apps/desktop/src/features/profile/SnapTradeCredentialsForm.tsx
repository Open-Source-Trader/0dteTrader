import { useState } from 'react';
import type { TradingMode } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { Spinner } from '../../design/components/Spinner';
import { XCircleFillIcon } from '../../design/icons';
import { useProfileStore } from './useProfileStore';

type Field = 'clientId' | 'consumerKey';

/** Write-only SnapTrade Personal client ID / consumer key entry for one
 *  environment; stored values are never shown. This is the user's own
 *  SnapTrade identity (docs.snaptrade.com/docs/personal-vs-commercial) —
 *  0dteTrader never mints or holds a SnapTrade identity on their behalf. */
export function SnapTradeCredentialsForm({ environment }: { environment: TradingMode }) {
  const store = useProfileStore();
  const state = useStore(store);
  const { clientId, consumerKey, isSaving } = state.snaptradeKey[environment];
  const canSave = store.canSaveSnapTradeKey(environment) && !isSaving;
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
          name={`${environment}-snaptrade-${field}`}
          className={inputClassName}
          type={inputType}
          placeholder="Required"
          autoComplete="off"
          spellCheck={false}
          required
          value={value}
          onChange={(event) => store.setSnapTradeKeyField(environment, field, event.target.value)}
        />
        {value !== '' ? (
          <button
            type="button"
            className="clear-field"
            aria-label={`Clear ${envTitle} ${label}`}
            onClick={() => store.setSnapTradeKeyField(environment, field, '')}
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
        if (canSave) void store.saveSnapTradeKey(environment);
      }}
    >
      {renderField('clientId', `st-${environment}-client-id`, 'Client ID', clientId)}
      {renderField('consumerKey', `st-${environment}-consumer-key`, 'Consumer Key', consumerKey)}
      <div className="grouped-row footnote" style={{ color: 'var(--text-secondary)' }}>
        Create a free Personal client ID and consumer key in your own SnapTrade Dashboard —
        0dteTrader never sees or stores your brokerage login.
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
