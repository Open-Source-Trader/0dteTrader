import { useMemo, useState } from 'react';
import type {
  ChartOrder,
  ChartOrderDraft,
  ChartOrderType,
  OptionContract,
  OrderResult,
  Position,
} from '@0dtetrader/shared-types';
import { AlertDialog } from '../../design/components/AlertDialog';
import { Spinner } from '../../design/components/Spinner';
import { Format } from '../../design/format';
import { ChevronDownIcon, XCircleFillIcon } from '../../design/icons';
import {
  optionTypeShortName,
  orderStatusDisplayName,
  orderTypeDisplayName,
  sideDisplayName,
} from '../../core/models/domain';
import { bracketLegDraft, isWorking } from '../chart/chartOrders';
import { defaultBracketLevel } from './bracketDefaults';
import { selectPositionExpiryBreakEven } from './expiryBreakEven';
import {
  dayPnl,
  moveStopToEntryRequest,
  pnlPercent,
  signedCurrency,
  timeInTrade,
} from './TradeManagementWorkspaceModel';

export type TradeWorkspaceTab = 'positions' | 'orders' | 'recent';

interface TradeManagementWorkspaceProps {
  positions: Position[];
  openOrders: OrderResult[];
  chartOrders: ChartOrder[];
  workingSymbols: string[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClosePosition: (position: Position) => void;
  onTrimPosition: (position: Position) => void;
  onCancelOrder: (order: OrderResult) => void;
  onCancelChartOrder: (order: ChartOrder) => void;
  /** Moves a working chart line to a new level (Move stop to entry). */
  onMoveChartOrder: (order: ChartOrder, triggerPrice: number) => void;
  /** Selects a line on the chart — Edit stop/target hands off to the
   *  existing selection/drag UX rather than growing its own editor. */
  onSelectChartOrder: (order: ChartOrder) => void;
  /** Creates a new bracket leg (Set stop / Set target). */
  onCreateChartOrder: (draft: ChartOrderDraft) => void;
  /** Execution type a new leg inherits — the ticket's, already narrowed. */
  defaultOrderType: ChartOrderType;
  resolveContract: (symbol: string) => OptionContract | null;
  locked?: boolean;
}

interface PositionMeta {
  contract: OptionContract | null;
  label: string;
  expiration: string;
  pnlPercent: number;
  stop: ChartOrder | null;
  target: ChartOrder | null;
  expiryBreakEven: number | null;
  relatedChartOrders: ChartOrder[];
}

/** Tooltip for a disabled "Move stop to entry"; undefined while it is usable. */
function moveStopBlockedReason(
  stop: ChartOrder | null,
  entryPrice: number | undefined,
): string | undefined {
  if (!stop) return 'Set a stop line on the chart first';
  if (entryPrice === undefined) return 'Entry price unknown';
  return undefined;
}

function positionLabel(position: Position, contract: OptionContract | null): string {
  if (!contract) return position.symbol;
  return `${contract.underlying} ${Format.strike(contract.strike)}${optionTypeShortName(contract.optionType)}`;
}

function priceOrDash(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? `$${Format.price(value)}` : '—';
}

function submittedTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function buildPositionMeta(
  position: Position,
  chartOrders: ChartOrder[],
  resolveContract: (symbol: string) => OptionContract | null,
): PositionMeta {
  const contract = resolveContract(position.symbol);
  const workingRelated = chartOrders.filter(
    (order) => isWorking(order) && order.contractSymbol === position.symbol,
  );
  const stop = workingRelated.find((order) => order.kind === 'stop') ?? null;
  const target = workingRelated.find((order) => order.kind === 'target') ?? null;
  return {
    contract,
    label: positionLabel(position, contract),
    expiration: contract?.expiration ?? '—',
    pnlPercent: pnlPercent(position),
    stop,
    target,
    expiryBreakEven: selectPositionExpiryBreakEven({ position, contract }),
    relatedChartOrders: workingRelated,
  };
}

export function TradeManagementWorkspace({
  positions,
  openOrders,
  chartOrders,
  workingSymbols,
  expanded,
  onExpandedChange,
  onClosePosition,
  onTrimPosition,
  onCancelOrder,
  onCancelChartOrder,
  onMoveChartOrder,
  onSelectChartOrder,
  onCreateChartOrder,
  defaultOrderType,
  resolveContract,
  locked = false,
}: TradeManagementWorkspaceProps) {
  const [tab, setTab] = useState<TradeWorkspaceTab>('positions');
  const [positionPendingClose, setPositionPendingClose] = useState<Position | null>(null);
  const [positionPendingTrim, setPositionPendingTrim] = useState<Position | null>(null);
  const [orderPendingCancel, setOrderPendingCancel] = useState<OrderResult | null>(null);
  const [chartOrdersPendingCancel, setChartOrdersPendingCancel] = useState<ChartOrder[] | null>(
    null,
  );
  const metas = useMemo(
    () =>
      new Map(
        positions.map((position) => [
          position.symbol,
          buildPositionMeta(position, chartOrders, resolveContract),
        ]),
      ),
    [positions, chartOrders, resolveContract],
  );
  const activePosition = positions[0] ?? null;
  const activeMeta = activePosition ? metas.get(activePosition.symbol) : null;
  const totalDayPnl = dayPnl(positions);
  const activeWorking = activePosition ? workingSymbols.includes(activePosition.symbol) : false;
  const activeEntryPrice = activePosition?.underlyingEntryPrice;

  // Why a Set stop/target could not create a leg right now; null means it can.
  let legActionBlockedReason: string | null = null;
  if (!activeMeta?.contract) {
    legActionBlockedReason = "Open this contract's chart to manage its lines";
  } else if (activeEntryPrice === undefined) {
    legActionBlockedReason = 'Entry price unknown';
  }

  /** Edit selects the existing line (the chart's selection/drag UX takes it
   *  from there); Set creates the missing OCO leg at its default level. */
  const setOrEditLeg = (kind: 'stop' | 'target') => {
    if (!activePosition || !activeMeta) return;
    const existing = kind === 'stop' ? activeMeta.stop : activeMeta.target;
    if (existing) {
      onSelectChartOrder(existing);
      return;
    }
    const { contract } = activeMeta;
    if (!contract || activeEntryPrice === undefined) return;
    onCreateChartOrder(
      bracketLegDraft({
        contract,
        position: activePosition,
        triggerPrice: defaultBracketLevel(
          kind,
          contract.optionType,
          activePosition.quantity,
          activeEntryPrice,
        ),
        kind,
        orderType: defaultOrderType,
        orders: chartOrders,
      }),
    );
  };

  let expandedBody: React.ReactNode;
  if (tab === 'positions') {
    expandedBody =
      positions.length === 0 ? (
        <div className="desktop-positions-empty text-secondary">No open positions</div>
      ) : (
        <PositionsTable
          positions={positions}
          metas={metas}
          workingSymbols={workingSymbols}
          locked={locked}
          onClose={setPositionPendingClose}
          onTrim={setPositionPendingTrim}
        />
      );
  } else if (tab === 'orders') {
    expandedBody =
      openOrders.length === 0 ? (
        <div className="desktop-positions-empty text-secondary">No working orders</div>
      ) : (
        <OrdersTable orders={openOrders} locked={locked} onCancel={setOrderPendingCancel} />
      );
  } else {
    expandedBody = (
      <div className="desktop-positions-empty text-secondary">
        Recent trades stay in History and do not auto-expand.
      </div>
    );
  }

  return (
    <section
      className={`trade-management-workspace${expanded ? ' is-expanded' : ' is-collapsed'}${positions.length > 0 ? ' has-position' : ''}`}
      aria-label="Trade management workspace"
    >
      {activePosition && activeMeta ? (
        <div className="trade-position-strip" data-testid="active-position-strip">
          <div className="trade-position-strip__identity">
            <span className="numeric trade-position-strip__contract">
              {activeMeta.label} · Qty {Math.abs(activePosition.quantity)}
            </span>
            {activeWorking ? <Spinner size={12} /> : null}
          </div>
          <div
            className={`numeric trade-position-strip__pnl ${activePosition.unrealizedPnl >= 0 ? 'is-positive' : 'is-negative'}`}
          >
            {signedCurrency(activePosition.unrealizedPnl)} ·{' '}
            {Format.signedPrice(activeMeta.pnlPercent, 0)}%
          </div>
          <div className="trade-position-strip__details numeric">
            <span>Entry {priceOrDash(activePosition.avgPrice)}</span>
            <span>Mark {priceOrDash(activePosition.markPrice)}</span>
            <span>Expiry B/E {priceOrDash(activeMeta.expiryBreakEven)}</span>
            <span>Stop {priceOrDash(activeMeta.stop?.triggerPrice)}</span>
            <span>Target {priceOrDash(activeMeta.target?.triggerPrice)}</span>
            <span>Time in trade {timeInTrade(activePosition)}</span>
          </div>
          <div className="trade-position-strip__actions">
            <button
              className="desktop-positions-action desktop-positions-action--danger"
              disabled={locked || activeWorking}
              onClick={() => setPositionPendingClose(activePosition)}
            >
              Close
            </button>
            <button
              className="desktop-positions-action"
              disabled={locked || activeWorking || Math.abs(activePosition.quantity) < 2}
              onClick={() => setPositionPendingTrim(activePosition)}
            >
              Trim 50%
            </button>
            <button
              className="desktop-positions-action"
              disabled={locked || moveStopToEntryRequest(activePosition, activeMeta.stop) === null}
              title={moveStopBlockedReason(activeMeta.stop, activeEntryPrice)}
              onClick={() => {
                const request = moveStopToEntryRequest(activePosition, activeMeta.stop);
                if (request) onMoveChartOrder(request.order, request.triggerPrice);
              }}
            >
              Move stop to entry
            </button>
            <button
              className="desktop-positions-action"
              disabled={locked || (!activeMeta.stop && legActionBlockedReason !== null)}
              title={activeMeta.stop ? undefined : (legActionBlockedReason ?? undefined)}
              onClick={() => setOrEditLeg('stop')}
            >
              {activeMeta.stop ? 'Edit stop' : 'Set stop'}
            </button>
            <button
              className="desktop-positions-action"
              disabled={locked || (!activeMeta.target && legActionBlockedReason !== null)}
              title={activeMeta.target ? undefined : (legActionBlockedReason ?? undefined)}
              onClick={() => setOrEditLeg('target')}
            >
              {activeMeta.target ? 'Edit target' : 'Set target'}
            </button>
            <button
              className="desktop-positions-action"
              disabled={locked || activeMeta.relatedChartOrders.length === 0}
              onClick={() => setChartOrdersPendingCancel(activeMeta.relatedChartOrders)}
            >
              Cancel related orders
            </button>
          </div>
        </div>
      ) : null}

      {expanded ? (
        <div className="trade-management-expanded">
          <div className="desktop-positions-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'positions'}
              className={
                tab === 'positions' ? 'desktop-positions-tab active' : 'desktop-positions-tab'
              }
              onClick={() => setTab('positions')}
            >
              Positions<span className="desktop-positions-tab-count">{positions.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'orders'}
              className={
                tab === 'orders' ? 'desktop-positions-tab active' : 'desktop-positions-tab'
              }
              onClick={() => setTab('orders')}
            >
              Open Orders<span className="desktop-positions-tab-count">{openOrders.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'recent'}
              className={
                tab === 'recent' ? 'desktop-positions-tab active' : 'desktop-positions-tab'
              }
              onClick={() => setTab('recent')}
            >
              Recent Trades
            </button>
          </div>
          <div className="desktop-positions-body hide-scrollbar">{expandedBody}</div>
        </div>
      ) : null}

      <div className="trade-management-statusbar">
        <span>Positions {positions.length}</span>
        <span>Open Orders {openOrders.length}</span>
        <span className={`numeric ${totalDayPnl >= 0 ? 'is-positive' : 'is-negative'}`}>
          Day P&amp;L {signedCurrency(totalDayPnl)}
        </span>
        <button
          className="trade-management-expand-button"
          onClick={() => onExpandedChange(!expanded)}
          aria-expanded={expanded}
        >
          <ChevronDownIcon
            size={14}
            style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
          />
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {positionPendingClose ? (
        <AlertDialog
          title="Close position?"
          message={`Submit a market order to close ${positionPendingClose.symbol}?`}
          actions={[
            {
              label: `Close ${Math.abs(positionPendingClose.quantity)} @ Market`,
              role: 'destructive',
              onSelect: () => {
                const current =
                  positions.find((p) => p.symbol === positionPendingClose.symbol) ??
                  positionPendingClose;
                onClosePosition(current);
              },
            },
            { label: 'Cancel', role: 'cancel' },
          ]}
          onDismiss={() => setPositionPendingClose(null)}
        />
      ) : null}

      {positionPendingTrim ? (
        <AlertDialog
          title="Trim 50%?"
          message={`Submit a market order to trim half of ${positionPendingTrim.symbol}?`}
          actions={[
            {
              label: 'Trim 50% @ Market',
              role: 'destructive',
              onSelect: () => {
                const current =
                  positions.find((p) => p.symbol === positionPendingTrim.symbol) ??
                  positionPendingTrim;
                onTrimPosition(current);
              },
            },
            { label: 'Cancel', role: 'cancel' },
          ]}
          onDismiss={() => setPositionPendingTrim(null)}
        />
      ) : null}

      {orderPendingCancel ? (
        <AlertDialog
          title="Cancel order?"
          message={`${sideDisplayName(orderPendingCancel.side)} ${orderPendingCancel.quantity} ${orderPendingCancel.contractSymbol}`}
          actions={[
            {
              label: 'Cancel Order',
              role: 'destructive',
              onSelect: () => onCancelOrder(orderPendingCancel),
            },
            { label: 'Keep Order', role: 'cancel' },
          ]}
          onDismiss={() => setOrderPendingCancel(null)}
        />
      ) : null}

      {chartOrdersPendingCancel ? (
        <AlertDialog
          title="Cancel related open orders?"
          message={`Cancel ${chartOrdersPendingCancel.length} stop/target line${chartOrdersPendingCancel.length === 1 ? '' : 's'} for this position.`}
          actions={[
            {
              label: 'Cancel Related Orders',
              role: 'destructive',
              onSelect: () =>
                chartOrdersPendingCancel.forEach((order) => onCancelChartOrder(order)),
            },
            { label: 'Keep Orders', role: 'cancel' },
          ]}
          onDismiss={() => setChartOrdersPendingCancel(null)}
        />
      ) : null}
    </section>
  );
}

function PositionsTable({
  positions,
  metas,
  workingSymbols,
  locked,
  onClose,
  onTrim,
}: {
  positions: Position[];
  metas: Map<string, PositionMeta>;
  workingSymbols: string[];
  locked: boolean;
  onClose: (position: Position) => void;
  onTrim: (position: Position) => void;
}) {
  return (
    <table className="desktop-positions-table trade-management-table">
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Symbol</th>
          <th style={{ textAlign: 'left' }}>Contract</th>
          <th style={{ textAlign: 'left' }}>Expiration</th>
          <th style={{ textAlign: 'right' }}>Qty</th>
          <th style={{ textAlign: 'right' }}>Entry</th>
          <th style={{ textAlign: 'right' }}>Mark</th>
          <th style={{ textAlign: 'right' }}>P&amp;L</th>
          <th style={{ textAlign: 'right' }}>P&amp;L %</th>
          <th style={{ textAlign: 'right' }}>Expiry B/E</th>
          <th style={{ textAlign: 'right' }}>Stop</th>
          <th style={{ textAlign: 'right' }}>Target</th>
          <th style={{ textAlign: 'right' }}>Time</th>
          <th aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => {
          const meta = metas.get(position.symbol);
          const working = workingSymbols.includes(position.symbol);
          return (
            <tr key={position.symbol}>
              <td className="numeric">{meta?.contract?.underlying ?? position.symbol}</td>
              <td className="numeric">{meta?.label ?? position.symbol}</td>
              <td className="numeric">{meta?.expiration ?? '—'}</td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {Format.signedQuantity(position.quantity)}
              </td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {Format.price(position.avgPrice)}
              </td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {Format.price(position.markPrice)}
              </td>
              <td
                className={`numeric ${position.unrealizedPnl >= 0 ? 'is-positive' : 'is-negative'}`}
                style={{ textAlign: 'right', fontWeight: 600 }}
              >
                {signedCurrency(position.unrealizedPnl)}
              </td>
              <td
                className={`numeric ${(meta?.pnlPercent ?? 0) >= 0 ? 'is-positive' : 'is-negative'}`}
                style={{ textAlign: 'right' }}
              >
                {Format.signedPrice(meta?.pnlPercent ?? 0, 0)}%
              </td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {priceOrDash(meta?.expiryBreakEven)}
              </td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {priceOrDash(meta?.stop?.triggerPrice)}
              </td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {priceOrDash(meta?.target?.triggerPrice)}
              </td>
              <td className="numeric" style={{ textAlign: 'right' }}>
                {timeInTrade(position)}
              </td>
              <td style={{ textAlign: 'right' }}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {working ? <Spinner size={11} /> : null}
                  <button
                    className="desktop-positions-action desktop-positions-action--danger"
                    disabled={locked || working}
                    onClick={() => onClose(position)}
                  >
                    Close
                  </button>
                  <button
                    className="desktop-positions-action"
                    disabled={locked || working || Math.abs(position.quantity) < 2}
                    onClick={() => onTrim(position)}
                  >
                    Trim
                  </button>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OrdersTable({
  orders,
  locked,
  onCancel,
}: {
  orders: OrderResult[];
  locked: boolean;
  onCancel: (order: OrderResult) => void;
}) {
  return (
    <table className="desktop-positions-table trade-management-table">
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Contract</th>
          <th style={{ textAlign: 'left' }}>Side</th>
          <th style={{ textAlign: 'right' }}>Qty</th>
          <th style={{ textAlign: 'left' }}>Order type</th>
          <th style={{ textAlign: 'right' }}>Limit/Stop</th>
          <th style={{ textAlign: 'left' }}>Status</th>
          <th style={{ textAlign: 'right' }}>Submitted</th>
          <th aria-hidden="true" />
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.orderId}>
            <td className="numeric">{order.contractSymbol}</td>
            <td
              className="numeric"
              style={{
                color: order.side === 'buy' ? 'var(--buy-green)' : 'var(--sell-red)',
                fontWeight: 600,
              }}
            >
              {sideDisplayName(order.side)}
            </td>
            <td className="numeric" style={{ textAlign: 'right' }}>
              {order.quantity}
            </td>
            <td>{orderTypeDisplayName(order.orderType)}</td>
            <td className="numeric" style={{ textAlign: 'right' }}>
              {priceOrDash(order.limitPrice)}
            </td>
            <td className="text-secondary">{orderStatusDisplayName(order.status)}</td>
            <td className="numeric" style={{ textAlign: 'right' }}>
              {submittedTime(order.timestamp)}
            </td>
            <td style={{ textAlign: 'right' }}>
              <button
                className="desktop-positions-action"
                disabled
                title="Replace uses the order ticket for now"
              >
                Replace
              </button>
              <button
                className="desktop-positions-action"
                disabled={locked}
                onClick={() => onCancel(order)}
                aria-label="Cancel order"
              >
                <XCircleFillIcon size={14} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
