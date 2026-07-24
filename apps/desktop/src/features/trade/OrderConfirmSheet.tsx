import { useEffect } from 'react';
import { useStore } from '../../core/observable';
import { sideDisplayName } from '../../core/models/domain';
import { Sheet } from '../../design/components/Sheet';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { WarningIcon } from '../../design/icons';
import type { ArmedOrderTicket, TradeStore } from './TradeStore';

interface OrderConfirmSheetProps {
  tradeStore: TradeStore;
  ticket: ArmedOrderTicket;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span>{label}</span>
      <span className="text-secondary numeric">{value}</span>
    </div>
  );
}

/** Arm-then-confirm sheet: server-resolved preview, then submit. */
export function OrderConfirmSheet({ tradeStore, ticket }: OrderConfirmSheetProps) {
  const { preview, isPreviewLoading, previewError, isSubmitting } = useStore(tradeStore);
  const sideColor = ticket.side === 'buy' ? 'var(--buy-green-fill)' : 'var(--sell-red-fill)';
  const confirmEnabled = preview !== null && !isSubmitting && !isPreviewLoading;

  // Desktop: Enter confirms (unless focus is on a button, which handles its
  // own Enter); Sheet itself owns Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && confirmEnabled && !(event.target instanceof HTMLButtonElement)) {
        void tradeStore.confirmArmedOrder();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmEnabled, tradeStore]);

  let previewSection;
  if (isPreviewLoading) {
    // Skeleton rows mirror the resolved layout: no jump when the
    // preview lands.
    previewSection = (
      <>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span
              style={{
                width: 88 + i * 12,
                height: 14,
                borderRadius: 4,
                background: 'var(--app-surface-elevated)',
                animation: 'spinner-pulse 1200ms ease-in-out infinite',
              }}
            />
            <span
              style={{
                width: 64,
                height: 14,
                borderRadius: 4,
                background: 'var(--app-surface-elevated)',
                animation: 'spinner-pulse 1200ms ease-in-out infinite',
              }}
            />
          </div>
        ))}
      </>
    );
  } else if (preview) {
    previewSection = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>Contract</span>
          <span className="text-secondary numeric">{preview.resolved.contractSymbol}</span>
        </div>
        <DetailRow label="Est. price" value={Format.price(preview.resolved.price)} />
        <DetailRow
          label="Est. buying power"
          value={Format.price(preview.resolved.estBuyingPower)}
        />
        {preview.warnings.map((warning) => (
          <div
            key={warning}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              fontSize: 'var(--fs-footnote)',
              color: 'var(--warning-orange)',
            }}
          >
            <WarningIcon size={13} style={{ marginTop: 2 }} />
            <span>{warning}</span>
          </div>
        ))}
      </>
    );
  } else {
    previewSection = null;
  }

  return (
    <Sheet
      detent="medium"
      // Never dismiss mid-submission: the order may still fill.
      onDismiss={() => {
        if (!isSubmitting) tradeStore.cancelArmedOrder();
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
          padding: '0 20px 12px',
          background: 'var(--app-background)',
          overflowY: 'auto',
        }}
        className="hide-scrollbar"
      >
        <div
          style={{
            width: 40,
            height: 5,
            borderRadius: 3,
            background: 'var(--app-border)',
            marginTop: 8,
            flex: 'none',
          }}
        />

        <span style={{ fontSize: 'var(--fs-title3)', fontWeight: 700 }}>
          Confirm {sideDisplayName(ticket.side)}
        </span>

        <span
          className="text-secondary"
          style={{ fontSize: 'var(--fs-subheadline)', textAlign: 'center' }}
        >
          {ticket.summary}
        </span>

        <div
          aria-live="polite"
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 16,
            background: 'var(--app-surface)',
            border: `1px solid color-mix(in srgb, ${sideColor} 55%, transparent)`,
            boxShadow: `0 0 10px color-mix(in srgb, ${sideColor} 25%, transparent)`,
            borderRadius: 'var(--radius-button)',
          }}
        >
          <DetailRow label="Quantity" value={String(ticket.request.quantity)} />
          <DetailRow
            label="Order type"
            value={ticket.request.orderType === 'mid' ? 'Limit at mid' : 'Market'}
          />

          {previewSection}

          {previewError ? (
            <>
              <span
                role="alert"
                style={{
                  fontSize: 'var(--fs-footnote)',
                  color: 'var(--pnl-negative)',
                  textAlign: 'center',
                }}
              >
                {previewError}
              </span>
              <button
                style={{
                  fontSize: 'var(--fs-footnote)',
                  color: 'var(--app-accent)',
                  alignSelf: 'center',
                }}
                // Retry the action that actually failed: a submit failure
                // resubmits, a preview failure re-fetches the preview.
                onClick={() =>
                  void (preview ? tradeStore.confirmArmedOrder() : tradeStore.loadPreview())
                }
              >
                {preview ? 'Retry order' : 'Retry'}
              </button>
            </>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 12, width: '100%', marginTop: 'auto' }}>
          <button
            style={{
              flex: 1,
              minHeight: 'var(--h-trade-button)',
              borderRadius: 'var(--radius-button)',
              border: '1px solid color-mix(in srgb, var(--app-accent) 45%, transparent)',
              color: 'var(--app-accent)',
              fontSize: 'var(--fs-body)',
              opacity: isSubmitting ? 'var(--disabled-opacity)' : 1,
            }}
            disabled={isSubmitting}
            onClick={() => tradeStore.cancelArmedOrder()}
          >
            Cancel
          </button>
          <button
            className="trade-action-button"
            style={{
              background: sideColor,
              opacity: confirmEnabled || isSubmitting ? 1 : 'var(--disabled-opacity)',
            }}
            disabled={!confirmEnabled}
            onClick={() => void tradeStore.confirmArmedOrder()}
          >
            {isSubmitting ? (
              <Spinner white />
            ) : (
              `${sideDisplayName(ticket.side)} ${ticket.request.quantity} · ~${
                preview ? Format.price(preview.resolved.price) : '—'
              }`
            )}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
