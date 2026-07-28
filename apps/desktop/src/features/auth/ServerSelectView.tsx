import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_API_BASE_URL } from '../../app/config';
import { useContainer } from '../../app/container';
import { checkServerHealth } from '../../core/api/ServerConfigStore';
import type { HealthCheckResult } from '../../core/api/ServerConfigStore';
import { useStore } from '../../core/observable';
import { NavBar } from '../../design/components/NavBar';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { hostLabel, RAILWAY_DEPLOY_URL } from './serverSelect';

type Step = 'choose' | 'connect' | 'deploy';
export type ServerSelectMode = 'setup' | 'manage';

const STEP_TITLES: Record<Step, string> = {
  choose: 'Choose Your Server',
  connect: 'Connect a Backend',
  deploy: 'Deploy a Backend',
};

export interface ServerSelectViewProps {
  mode?: ServerSelectMode;
  prefillUrl?: string | null;
  onDismiss?: () => void;
  /** Called once a server is chosen. `serverChanged` is true when the base URL
      actually changed (which rebuilds the app container and remounts the
      login screen), so the caller knows whether its local state survives. */
  onContinue: (serverChanged: boolean) => void;
}

/**
 * Full-height server picker shown on first run and from desktop shell actions.
 * Three options: the built-in default backend, connecting an existing hosted
 * backend, or deploying a new one on Railway.
 */
export function ServerSelectView({
  mode = 'manage',
  prefillUrl = null,
  onDismiss,
  onContinue,
}: ServerSelectViewProps) {
  const { serverConfigStore } = useContainer();
  const { baseUrl } = useStore(serverConfigStore);
  const [step, setStep] = useState<Step>(prefillUrl ? 'connect' : 'choose');

  const isDefault = baseUrl === DEFAULT_API_BASE_URL;
  const currentHost = hostLabel(baseUrl);

  const useDefault = () => {
    const changed = !isDefault;
    serverConfigStore.reset();
    onContinue(changed);
  };

  let leading: ReactNode = <span />;
  if (step === 'choose' && onDismiss) {
    leading = (
      <button className="navbar-text-button" onClick={onDismiss}>
        Cancel
      </button>
    );
  } else if (step !== 'choose') {
    leading = (
      <button className="navbar-text-button" onClick={() => setStep('choose')}>
        Back
      </button>
    );
  }

  const body = (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <NavBar
        title={mode === 'setup' && step === 'choose' ? 'Connect to a Backend' : STEP_TITLES[step]}
        leading={leading}
      />
      <div
        className="sheet-body hide-scrollbar"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          padding: 'var(--pad-screen)',
          background: 'var(--app-background)',
          overflowY: 'auto',
        }}
      >
        {step === 'choose' ? (
          <div style={{ display: 'contents' }}>
            <p
              className="text-secondary"
              style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center', margin: 0 }}
            >
              {mode === 'setup'
                ? 'Choose the backend this desktop app should use on this device.'
                : `Current backend: ${currentHost}. Pick a different backend or keep using the default server.`}
            </p>

            <ServerCard
              title="Default server"
              description={`Use the built-in backend — ${hostLabel(DEFAULT_API_BASE_URL)}.`}
              selected={isDefault}
              actionLabel={mode === 'setup' ? 'Use default' : undefined}
              onClick={useDefault}
            />
            <ServerCard
              title="My hosted backend"
              description="Already running your own backend? Connect it here."
              selected={!isDefault}
              actionLabel={mode === 'setup' ? 'Connect backend' : undefined}
              onClick={() => setStep('connect')}
            />
            <ServerCard
              title="Deploy a new backend"
              description="Launch the template on Railway, then connect it here."
              actionLabel={mode === 'setup' ? 'Deploy backend' : undefined}
              onClick={() => setStep('deploy')}
            />
          </div>
        ) : null}

        {step === 'connect' ? (
          <div style={{ display: 'contents' }}>
            <p
              className="text-secondary"
              style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center', margin: 0 }}
            >
              Paste your backend URL, test the connection, then continue.
            </p>
            <ServerUrlForm mode={mode} prefillUrl={prefillUrl} onContinue={onContinue} />
          </div>
        ) : null}

        {step === 'deploy' ? (
          <div style={{ display: 'contents' }}>
            <ol
              className="text-secondary"
              style={{
                fontSize: 'var(--fs-subheadline)',
                margin: 0,
                paddingLeft: 'var(--space-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
              }}
            >
              <li>Press Deploy and sign in to Railway.</li>
              <li>Wait for the services to go green.</li>
              <li>Copy the API service&apos;s public URL and paste it below.</li>
            </ol>
            <button
              type="button"
              className="button-primary"
              onClick={() => window.open(RAILWAY_DEPLOY_URL, '_blank', 'noopener,noreferrer')}
            >
              Deploy on Railway
            </button>
            <ServerUrlForm mode={mode} prefillUrl={prefillUrl} onContinue={onContinue} />
          </div>
        ) : null}
      </div>
    </div>
  );

  if (mode === 'setup') {
    return body;
  }

  return (
    <Sheet detent="large" onDismiss={onDismiss ?? (() => {})}>
      {body}
    </Sheet>
  );
}

