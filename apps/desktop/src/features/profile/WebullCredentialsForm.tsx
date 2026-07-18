import { useState } from 'react';
import { useStore } from '../../core/observable';
import { Spinner } from '../../design/components/Spinner';
import type { ProfileStore } from './ProfileStore';

/** Write-only Webull credential entry; stored values are never shown. */
export function WebullCredentialsForm({ store }: { store: ProfileStore }) {
  const { appKey, appSecret, accountId, isSavingCredentials } = useStore(store);
  const canSave = store.canSaveCredentials && !isSavingCredentials;
  const [reveal, setReveal] = useState(false);
  const inputType = reveal ? 'text' : 'password';
  const inputClassName = `secret-input${reveal ? ' revealed' : ''}`;

  return (
    <form
      className="credentials-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void store.saveCredentials();
      }}
    >
      <div className="grouped-row">
        <label className="credential-label" htmlFor="wb-app-key">
          App Key
        </label>
        <input
          id="wb-app-key"
          name="appKey"
          className={inputClassName}
          type={inputType}
          placeholder="Required"
          autoComplete="off"
          spellCheck={false}
          required
          value={appKey}
          onChange={(event) => store.setField('appKey', event.target.value)}
        />
      </div>
      <div className="grouped-row">
        <label className="credential-label" htmlFor="wb-app-secret">
          App Secret
        </label>
        <input
          id="wb-app-secret"
          name="appSecret"
          className={inputClassName}
          type={inputType}
          placeholder="Required"
          autoComplete="off"
          spellCheck={false}
          required
          value={appSecret}
          onChange={(event) => store.setField('appSecret', event.target.value)}
        />
      </div>
      <div className="grouped-row">
        <label className="credential-label" htmlFor="wb-account-id">
          Account ID
        </label>
        <input
          id="wb-account-id"
          name="accountId"
          className={inputClassName}
          type={inputType}
          placeholder="Required"
          autoComplete="off"
          spellCheck={false}
          required
          value={accountId}
          onChange={(event) => store.setField('accountId', event.target.value)}
        />
      </div>
      <button
        type="button"
        className="grouped-row button-row footnote"
        onClick={() => setReveal((value) => !value)}
      >
        {reveal ? 'Hide values' : 'Show values'}
      </button>
      <button type="submit" className="grouped-row button-row" disabled={!canSave}>
        {isSavingCredentials ? <Spinner size={14} /> : 'Save Credentials'}
      </button>
    </form>
  );
}
