import type {
  AssetClass,
  FuturesContract,
  OptionContract,
  OrderPreview,
  OrderRequest,
  OrderResult,
  OrderSelection,
  OrderSide,
  OrderType,
  Position,
} from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import { orderStatusDisplayName, sideDisplayName } from '../../core/models/domain';
import { Store } from '../../core/observable';
import { Format } from '../../design/format';
import type { ChainStore } from './ChainStore';
import { FALLBACK_FUTURES_ROOT, futuresRootFor } from './futuresRoots';

export type ToastStyle = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  style: ToastStyle;
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
  assetClass: AssetClass;
  quantity: number;
  orderType: OrderType;

  futuresRoot: string;
  futuresContracts: FuturesContract[];
  selectedFutureSymbol: string | null;

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
 * Trade state (TradeViewModel.swift analog): ticket configuration,
 * arm-then-confirm flow, positions and open orders, futures selection,
 * flatten/cancel actions, toasts.
 */
export class TradeStore extends Store<TradeStoreState> {
  private toastDismissTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resolves an option position's symbol to chain data for flattening. */
  optionContractResolver: ((symbol: string) => OptionContract | undefined) | null = null;

  constructor(private readonly apiClient: ApiClient) {
    super({
      assetClass: 'option',
      quantity: 1,
      orderType: 'mid',
      futuresRoot: FALLBACK_FUTURES_ROOT,
      futuresContracts: [],
      selectedFutureSymbol: null,
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

  setAssetClass(assetClass: AssetClass): void {
    this.set({ assetClass });
  }

  setOrderType(orderType: OrderType): void {
    this.set({ orderType });
  }

  // MARK: - Quantity

  setQuantity(value: number): void {
    this.set({ quantity: Math.max(1, value) });
  }

  addQuantity(amount: number): void {
    this.setQuantity(this.getState().quantity + amount);
  }

  // MARK: - Futures

  async setFuturesRoot(root: string): Promise<void> {
    const { futuresRoot, futuresContracts } = this.getState();
    if (root === futuresRoot && futuresContracts.length > 0) return;
    this.set({ futuresRoot: root });
    await this.loadFuturesContracts();
  }

  async loadFuturesContracts(): Promise<void> {
    try {
      const contracts = await this.apiClient.futures(this.getState().futuresRoot);
      this.set({ futuresContracts: contracts });
      const { selectedFutureSymbol } = this.getState();
      if (
        selectedFutureSymbol === null ||
        !contracts.some((contract) => contract.symbol === selectedFutureSymbol)
      ) {
        // Front month by default.
        const front = contracts.find((contract) => contract.frontMonth) ?? contracts[0];
        this.set({ selectedFutureSymbol: front?.symbol ?? null });
      }
    } catch (error) {
      this.showToast(errorMessage(error), 'error');
    }
  }

  selectFuture(symbol: string): void {
    this.set({ selectedFutureSymbol: symbol });
  }

  get selectedFuture(): FuturesContract | null {
    const { futuresContracts, selectedFutureSymbol } = this.getState();
    return futuresContracts.find((contract) => contract.symbol === selectedFutureSymbol) ?? null;
  }

  // MARK: - Arm (step 1)

  /** Builds the OrderRequest + idempotency key and opens the confirm sheet. */
  arm(side: OrderSide, underlying: string, chainStore: ChainStore): void {
    const { assetClass, quantity, orderType } = this.getState();
    let selection: OrderSelection;
    let summary: string;

    if (assetClass === 'option') {
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
    } else {
      const contract = this.selectedFuture;
      if (!contract) {
        this.showToast('Pick a futures contract first.', 'error');
        return;
      }
      selection = { mode: 'explicit', contractSymbol: contract.symbol };
      summary = contract.symbol;
    }

    const request: OrderRequest = {
      underlying,
      assetClass,
      side,
      quantity,
      orderType,
      selection,
    };
    this.set({
      armedTicket: {
        id: nextId++,
        request,
        idempotencyKey: crypto.randomUUID(),
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
      this.set({ previewError: errorMessage(error) });
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
      let selection: OrderSelection;
      let underlying: string;

      if (position.assetClass === 'future') {
        selection = { mode: 'explicit', contractSymbol: position.symbol };
        underlying = futuresRootFor(position.symbol) ?? this.getState().futuresRoot;
      } else {
        const contract = this.optionContractResolver?.(position.symbol);
        if (!contract) {
          this.showToast(`Open ${position.symbol}'s chart to flatten this option.`, 'error');
          return;
        }
        selection = {
          mode: 'explicit',
          optionType: contract.optionType,
          expiration: contract.expiration,
          strike: contract.strike,
        };
        underlying = contract.underlying;
      }

      const request: OrderRequest = {
        underlying,
        assetClass: position.assetClass,
        side,
        quantity: Math.abs(position.quantity),
        orderType: 'market',
        selection,
      };
      try {
        const result = await this.apiClient.placeOrder(request, crypto.randomUUID());
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

  showToast(message: string, style: ToastStyle): void {
    const toast: Toast = { id: nextId++, message, style };
    this.set({ toast });
    if (this.toastDismissTimer !== null) clearTimeout(this.toastDismissTimer);
    this.toastDismissTimer = setTimeout(() => {
      if (this.getState().toast?.id === toast.id) {
        this.set({ toast: null });
      }
    }, 3000);
  }
}
