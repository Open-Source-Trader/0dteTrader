import { useState } from 'react';
import type { ReactNode } from 'react';
import { useContainer } from '../../app/container';
import { checkServerHealth } from '../../core/api/ServerConfigStore';
import type { HealthCheckResult } from '../../core/api/ServerConfigStore';
import { useStore } from '../../core/observable';
import { Spinner } from '../../design/components/Spinner';

/** One-click backend template (#59). Updated when the final template publishes. */
export const RAILWAY_DEPLOY_URL = 'https://railway.com/deploy/hqwdS8';

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Server picker on the login screen: shows the current API host and, expanded,
 * lets a self-hoster paste their own backend URL, probe /v1/health, and save
 * it (the container is rebuilt from ServerConfigStore, so login immediately
 * uses the new URL). Thin by design — validation and the health probe live in
 * ServerConfigStore where they are unit tested.
 */
export function ServerSettings() {
  const { serverConfigStore } = useContainer();
  const { baseUrl } = useStore(serverConfigStore);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(baseUrl);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);

  const toggle = () => {
    setExpanded(!expanded);
    setDraft(baseUrl);
    setSaveError(null);
    setHealth(null);
  };

  const testConnection = async () => {
    if (isChecking) return;
    setIsChecking(true);
    setHealth(null);
    setHealth(await checkServerHealth(draft));
    setIsChecking(false);
  };

  const save = () => {
    try {
      // Rebuilds the app container via main.tsx; the remounted login screen
      // shows the new host in the collapsed row.
      serverConfigStore.save(draft);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  let status: ReactNode = ' ';
  if (saveError) status = saveError;
  else if (isChecking) status = <Spinner size={14} />;
  else if (health) status = `${health.ok ? '✓' : '✗'} ${health.message}`;

  const secondaryButtonStyle = {
    fontSize: 'var(--fs-footnote)',
    color: 'var(--app-accent)',
    minHeight: 32,
    padding: '0 var(--space-3)',
  } as const;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-2)',
        paddingBottom: 'var(--space-2)',
      }}
    >
      <button
        type="button"
        className="text-secondary"
        aria-expanded={expanded}
        style={{ fontSize: 'var(--fs-footnote)', minHeight: 32, padding: '0 var(--space-4)' }}
        onClick={toggle}
      >
        Server: {hostLabel(baseUrl)} <span style={{ color: 'var(--app-accent)' }}>Edit</span>
      </button>

      {expanded ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            alignSelf: 'stretch',
          }}
        >
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
              color:
                saveError || health?.ok === false ? 'var(--pnl-negative)' : 'var(--pnl-positive)',
            }}
          >
            {status}
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-3)' }}>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => void testConnection()}
            >
              Test connection
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={save}>
              Save
            </button>
            <button
              type="button"
              className="text-secondary"
              style={{ ...secondaryButtonStyle, color: undefined }}
              onClick={() => serverConfigStore.reset()}
            >
              Reset to default
            </button>
          </div>

          <p
            className="text-secondary"
            style={{ fontSize: 'var(--fs-caption)', textAlign: 'center', margin: 0 }}
          >
            No backend yet?{' '}
            <a
              href={RAILWAY_DEPLOY_URL}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--app-accent)' }}
            >
              Deploy on Railway
            </a>{' '}
            — deploy your own in one click, then paste its URL here.
          </p>
        </div>
      ) : null}
    </div>
  );
}
