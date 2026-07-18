import { CheckCircleFillIcon, InfoCircleFillIcon, WarningFillIcon } from '../../design/icons';
import type { Toast } from './TradeStore';

const TINTS = {
  success: 'var(--pnl-positive)',
  error: 'var(--pnl-negative)',
  info: 'var(--app-accent)',
};

/** Result banner for order submissions and stream events. */
export function ToastView({ toast }: { toast: Toast }) {
  const tint = TINTS[toast.style];
  const Icon =
    toast.style === 'success'
      ? CheckCircleFillIcon
      : toast.style === 'error'
        ? WarningFillIcon
        : InfoCircleFillIcon;
  return (
    <div className="toast" key={toast.id}>
      <div className="toast-capsule" style={{ borderColor: `color-mix(in srgb, ${tint} 60%, transparent)` }}>
        <span style={{ color: tint, display: 'flex' }}>
          <Icon size={14} />
        </span>
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
