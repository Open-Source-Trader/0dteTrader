import type {
  OptionContract,
  OrderPreview,
  OrderRequest,
  OrderResult,
  OrderSelection,
  OrderSide,
  OrderType,
  Position,
  Quote,
} from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import { orderStatusDisplayName, sideDisplayName } from '../../core/models/domain';
import { Store } from '../../core/observable';
import { Format } from '../../design/format';
import type { ChainStore } from './ChainStore';

export type ToastStyle = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  style: ToastStyle;
  /** Set during the exit animation, just before the toast unmounts. */
  leaving?: boolean;
}

/**
 * An armed (not yet confirmed) order. The idempotency key is generated when
 * the ticket arms and reused by every retry/double-click.
 */
export interface ArmedOrderTicket {
  id: number;
  request: OrderRequest;
  idempotencyKey: string;
  side: OrderSide;
  summary: string;
}

interface TradeStoreState {
  quantity: number;
  orderType: OrderType;

  positions: Position[];
  openOrders: OrderResult[];
  workingSymbols: string[];

  armedTicket: ArmedOrderTicket | null;
  preview: OrderPreview | null;
  isPreviewLoading: boolean;
  previewError: string | null;
  isSubmitting: boolean;

  toast: Toast | null;
}

let nextId = 1;

/**
 * crypto.randomUUID is unavailable under Node 18 vitest (no global crypto);
 * fall back to a random RFC4122 v4-shaped id there.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Trade state (TradeViewModel.swift analog): ticket configuration,
 * arm-then-confirm flow, positions and open orders, flatten/cancel actions,
 * toasts.
 */
export class TradeStore extends Store<TradeStoreState> {
  private toastQueue: Toast[] = [];
  private toastDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private toastRemoveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resolves an option position's symbol to chain data for flattening. */
  optionContractResolver: ((symbol: string) => OptionContract | undefined) | null = null;

  constructor(private readonly apiClient: ApiClient) {
    super({
      quantity: 1,
      orderType: 'mid',
      positions: [],
      openOrders: [],
      workingSymbols: [],
      armedTicket: null,
      preview: null,
      isPreviewLoading: false,
      previewError: null,
      isSubmitting: false,
      toast: null,
    });
  }

  setOrderType(orderType: OrderType): void {
    this.set({ orderType });
  }

  // MARK: - Quantity

  setQuantity(value: number): void {
    // Upper bound mirrors the server's @Max(1000) on OrderRequestDto.
    this.set({ quantity: Math.min(1000, Math.max(1, value)) });
  }

  addQuantity(amount: number): void {
    this.setQuantity(this.getState().quantity + amount);
  }

  /**
   * Live tick for a subscribed contract symbol: recomputes any matching
   * position's mark and P/L (server-provided multiplier keeps the math
   * consistent with the broker).
   */
  applyContractQuote(quote: Quote): void {
    const { positions } = this.getState();
    if (positions.some((position) => position.symbol === quote.symbol)) {
      this.set({
        positions: positions.map((position) =>
          position.symbol === quote.symbol
            ? {
                ...position,
                markPrice: quote.last,
                unrealizedPnl:
                  Math.round(
                    (quote.last - position.avgPrice) *
                      position.quantity *
                      position.multiplier *
                      100,
                  ) / 100,
              }
            : position,
        ),
      });
    }
  }

  // MARK: - Arm (step 1)

  /** Builds the OrderRequest + idempotency key and opens the confirm sheet. */
  arm(side: OrderSide, underlying: string, chainStore: ChainStore): void {
    const { quantity, orderType } = this.getState();
    let selection: OrderSelection;
    let summary: string;

    const chainState = chainStore.getState();
    const optionType = chainState.optionType;
    if (chainState.isAutoMode) {
      selection = {
        mode: 'auto_otm',
        optionType,
        expiration: chainState.selectedExpiration ?? undefined,
      };
      const expirationLabel = chainState.selectedExpiration ?? 'nearest';
      const typeName = optionType === 'call' ? 'Call' : 'Put';
      summary = `${underlying} AUTO +1 OTM ${typeName} · exp ${expirationLabel}`;
    } else {
      const strike = chainState.selectedStrike;
      const expiration = chainState.selectedExpiration;
      if (strike === null || expiration === null) {
        this.showToast('Pick an expiration and strike first.', 'error');
        return;
      }
      selection = { mode: 'explicit', optionType, expiration, strike };
      const shortName = optionType === 'call' ? 'C' : 'P';
      summary = `${underlying} ${expiration} ${Format.strike(strike)}${shortName}`;
    }

    const request: OrderRequest = {
      underlying,
      assetClass: 'option',
      side,
      quantity,
      orderType,
      selection,
    };
    this.set({
      armedTicket: {
        id: nextId++,
        request,
        idempotencyKey: newIdempotencyKey(),
        side,
        summary,
      },
      preview: null,
      previewError: null,
    });
    void this.loadPreview();
  }

  /** Server-side preview powering the confirmation sheet. */
  async loadPreview(): Promise<void> {
    const ticket = this.getState().armedTicket;
    if (!ticket) return;
    this.set({ isPreviewLoading: true, previewError: null });
    try {
      const preview = await this.apiClient.previewOrder(ticket.request);
      this.set({ preview });
    } catch (error) {
      this.set({ previewError: errorMessage(error) });
    } finally {
      this.set({ isPreviewLoading: false });
    }
  }

