import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../core/observable';
import { orderPricingDescription, sideDisplayName } from '../../core/models/domain';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { WarningIcon } from '../../design/icons';
import type { ArmedOrderTicket, TradeStore } from './TradeStore';

interface OrderConfirmPopupProps {
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

/**
 * Arm-then-confirm popup: server-resolved preview, then submit.
 *
 * Wears the same HUD chrome as the ticker, timeframe, indicator, tools, strike
 * and expiration popups, but centered on screen rather than anchored to a
 * trigger — the only one of them that is not a picker, and the difference is
 * load-bearing:
 *
 * - Nothing here confirms except the Confirm button. The scrim and Escape both
 *   route to `cancel`.
 * - It is genuinely modal: an opaque-to-clicks scrim over the whole frame (so
 *   SELL/BUY cannot be reached behind it), `aria-modal`, focus moved into the
 *   panel and Tab trapped inside it.
 * - Neither closes mid-submission. The order may still fill, and its result
 *   lands here.
 * - Centered rather than anchored to the SELL/BUY row that armed it: it reads
 *   as interrupting the whole screen, and it still covers the two buttons that
 *   must not be reachable while a ticket is armed.
 */
export function OrderConfirmPopup({ tradeStore, ticket }: OrderConfirmPopupProps) {
  const { preview, isPreviewLoading, previewError, isSubmitting } = useStore(tradeStore);
  const sideColor = ticket.side === 'buy' ? 'var(--buy-green-fill)' : 'var(--sell-red-fill)';
  const confirmEnabled = preview !== null && !isSubmitting && !isPreviewLoading;

  const panelRef = useRef<HTMLDivElement>(null);

  /** Tapping away cancels; it never confirms, and it never interrupts a submit. */
  const cancel = useCallback(() => {
    if (!isSubmitting) tradeStore.cancelArmedOrder();
  }, [isSubmitting, tradeStore]);

  // Focus lands on Cancel, not on Confirm: the destructive-by-default key press
  // on an order dialog should be the harmless one.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  // Escape cancels; Enter confirms (unless focus is on a button, which handles
  // its own Enter); Tab cycles inside the panel and never behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key === 'Enter' && confirmEnabled && !(event.target instanceof HTMLButtonElement)) {
        void tradeStore.confirmArmedOrder();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, confirmEnabled, tradeStore]);

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
        <DetailRow
          label="Bid / Ask"
          value={`${Format.price(preview.resolved.bid)} / ${Format.price(preview.resolved.ask)}`}
        />
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

  const target = typeof document !== 'undefined' ? document.querySelector('.phone-content') : null;
  if (!target) return null;

  return createPortal(
    <>
      {/* Near-invisible, but it takes every click in the frame — including the
          two buttons directly under the panel. */}
      <div
        data-order-confirm-scrim
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 'var(--z-menu)',
          background: 'rgba(0, 0, 0, 0.001)',
        }}
        onPointerDown={cancel}
      />
      <div
        ref={panelRef}
        className="menu-dropdown order-confirm-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Confirm ${sideDisplayName(ticket.side)}`}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            padding: '16px 20px',
          }}
        >
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
              value={orderPricingDescription(ticket.request.orderType)}
            />
            {/* With a typed price this popup is the last place a wrong number
                can be caught, so it prints the number as entered rather than
                only the server's resolved price — and the spread beside it,
                since a premium with nothing to compare it to catches nothing. */}
            {ticket.request.limitPrice !== undefined ? (
              <DetailRow label="Your limit" value={Format.price(ticket.request.limitPrice)} />
            ) : null}

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

          <div style={{ display: 'flex', gap: 12, width: '100%' }}>
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
      </div>
    </>,
    target,
  );
}
