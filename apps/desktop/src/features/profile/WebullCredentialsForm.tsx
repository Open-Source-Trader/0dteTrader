import { useState } from 'react';
import type { TradingMode } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { Spinner } from '../../design/components/Spinner';
import { XCircleFillIcon } from '../../design/icons';
import type { ProfileStore } from './ProfileStore';

type Field = 'appKey' | 'appSecret';

/** Write-only Webull credential entry for one environment; stored values are never shown. */
export function WebullCredentialsForm({
  store,
  environment,
}: {
  store: ProfileStore;
  environment: TradingMode;
}) {
  const state = useStore(store);
  const { appKey, appSecret, isSaving } = state[environment];
  const canSave = store.canSaveCredentials(environment) && !isSaving;
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
          name={`${environment}-${field}`}
          className={inputClassName}
          type={inputType}
          placeholder="Required"
          autoComplete="off"
          spellCheck={false}
          required
          value={value}
          onChange={(event) => store.setField(environment, field, event.target.value)}
        />
        {value !== '' ? (
          <button
            type="button"
            className="clear-field"
            aria-label={`Clear ${envTitle} ${label}`}
            onClick={() => store.setField(environment, field, '')}
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
        if (canSave) void store.saveCredentials(environment);
      }}
    >
      {renderField('appKey', `wb-${environment}-app-key`, 'App Key', appKey)}
      {renderField('appSecret', `wb-${environment}-app-secret`, 'App Secret', appSecret)}
      <div className="grouped-row footnote" style={{ color: 'var(--text-secondary)' }}>
        Your account is detected automatically after you approve the connection in the Webull app.
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