function ServerCard({
  title,
  description,
  selected = false,
  actionLabel,
  onClick,
}: {
  title: string;
  description: string;
  selected?: boolean;
  actionLabel?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`server-card${selected ? ' selected' : ''}`} onClick={onClick}>
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 'var(--space-2)',
          fontSize: 'var(--fs-headline)',
          fontWeight: 600,
          color: 'var(--label-primary)',
        }}
      >
        {title}
        {selected ? (
          <span
            style={{
              fontSize: 'var(--fs-caption2)',
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: 'var(--app-accent-text)',
            }}
          >
            CURRENT
          </span>
        ) : null}
      </span>
      <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
        {description}
      </span>
      {actionLabel ? (
        <span style={{ fontSize: 'var(--fs-footnote)', color: 'var(--app-accent)' }}>
          {actionLabel}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Shared URL entry for the connect/deploy steps: field, health probe, and a
 * Continue that persists via ServerConfigStore (which rebuilds the container).
 */
function ServerUrlForm({
  mode,
  prefillUrl,
  onContinue,
}: {
  mode: ServerSelectMode;
  prefillUrl: string | null;
  onContinue: (serverChanged: boolean) => void;
}) {
  const { serverConfigStore } = useContainer();
  const { baseUrl } = useStore(serverConfigStore);
  const initialDraft = useMemo(() => {
    if (prefillUrl && prefillUrl !== DEFAULT_API_BASE_URL) return prefillUrl;
    return baseUrl === DEFAULT_API_BASE_URL ? '' : baseUrl;
  }, [baseUrl, prefillUrl]);
  const [draft, setDraft] = useState(initialDraft);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);
  const requiresPassingCheck = mode === 'setup' || draft.trim() !== baseUrl;
  const canContinue = draft.trim() !== '' && (!requiresPassingCheck || health?.ok === true);

  const testConnection = async () => {
    if (isChecking) return;
    setIsChecking(true);
    setHealth(null);
    setHealth(await checkServerHealth(draft));
    setIsChecking(false);
  };

  const save = () => {
    if (!canContinue) return;
    try {
      const saved = serverConfigStore.save(draft);
      onContinue(saved !== baseUrl);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  let status: ReactNode = ' ';
  if (saveError) status = saveError;
  else if (isChecking) status = <Spinner size={14} />;
  else if (health) status = `${health.ok ? '✓' : '✗'} ${health.message}`;
  else if (requiresPassingCheck) status = 'Test your backend before continuing.';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <input
        className="field"
        type="url"
        placeholder="https://your-api.up.railway.app"
        aria-label="Server URL"
        aria-invalid={saveError ? true : undefined}
        autoCapitalize="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaveError(null);
          setHealth(null);
        }}
      />

      {/* Slot is always rendered so status changes don't shift the buttons. */}
      <div
        role="status"
        style={{
          fontSize: 'var(--fs-footnote)',
          textAlign: 'center',
          minHeight: 16,
          color: saveError || health?.ok === false ? 'var(--pnl-negative)' : 'var(--pnl-positive)',
        }}
      >
        {status}
      </div>

      <button
        type="button"
        style={{
          fontSize: 'var(--fs-footnote)',
          color: 'var(--app-accent)',
          alignSelf: 'center',
          minHeight: 32,
          padding: '0 var(--space-3)',
        }}
        onClick={() => void testConnection()}
      >
        Test connection
      </button>

      <button
        type="button"
        className={`button-primary${canContinue ? '' : ' dimmed'}`}
        disabled={!canContinue}
        onClick={save}
      >
        Continue
      </button>
    </div>
  );
}
