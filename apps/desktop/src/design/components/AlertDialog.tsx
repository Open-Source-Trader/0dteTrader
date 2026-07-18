export interface AlertAction {
  label: string;
  role?: 'destructive' | 'cancel';
  onSelect?: () => void;
}

interface AlertDialogProps {
  title: string;
  message?: string;
  actions: AlertAction[];
  onDismiss: () => void;
}

/** Centered iOS-style alert (270px card, hairline-separated buttons). */
export function AlertDialog({ title, message, actions, onDismiss }: AlertDialogProps) {
  return (
    <div className="alert-backdrop">
      <div className="alert-card">
        <div className="alert-title">{title}</div>
        {message ? <div className="alert-message">{message}</div> : null}
        {actions.map((action) => (
          <button
            key={action.label}
            className={`alert-button ${action.role ?? ''}`}
            onClick={() => {
              onDismiss();
              action.onSelect?.();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
