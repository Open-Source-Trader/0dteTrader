import type { ChartOrder, OrderResult } from '@0dtetrader/shared-types';
import { Format } from '../design/format';
import { orderStatusDisplayName, sideDisplayName } from './models/domain';

/**
 * OS notifications for order outcomes the user must not miss while the app is
 * in the background. In-app toasts already cover the focused case, so a
 * notification fires only when the window does not have focus — never both.
 * Everything is injected (toggle, focus probe, Notification constructor) so
 * the rules are testable without a DOM.
 */

/** Constructor-shaped slice of the DOM Notification API this module uses. */
export type NotificationCtor = new (title: string, options?: { body?: string }) => unknown;

export interface NotifierDeps {
  /** Profile › System notifications, read at fire time. */
  enabled: () => boolean;
  /** Whether the app window currently has focus (`document.hasFocus`). */
  hasFocus: () => boolean;
  /** DOM Notification constructor; null when the platform has none. */
  notification: NotificationCtor | null;
}

/** Statuses that end an order's life — the only ones worth a notification. */
const TERMINAL_ORDER_STATUSES = new Set<string>(['filled', 'rejected', 'cancelled']);

function fire(deps: NotifierDeps, title: string, body: string): boolean {
  if (deps.notification === null || !deps.enabled() || deps.hasFocus()) return false;
  new deps.notification(title, { body });
  return true;
}

/** Order-update push: notifies terminal statuses only (filled/rejected/cancelled). */
export function notifyOrderUpdate(deps: NotifierDeps, update: OrderResult): boolean {
  if (!TERMINAL_ORDER_STATUSES.has(update.status)) return false;
  return fire(
    deps,
    `Order ${orderStatusDisplayName(update.status).toLowerCase()}`,
    `${sideDisplayName(update.side)} ${update.quantity} ${update.contractSymbol}`,
  );
}

/** Chart-order push: notifies a line firing (triggered) or failing, nothing else. */
export function notifyChartOrder(deps: NotifierDeps, order: ChartOrder): boolean {
  if (order.status !== 'triggered' && order.status !== 'failed') return false;
  return fire(
    deps,
    order.status === 'triggered' ? 'Chart order triggered' : 'Chart order failed',
    `${order.underlying} crossed ${Format.price(order.triggerPrice)}`,
  );
}