  // MARK: - Confirm (step 2)

  /** Submits the armed order, reusing the same idempotency key on retries. */
  async confirmArmedOrder(): Promise<void> {
    const ticket = this.getState().armedTicket;
    if (!ticket || this.getState().isSubmitting) return;
    this.set({ isSubmitting: true });
    try {
      const result = await this.apiClient.placeOrder(ticket.request, ticket.idempotencyKey);
      this.set({ armedTicket: null });
      this.showToast(
        `${sideDisplayName(ticket.side)} ${result.contractSymbol} — ${orderStatusDisplayName(result.status)}`,
        result.status === 'rejected' ? 'error' : 'success',
      );
      await this.refreshTradingData();
    } catch (error) {
      // Keep the ticket armed so the user can retry with the same key.
      // Drop the stale preview: Retry now resubmits instead of confirming
      // a possibly repriced quote.
      this.set({ previewError: errorMessage(error), preview: null });
    } finally {
      this.set({ isSubmitting: false });
    }
  }

  cancelArmedOrder(): void {
    this.set({ armedTicket: null });
  }

  // MARK: - Positions & open orders

  async refreshTradingData(): Promise<void> {
    try {
      this.set({ positions: await this.apiClient.positions() });
    } catch (error) {
      this.showToast(errorMessage(error), 'error');
    }
    try {
      this.set({ openOrders: await this.apiClient.openOrders() });
    } catch (error) {
      this.showToast(errorMessage(error), 'error');
    }
  }

  /** Tap-to-flatten: opposite-side market order for the full position size. */
  async flatten(position: Position): Promise<void> {
    if (position.quantity === 0) return;
    if (this.getState().workingSymbols.includes(position.symbol)) return;
    this.set({ workingSymbols: [...this.getState().workingSymbols, position.symbol] });

    try {
      const side: OrderSide = position.quantity > 0 ? 'sell' : 'buy';
      const contract = this.optionContractResolver?.(position.symbol);
      if (!contract) {
        this.showToast(`Open ${position.symbol}'s chart to flatten this option.`, 'error');
        return;
      }
      const selection: OrderSelection = {
        mode: 'explicit',
        optionType: contract.optionType,
        expiration: contract.expiration,
        strike: contract.strike,
      };

      const request: OrderRequest = {
        underlying: contract.underlying,
        assetClass: 'option',
        side,
        quantity: Math.abs(position.quantity),
        orderType: 'market',
        selection,
      };
      try {
        const result = await this.apiClient.placeOrder(request, newIdempotencyKey());
        this.showToast(
          `Flatten ${position.symbol} — ${orderStatusDisplayName(result.status)}`,
          result.status === 'rejected' ? 'error' : 'success',
        );
        await this.refreshTradingData();
      } catch (error) {
        this.showToast(errorMessage(error), 'error');
      }
    } finally {
      this.set({
        workingSymbols: this.getState().workingSymbols.filter((s) => s !== position.symbol),
      });
    }
  }

  async cancel(order: OrderResult): Promise<void> {
    try {
      await this.apiClient.cancelOrder(order.orderId);
      this.showToast('Order cancelled.', 'info');
      await this.refreshTradingData();
    } catch (error) {
      this.showToast(errorMessage(error), 'error');
    }
  }

  // MARK: - WS order updates

  handleOrderUpdate(update: OrderResult): void {
    this.showToast(
      `Order ${update.contractSymbol} — ${orderStatusDisplayName(update.status)}`,
      update.status === 'rejected' ? 'error' : 'info',
    );
    void this.refreshTradingData();
  }

  // MARK: - Toast

  /** FIFO queue: a new toast never clobbers one that's on screen. */
  showToast(message: string, style: ToastStyle): void {
    this.toastQueue.push({ id: nextId++, message, style });
    if (this.getState().toast !== null) return; // one is already showing
    this.advanceToastQueue();
  }

  /** Manual dismiss (tap on the toast capsule); shows the next queued toast. */
  dismissToast(): void {
    if (this.toastDismissTimer !== null) clearTimeout(this.toastDismissTimer);
    if (this.toastRemoveTimer !== null) clearTimeout(this.toastRemoveTimer);
    this.toastDismissTimer = null;
    this.toastRemoveTimer = null;
    if (this.getState().toast === null) return;
    this.set({ toast: null });
    this.advanceToastQueue();
  }

  private advanceToastQueue(): void {
    const next = this.toastQueue.shift();
    if (!next) return;
    this.set({ toast: next });
    // Errors stay up longer; everything animates out over 200ms first.
    this.toastDismissTimer = setTimeout(
      () => {
        if (this.getState().toast?.id !== next.id) return;
        this.set({ toast: { ...next, leaving: true } });
        this.toastRemoveTimer = setTimeout(() => {
          if (this.getState().toast?.id !== next.id) return;
          this.set({ toast: null });
          this.advanceToastQueue();
        }, 200);
      },
      next.style === 'error' ? 5000 : 3000,
    );
  }
}
