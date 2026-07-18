import { CheckCircleFillIcon, InfoCircleFillIcon, WarningFillIcon } from '../../design/icons';
import type { Toast } from './TradeStore';

const TINTS = {
  success: 'var(--pnl-positive)',
  error: 'var(--pnl-negative)',
  info: 'var(--app-accent)',
};

interface ToastViewProps {
  toast: Toast;
  /** Tap-to-dismiss (the toast itself is pointer-events: none by default). */
  onDismiss?: () => void;
}

/** Result banner for order submissions and stream events. */
export function ToastView({ toast, onDismiss }: ToastViewProps) {
  const tint = TINTS[toast.style];
  const Icon =
    toast.style === 'success'
      ? CheckCircleFillIcon
      : toast.style === 'error'
        ? WarningFillIcon
        : InfoCircleFillIcon;
  return (
    <div
      className="toast"
      key={toast.id}
      role={toast.style === 'error' ? 'alert' : 'status'}
      aria-live={toast.style === 'error' ? 'assertive' : 'polite'}
      style={{
        // Float below the NavBar instead of covering its buttons.
        top: 'calc(var(--h-navbar) + 8px)',
        ...(toast.leaving
          ? {
              opacity: 0,
              transform: 'translateY(-12px)',
              transition: 'opacity 200ms ease, transform 200ms ease',
            }
          : null),
      }}
    >
      <div
        className="toast-capsule"
        style={{
          borderColor: `color-mix(in srgb, ${tint} 60%, transparent)`,
          fontVariantNumeric: 'tabular-nums',
          pointerEvents: 'auto',
          cursor: onDismiss ? 'pointer' : undefined,
        }}
        onClick={onDismiss}
      >
        <span style={{ color: tint, display: 'flex' }}>
          <Icon size={14} />
        </span>
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
