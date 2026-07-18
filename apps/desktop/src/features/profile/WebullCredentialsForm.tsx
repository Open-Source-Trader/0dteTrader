import { useStore } from '../../core/observable';
import { Spinner } from '../../design/components/Spinner';
import type { ProfileStore } from './ProfileStore';

/** Write-only Webull credential entry; stored values are never shown. */
export function WebullCredentialsForm({ store }: { store: ProfileStore }) {
  const { appKey, appSecret, accountId, isSavingCredentials } = useStore(store);
  const canSave = store.canSaveCredentials && !isSavingCredentials;

  return (
    <>
      <div className="grouped-row">
        <input
          type="password"
          placeholder="App Key"
          autoComplete="off"
          spellCheck={false}
          value={appKey}
          onChange={(event) => store.setField('appKey', event.target.value)}
        />
      </div>
      <div className="grouped-row">
        <input
          type="password"
          placeholder="App Secret"
          autoComplete="off"
          spellCheck={false}
          value={appSecret}
          onChange={(event) => store.setField('appSecret', event.target.value)}
        />
      </div>
      <div className="grouped-row">
        <input
          type="password"
          placeholder="Account ID"
          autoComplete="off"
          spellCheck={false}
          value={accountId}
          onChange={(event) => store.setField('accountId', event.target.value)}
        />
      </div>
      <button
        className="grouped-row button-row"
        style={{ opacity: canSave ? 1 : 0.4 }}
        disabled={!canSave}
        onClick={() => void store.saveCredentials()}
      >
        {isSavingCredentials ? <Spinner size={14} /> : 'Save Credentials'}
      </button>
    </>
  );
}
