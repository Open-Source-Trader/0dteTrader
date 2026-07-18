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
      <span className="text-secondary">{value}</span>
    </div>
  );
}

/** Arm-then-confirm sheet: server-resolved preview, then submit. */
export function OrderConfirmSheet({ tradeStore, ticket }: OrderConfirmSheetProps) {
  const { preview, isPreviewLoading, previewError, isSubmitting } = useStore(tradeStore);
  const sideColor = ticket.side === 'buy' ? 'var(--buy-green)' : 'var(--sell-red)';
  const confirmEnabled = preview !== null && !isSubmitting && !isPreviewLoading;

  return (
    <Sheet detent="medium" onDismiss={() => tradeStore.cancelArmedOrder()}>
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
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 16,
            background: 'var(--app-surface)',
            borderRadius: 'var(--radius-button)',
          }}
        >
          <DetailRow label="Quantity" value={String(ticket.request.quantity)} />
          <DetailRow
            label="Order type"
            value={ticket.request.orderType === 'mid' ? 'Limit at mid' : 'Market'}
          />

          {isPreviewLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner size={14} />
              <span className="text-secondary" style={{ fontSize: 'var(--fs-footnote)' }}>
                Resolving contract…
              </span>
            </div>
          ) : preview ? (
            <>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  fontSize: 'var(--fs-subheadline)',
                }}
              >
                <span>Contract</span>
                <span className="text-secondary">{preview.resolved.contractSymbol}</span>
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
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 'var(--fs-footnote)',
                    color: 'var(--warning-orange)',
                  }}
                >
                  <WarningIcon size={13} />
                  <span>{warning}</span>
                </div>
              ))}
            </>
          ) : null}

          {previewError ? (
            <>
              <span
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
                onClick={() => void tradeStore.loadPreview()}
              >
                Retry
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
            }}
            onClick={() => tradeStore.cancelArmedOrder()}
          >
            Cancel
          </button>
          <button
            style={{
              flex: 1,
              minHeight: 'var(--h-trade-button)',
              borderRadius: 'var(--radius-button)',
              background: sideColor,
              opacity: confirmEnabled ? 1 : 0.35,
              color: '#fff',
              fontSize: 'var(--fs-headline)',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            disabled={!confirmEnabled}
            onClick={() => void tradeStore.confirmArmedOrder()}
          >
            {isSubmitting ? <Spinner white /> : `Confirm ${sideDisplayName(ticket.side)}`}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
