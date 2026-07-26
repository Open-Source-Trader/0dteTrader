import { useEffect, useState } from 'react';
import { checkServerHealth } from '../../core/api/ServerConfigStore';

type Status = 'checking' | 'connected' | 'unreachable';

const STATUS_LABEL: Record<Status, string> = {
  checking: 'Checking Backend…',
  connected: 'Backend Connected',
  unreachable: 'Backend Unreachable',
};

const STATUS_COLOR: Record<Status, string> = {
  checking: 'var(--app-warning)',
  connected: 'var(--pnl-positive)',
  unreachable: 'var(--pnl-negative)',
};

/**
 * Login-footer backend indicator: a status light + label, with the server
 * picker's Change affordance beneath. Probes /v1/health on mount and whenever
 * the active server changes; clicking the light re-checks.
 */
export function BackendStatus({ baseUrl, onChange }: { baseUrl: string; onChange: () => void }) {
  const [status, setStatus] = useState<Status>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('checking');
    void checkServerHealth(baseUrl).then((result) => {
      if (!cancelled) setStatus(result.ok ? 'connected' : 'unreachable');
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, attempt]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-1)',
      }}
    >
      <button
        type="button"
        className="text-secondary"
        title={`${hostFromUrl(baseUrl)} — click to check again`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          fontSize: 'var(--fs-footnote)',
          minHeight: 24,
          padding: '0 var(--space-3)',
        }}
        onClick={() => setAttempt((n) => n + 1)}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: STATUS_COLOR[status],
            boxShadow: `0 0 6px ${STATUS_COLOR[status]}`,
            transition: 'background 200ms, box-shadow 200ms',
          }}
        />
        {STATUS_LABEL[status]}
      </button>
      <button
        type="button"
        style={{
          fontSize: 'var(--fs-footnote)',
          color: 'var(--app-accent)',
          minHeight: 28,
          padding: '0 var(--space-3)',
        }}
        onClick={onChange}
      >
        Change
      </button>
    </div>
  );
}

function hostFromUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
