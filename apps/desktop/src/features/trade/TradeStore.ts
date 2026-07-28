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
import { roundToTick } from '../../core/models/priceInput';
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
  /**
   * The price a `custom` order works at, or null while none has been entered.
   *
   * Held here rather than in the field so the confirm sheet and the arm guard
   * read the same settled number, and so it can be cleared from outside when
   * the contract it was typed for changes — see `clearCustomLimitPrice`.
   */
  customLimitPrice: number | null;

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

  /**
   * Reports whether the order-update socket is currently connected. An order
   * placement's own `orderUpdate` push (submitted, then the terminal status)
   * drives `handleOrderUpdate` → `refreshTradingData` already, so a direct
   * refresh after placing/cancelling is only needed as a fallback for when
   * that push has nowhere to arrive. Wired from TradeScreen; null (treated as
   * disconnected) only in tests that construct a bare TradeStore.
   */
  isSocketConnected: (() => boolean) | null = null;

  constructor(private readonly apiClient: ApiClient) {
    super({
      quantity: 1,
      orderType: 'mid',
      customLimitPrice: null,
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

  /** The settled custom limit, or null while the field does not name a price. */
  setCustomLimitPrice(price: number | null): void {
    this.set({ customLimitPrice: price === null ? null : roundToTick(price) });
  }

  /**
   * Drops a custom price and the selection that would send it, called when the
   * contract underneath changes.
   *
   * A premium is only meaningful for the contract it was typed against — 2.45
   * is near the money on one strike and ten times the ask on the next — so
   * carrying it silently onto a different contract is the one way this feature
   * could fill an order nobody meant. Falling back to `mid` rather than merely
   * blanking the field also moves the highlight, so the change is visible.
   */
  clearCustomLimitPrice(): void {
    const { customLimitPrice, orderType } = this.getState();
    if (customLimitPrice === null && orderType !== 'custom') return;
    this.set({
      customLimitPrice: null,
      orderType: orderType === 'custom' ? 'mid' : orderType,
    });
  }

  /** Whether the current pricing selection is complete enough to arm. */
  get canArm(): boolean {
    const { orderType, customLimitPrice } = this.getState();
    return orderType !== 'custom' || customLimitPrice !== null;
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

  /**
   * Builds the OrderRequest + idempotency key. Normally opens the confirm
   * sheet; when `bypassConfirmation` is set (Profile → Skip order confirmation)
   * it submits the order immediately, skipping the sheet.
   */
  arm(
    side: OrderSide,
    underlying: string,
    chainStore: ChainStore,
    bypassConfirmation = false,
  ): void {
    const { quantity, orderType, customLimitPrice } = this.getState();
    // Sent only for `custom`; the server rejects it alongside any other
    // variant, because those four are priced from its own quote.
    const limitPrice = orderType === 'custom' ? (customLimitPrice ?? undefined) : undefined;
    if (orderType === 'custom' && limitPrice === undefined) {
      this.showToast('Enter a limit price first.', 'error');
      return;
    }
    let selection: OrderSelection;
    let summary: string;

    const chainState = chainStore.getState();
    const optionType = chainState.optionType;

    // Selling the contract you are already long closes (part of) that position
    // rather than opening a short. The ticket quantity is honored but capped at
    // the position size — the cap is what stops a large ticket from flipping
    // through zero into a short nobody asked for, while a smaller ticket still
    // scales out partially. The summary says exactly what will happen.
    const selected = chainStore.selectedContract;
    const held =
      side === 'sell' && selected
        ? this.getState().positions.find((p) => p.symbol === selected.symbol && p.quantity > 0)
        : undefined;
    if (selected && held) {
      const closeQuantity = Math.min(quantity, held.quantity);
      const shortName = selected.optionType === 'call' ? 'C' : 'P';
      const sizeLabel =
        closeQuantity < held.quantity ? `${closeQuantity} of ${held.quantity}` : `${closeQuantity}`;
      this.set({
        armedTicket: {
          id: nextId++,
          request: {
            underlying,
            assetClass: 'option',
            side,
            quantity: closeQuantity,
            orderType,
            limitPrice,
            selection: {
              mode: 'explicit',
              optionType: selected.optionType,
              expiration: selected.expiration,
              strike: selected.strike,
            },
          },
          idempotencyKey: newIdempotencyKey(),
          side,
          summary: `CLOSE ${sizeLabel} · ${underlying} ${Format.strike(selected.strike)}${shortName}`,
        },
        preview: null,
        previewError: null,
      });
      void this.loadPreview();
      return;
    }

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
      limitPrice,
      selection,
    };
    const idempotencyKey = newIdempotencyKey();
    if (bypassConfirmation) {
      // Clear any stale ticket/preview state before bypassing
      this.set({
        armedTicket: null,
        preview: null,
        previewError: null,
      });
      void this.placeDirect(request, idempotencyKey, side);
      return;
    }
    this.set({
      armedTicket: {
        id: nextId++,
        request,
        idempotencyKey,
        side,
        summary,
      },
      preview: null,
      previewError: null,
    });
    void this.loadPreview();
  }

  /**
   * Submits without a confirm sheet (bypass path). Failures surface as a toast
   * since there is no sheet to hold a preview error.
   */
  private async placeDirect(
    request: OrderRequest,
    idempotencyKey: string,
    side: OrderSide,
  ): Promise<void> {
    if (this.getState().isSubmitting) return;
    this.set({ isSubmitting: true });
    try {
      await this.submitOrder(request, idempotencyKey, side);
    } catch (error) {
      this.showToast(errorMessage(error), 'error');
    } finally {
      this.set({ isSubmitting: false });
    }
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

  /**
   * Places the order, clears the armed ticket, and toasts the result. Throws
   * on failure so callers surface the error their own way (sheet preview
   * error vs. toast). Shared by the confirm and bypass paths.
   *
   * Skips its own refresh when the socket is connected: the placement's own
   * `orderUpdate` push (submitted, then the terminal fill/reject) arrives over
   * the same socket and drives `handleOrderUpdate` → `refreshTradingData`
   * already, so refreshing here too only stacked a redundant reload on top of
   * it. Falls back to a direct refresh when the socket is down and that push
   * has nowhere to arrive.
   */
  private async submitOrder(
    request: OrderRequest,
    idempotencyKey: string,
    side: OrderSide,
  ): Promise<void> {
    const result = await this.apiClient.placeOrder(request, idempotencyKey);
    this.set({ armedTicket: null });
    this.showToast(
      `${sideDisplayName(side)} ${result.contractSymbol} — ${orderStatusDisplayName(result.status)}`,
      result.status === 'rejected' ? 'error' : 'success',
    );
    if (!this.isSocketConnected?.()) await this.refreshTradingData();
  }

  /** Submits the armed order, reusing the same idempotency key on retries. */
  async confirmArmedOrder(): Promise<void> {
    const ticket = this.getState().armedTicket;
    if (!ticket || this.getState().isSubmitting) return;
    this.set({ isSubmitting: true });
    try {
      await this.submitOrder(ticket.request, ticket.idempotencyKey, ticket.side);
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

  private refreshInFlight: Promise<void> | null = null;
  /** Set when a refresh is requested while one is already running. */
  private refreshQueued = false;

  /**
   * A single order placement can emit a submitted push and a terminal
   * fill/reject push in quick succession, each wired to call this — so calls
   * collapse: one already running is awaited rather than duplicated, and at
   * most one more runs after it to pick up anything that arrived meanwhile.
   */
  async refreshTradingData(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.runRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshTradingData();
      }
    }
  }

  private async runRefresh(): Promise<void> {
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
      const contract = this.optionContractResolver?.(position.symbol) ?? null;
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
        // See submitOrder: the placement's own orderUpdate push refreshes
        // when the socket is up; fall back to a direct refresh when it's not.
        if (!this.isSocketConnected?.()) await this.refreshTradingData();
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
      // See submitOrder: cancelOrder's own orderUpdate push refreshes when
      // the socket is up; fall back to a direct refresh when it's not.
      if (!this.isSocketConnected?.()) await this.refreshTradingData();
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
