import type {
  OptionContract,
  OptionType,
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
import { parseOccSymbol } from '../../core/models/occSymbol';
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

  /**
   * Governs success/info toasts (Profile › In-app toasts); error toasts always
   * show — a swallowed failure is one the user acts on without knowing it
   * failed. Wired from the container; null (treated as enabled) in tests.
   */
  toastPolicy: (() => boolean) | null = null;

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
    const index = positions.findIndex((position) => position.symbol === quote.symbol);
    if (index === -1) return;
    const position = positions[index];
    const updated: Position = {
      ...position,
      markPrice: quote.last,
      unrealizedPnl:
        Math.round(
          (quote.last - position.avgPrice) * position.quantity * position.multiplier * 100,
        ) / 100,
    };
    const next = positions.slice();
    next[index] = updated;
    this.set({ positions: next });
  }

  // MARK: - Arm (step 1)

  /**
   * Held long legs the panel's current selection could close: same underlying
   * + expiration + right, any strike. Matching on strike would miss a held
   * position whenever AUTO's live OTM pick has drifted off the strike actually
   * held. Legs are resolved through `optionContractResolver` rather than
   * trusted from `chainStore.selectedContract`, since that is exactly the
   * drifted AUTO pick we cannot use for the close's strike. Shared by arm()
   * and the SELL buttons' disabled predicate, so gate and action agree.
   */
  sellableHeldLegs(
    underlying: string,
    expiration: string | null,
    optionType: OptionType,
  ): { position: Position; contract: OptionContract }[] {
    if (!expiration) return [];
    return this.getState()
      .positions.map((position) => {
        const contract = this.optionContractResolver?.(position.symbol);
        return contract &&
          contract.underlying === underlying &&
          contract.expiration === expiration &&
          contract.optionType === optionType &&
          position.quantity > 0
          ? { position, contract }
          : null;
      })
      .filter((leg): leg is { position: Position; contract: OptionContract } => leg !== null);
  }

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

    const expiration = chainState.selectedExpiration;

    // CURR mode: the user named the exact owned leg (on the side the CALL/PUT
    // toggle selects), so the sell-to-close leg-matching heuristic below is
    // bypassed — buys add to that contract, sells close part of it clamped to
    // what is actually held. Both sides insist the leg really is held: CURR
    // must never quietly trade a contract the account does not own.
    if (chainState.isCurrMode) {
      const strike = chainState.selectedStrike;
      if (strike === null || expiration === null) {
        this.showToast('Pick an owned contract first.', 'error');
        return;
      }
      // A leg resolved from its OCC symbol has no quotes until its
      // expiration's contracts load — never trade off a 0.00 display.
      const selected = chainStore.selectedContract;
      if (selected && selected.bid <= 0 && selected.ask <= 0 && selected.last <= 0) {
        this.showToast('Quotes are still loading for that expiration.', 'error');
        return;
      }
      const heldQuantity = this.getState().positions.reduce((sum, position) => {
        if (position.quantity <= 0) return sum;
        // The OCC symbol itself names the leg — the chain resolver only knows
        // the loaded expiration, and CURR must close holdings on any of them.
        const contract =
          parseOccSymbol(position.symbol) ?? this.optionContractResolver?.(position.symbol);
        return contract &&
          contract.underlying === underlying &&
          contract.expiration === expiration &&
          contract.optionType === optionType &&
          contract.strike === strike
          ? sum + position.quantity
          : sum;
      }, 0);
      if (heldQuantity <= 0) {
        this.showToast(
          side === 'sell' ? 'No open position to sell' : 'Pick an owned contract first.',
          'error',
        );
        return;
      }
      const shortName = optionType === 'call' ? 'C' : 'P';
      const orderQuantity = side === 'sell' ? Math.min(quantity, heldQuantity) : quantity;
      const sizeLabel =
        orderQuantity < heldQuantity ? `${orderQuantity} of ${heldQuantity}` : `${orderQuantity}`;
      const summaryLabel =
        side === 'sell'
          ? `CLOSE ${sizeLabel} · ${underlying} ${Format.strike(strike)}${shortName}`
          : `${underlying} ${expiration} ${Format.strike(strike)}${shortName}`;
      this.set({
        armedTicket: {
          id: nextId++,
          request: {
            underlying,
            assetClass: 'option',
            side,
            quantity: orderQuantity,
            orderType,
            limitPrice,
            selection: { mode: 'explicit', optionType, expiration, strike },
          },
          idempotencyKey: newIdempotencyKey(),
          side,
          summary: summaryLabel,
        },
        preview: null,
        previewError: null,
      });
      void this.loadPreview();
      return;
    }

    // Selling closes (part of) a held position when the panel's selected
    // right (put/call) and expiration match one — regardless of which strike
    // AUTO mode currently points at (see sellableHeldLegs). With no matching
    // leg the sell is refused outright below: this app only sells to close,
    // never into a naked short.
    const heldLegs =
      side === 'sell' ? this.sellableHeldLegs(underlying, expiration, optionType) : [];

    if (side === 'sell' && heldLegs.length === 0) {
      this.showToast('No open position to sell', 'error');
      return;
    }

    if (heldLegs.length > 0) {
      // Highest unrealized P/L first: scale out of the most profitable leg
      // before touching the rest when the ticket doesn't cover the full
      // combined size.
      const ordered = [...heldLegs].sort(
        (a, b) => b.position.unrealizedPnl - a.position.unrealizedPnl,
      );
      const totalHeld = ordered.reduce((sum, leg) => sum + leg.position.quantity, 0);
      const firstClose = ordered[0];
      const closeQuantity = Math.min(quantity, totalHeld, firstClose.position.quantity);
      const shortName = firstClose.contract.optionType === 'call' ? 'C' : 'P';
      const sizeLabel =
        closeQuantity < totalHeld ? `${closeQuantity} of ${totalHeld}` : `${closeQuantity}`;
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
              optionType: firstClose.contract.optionType,
              expiration: firstClose.contract.expiration,
              strike: firstClose.contract.strike,
            },
          },
          idempotencyKey: newIdempotencyKey(),
          side,
          summary: `CLOSE ${sizeLabel} · ${underlying} ${Format.strike(firstClose.contract.strike)}${shortName}`,
        },
        preview: null,
        previewError: null,
      });
      void this.loadPreview();
      return;
    }

    if (chainState.isAutoMode) {
      // Sending the offset pins the server to the exact contract the panel
      // shows, rather than whatever its own default would resolve to.
      const otmOffset = chainStore.autoOtmOffset;
      selection = {
        mode: 'auto_otm',
        optionType,
        expiration: chainState.selectedExpiration ?? undefined,
        otmOffset,
      };
      const expirationLabel = chainState.selectedExpiration ?? 'nearest';
      const typeName = optionType === 'call' ? 'Call' : 'Put';
      const offsetLabel = otmOffset === 0 ? 'ATM' : `+${otmOffset} OTM`;
      summary = `${underlying} AUTO ${offsetLabel} ${typeName} · exp ${expirationLabel}`;
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
    const [positions, openOrders] = await Promise.allSettled([
      this.apiClient.positions(),
      this.apiClient.openOrders(),
    ]);
    if (positions.status === 'fulfilled') {
      this.set({ positions: positions.value });
    } else {
      this.showToast(errorMessage(positions.reason), 'error');
    }
    if (openOrders.status === 'fulfilled') {
      this.set({ openOrders: openOrders.value });
    } else {
      this.showToast(errorMessage(openOrders.reason), 'error');
    }
  }

  /** Tap-to-flatten: opposite-side market order for the full position size. */
  async flatten(position: Position): Promise<void> {
    await this.exitPosition(position, Math.abs(position.quantity), 'Flatten');
  }

  /** Partial scale-out: opposite-side market order for half the current size. */
  async trimHalf(position: Position): Promise<void> {
    const quantity = Math.floor(Math.abs(position.quantity) / 2);
    if (quantity <= 0) return;
    await this.exitPosition(position, quantity, 'Trim');
  }

  private async exitPosition(position: Position, quantity: number, action: string): Promise<void> {
    if (position.quantity === 0 || quantity <= 0) return;
    if (this.getState().workingSymbols.includes(position.symbol)) return;
    this.set({ workingSymbols: [...this.getState().workingSymbols, position.symbol] });

    try {
      const side: OrderSide = position.quantity > 0 ? 'sell' : 'buy';
      // The chain resolver only knows the loaded expiration; the position's
      // own OCC symbol names the leg exactly, so any broker option position
      // stays closable from the workspace.
      const contract =
        this.optionContractResolver?.(position.symbol) ?? parseOccSymbol(position.symbol);
      if (!contract) {
        this.showToast(`Cannot resolve ${position.symbol} to close it.`, 'error');
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
        quantity: Math.min(quantity, Math.abs(position.quantity)),
        orderType: 'market',
        selection,
      };
      try {
        const result = await this.apiClient.placeOrder(request, newIdempotencyKey());
        this.showToast(
          `${action} ${position.symbol} — ${orderStatusDisplayName(result.status)}`,
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
    // The toggle governs success/info only — errors always surface.
    if (style !== 'error' && this.toastPolicy?.() === false) return;
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
