import { useState } from 'react';
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

const STEP_TITLES: Record<Step, string> = {
  choose: 'Choose Your Server',
  connect: 'My Railway Backend',
  deploy: 'Deploy a Backend',
};

interface ServerSelectViewProps {
  onDismiss: () => void;
  /** Called once a server is chosen. `serverChanged` is true when the base URL
      actually changed (which rebuilds the app container and remounts the
      login screen), so the caller knows whether its local state survives. */
  onContinue: (serverChanged: boolean) => void;
}

/**
 * Full-height server picker shown before account creation (and from the
 * "Server: … · Change" link on the login screen). Three options: the built-in
 * default backend, connecting an existing self-hosted backend, or deploying a
 * new one on Railway. Thin by design — URL validation and the health probe
 * live in ServerConfigStore where they are unit tested.
 */
export function ServerSelectView({ onDismiss, onContinue }: ServerSelectViewProps) {
  const { serverConfigStore } = useContainer();
  const { baseUrl } = useStore(serverConfigStore);
  const [step, setStep] = useState<Step>('choose');

  const isDefault = baseUrl === DEFAULT_API_BASE_URL;

  const useDefault = () => {
    const changed = !isDefault;
    serverConfigStore.reset();
    onContinue(changed);
  };

  return (
    <Sheet detent="large" onDismiss={onDismiss}>
      <NavBar
        title={STEP_TITLES[step]}
        leading={
          step === 'choose' ? (
            <button className="navbar-text-button" onClick={onDismiss}>
              Cancel
            </button>
          ) : (
            <button className="navbar-text-button" onClick={() => setStep('choose')}>
              Back
            </button>
          )
        }
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
          <>
            <p
              className="text-secondary"
              style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center', margin: 0 }}
            >
              Pick the backend this app connects to.
            </p>

            <ServerCard
              title="Default server"
              description={`Use the built-in backend — ${hostLabel(DEFAULT_API_BASE_URL)}.`}
              selected={isDefault}
              onClick={useDefault}
            />
            <ServerCard
              title="My Railway backend"
              description="Already hosting your own? Connect it."
              selected={!isDefault}
              onClick={() => setStep('connect')}
            />
            <ServerCard
              title="Deploy a new backend"
              description="One click on Railway — free to start."
              onClick={() => setStep('deploy')}
            />
          </>
        ) : null}

        {step === 'connect' ? (
          <>
            <p
              className="text-secondary"
              style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center', margin: 0 }}
            >
              Paste your backend&apos;s URL and test the connection.
            </p>
            <ServerUrlForm onContinue={onContinue} />
          </>
        ) : null}

        {step === 'deploy' ? (
          <>
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
              <li>Copy the api service&apos;s public URL and paste it below.</li>
            </ol>
            <a
              className="button-primary"
              href={RAILWAY_DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'none' }}
            >
              Deploy on Railway
            </a>
            <ServerUrlForm onContinue={onContinue} />
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

function ServerCard({
  title,
  description,
  selected = false,
  onClick,
}: {
  title: string;
  description: string;
  selected?: boolean;
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
    </button>
  );
}

/**
 * Shared URL entry for the connect/deploy steps: field, health probe, and a
 * Continue that persists via ServerConfigStore (which rebuilds the container).
 */
function ServerUrlForm({ onContinue }: { onContinue: (serverChanged: boolean) => void }) {
  const { serverConfigStore } = useContainer();
  const { baseUrl } = useStore(serverConfigStore);
  const [draft, setDraft] = useState(baseUrl === DEFAULT_API_BASE_URL ? '' : baseUrl);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);

  const testConnection = async () => {
    if (isChecking) return;
    setIsChecking(true);
    setHealth(null);
    setHealth(await checkServerHealth(draft));
    setIsChecking(false);
  };

  const save = () => {
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

      <button type="button" className="button-primary" onClick={save}>
        Continue
      </button>
    </div>
  );
}
