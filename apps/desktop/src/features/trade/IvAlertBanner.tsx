import type { IVAlert } from '@0dtetrader/shared-types';

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function alertTime(timestamp: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  }).format(new Date(timestamp));
}

export function IvAlertBanner({ alert, onDismiss }: { alert: IVAlert; onDismiss: () => void }) {
  const direction = alert.direction === 'expansion' ? 'IV expansion' : 'IV crush';
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'absolute',
        zIndex: 100,
        top: 8,
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: 'calc(100% - 32px)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 10px 9px 14px',
        border: '1px solid color-mix(in srgb, var(--accent) 65%, transparent)',
        borderRadius: 6,
        background: 'var(--app-surface)',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.3)',
        color: 'var(--label-primary)',
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-caption1)',
        pointerEvents: 'auto',
      }}
    >
      <span>
        <strong>{alert.symbol}</strong> {direction} · ATM IV {percent(alert.currentIv)} · baseline{' '}
        {percent(alert.baselineIv)} · {alertTime(alert.timestamp)} ET
      </span>
      <button
        type="button"
        aria-label={`Dismiss ${alert.symbol} IV alert`}
        onClick={onDismiss}
        style={{
          flex: 'none',
          width: 28,
          height: 28,
          border: 0,
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--label-secondary)',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}
