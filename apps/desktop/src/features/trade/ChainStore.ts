import type { OptionContract, OptionType, OptionsChain, Quote } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import { Store } from '../../core/observable';
import { nearestExpiration, selectAutoOTM } from './autoContractSelector';

interface ChainStoreState {
  underlying: string;
  chain: OptionsChain | null;
  isLoading: boolean;
  errorMessage: string | null;
  optionType: OptionType;
  isAutoMode: boolean;
  selectedExpiration: string | null;
  selectedStrike: number | null;
  /** Live last price of the underlying; AUTO uses it over the chain snapshot. */
  underlyingLast: number | null;
}

/**
 * Options chain + expiration/strike/AUTO selection state
 * (OptionsChainViewModel.swift analog), including the lazy per-expiration
 * contract fetch.
 */
export class ChainStore extends Store<ChainStoreState> {
  /** Expirations whose contracts are already present locally. */
  private loadedExpirations = new Set<string>();

  /**
   * Bumped by every load(); in-flight fetches bail after each await when a
   * newer load has started, so a slow response can't clobber a newer symbol.
   */
  private loadGeneration = 0;

  constructor(private readonly apiClient: ApiClient) {
    super({
      underlying: '',
      chain: null,
      isLoading: false,
      errorMessage: null,
      optionType: 'call',
      isAutoMode: true,
      selectedExpiration: null,
      selectedStrike: null,
      underlyingLast: null,
    });
  }

  get expirations(): string[] {
    return this.getState().chain?.expirations ?? [];
  }

  /** Sorted unique strikes for the selected expiration + call/put. */
  get strikes(): number[] {
    const { chain, selectedExpiration, optionType } = this.getState();
    if (!chain || !selectedExpiration) return [];
    const values = chain.contracts
      .filter(
        (contract) =>
          contract.optionType === optionType && contract.expiration === selectedExpiration,
      )
      .map((contract) => contract.strike);
    return [...new Set(values)].sort((a, b) => a - b);
  }

  /** The contract AUTO mode would trade right now. */
  get autoContract(): OptionContract | null {
    const { chain, optionType, selectedExpiration, underlyingLast } = this.getState();
    if (!chain) return null;
    return selectAutoOTM(chain, optionType, selectedExpiration, underlyingLast);
  }

  /** The contract the ticket resolves to (AUTO pick, or manual exp+strike). */
  get selectedContract(): OptionContract | null {
    const { chain, isAutoMode, optionType, selectedExpiration, selectedStrike } = this.getState();
    if (isAutoMode) return this.autoContract;
    if (!chain || selectedExpiration === null || selectedStrike === null) return null;
    return (
      chain.contracts.find(
        (contract) =>
          contract.optionType === optionType &&
          contract.expiration === selectedExpiration &&
          contract.strike === selectedStrike,
      ) ?? null
    );
  }

  setOptionType(optionType: OptionType): void {
    this.set({ optionType });
  }

  setAutoMode(isAutoMode: boolean): void {
    this.set({ isAutoMode });
  }

  /** Live tick for the chain's underlying (wired from the quote stream). */
  setUnderlyingLast(last: number): void {
    this.set({ underlyingLast: last });
  }

  /** Live tick for a subscribed option contract: updates its bid/ask/last in place. */
  applyContractQuote(quote: Quote): void {
    const { chain } = this.getState();
    if (!chain || !chain.contracts.some((contract) => contract.symbol === quote.symbol)) return;
    this.set({
      chain: {
        ...chain,
        contracts: chain.contracts.map((contract) =>
          contract.symbol === quote.symbol
            ? { ...contract, bid: quote.bid, ask: quote.ask, last: quote.last }
            : contract,
        ),
      },
    });
  }

  // MARK: - Loading

  async load(underlying: string): Promise<void> {
    const gen = ++this.loadGeneration;
    if (this.getState().underlying !== underlying) {
      // New underlying: reset selection state.
      this.loadedExpirations = new Set();
      this.set({
        chain: null,
        selectedExpiration: null,
        selectedStrike: null,
        underlyingLast: null,
      });
    }
    this.set({ underlying, isLoading: true, errorMessage: null });
    try {
      const dto = await this.apiClient.optionsChain(underlying);
      if (gen !== this.loadGeneration) return;
      const chain: OptionsChain = { ...dto, contracts: [...dto.contracts] };
      const loaded = new Set(chain.contracts.map((contract) => contract.expiration));
      const nearest = nearestExpiration(chain.expirations);
      if (nearest !== null && !loaded.has(nearest)) {
        const extra = await this.fetchContracts(underlying, nearest);
        if (gen !== this.loadGeneration) return;
        if (extra) {
          chain.contracts.push(...extra);
          loaded.add(nearest);
        }
      }
      this.loadedExpirations = loaded;
      this.set({ chain });
      const { selectedExpiration, selectedStrike } = this.getState();
      if (selectedExpiration === null || !chain.expirations.includes(selectedExpiration)) {
        this.set({ selectedExpiration: nearest ?? chain.expirations[0] ?? null });
      }
      if (selectedStrike === null) {
        const auto = this.autoContract;
        if (auto) this.set({ selectedStrike: auto.strike });
      }
    } catch (error) {
      if (gen !== this.loadGeneration) return;
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      if (gen === this.loadGeneration) this.set({ isLoading: false });
    }
  }

  /**
   * Background re-fetch of the loaded chain's quotes (bid/ask/underlyingPrice)
   * without touching selections. Errors are swallowed: the last good chain
   * stays up rather than toasting every failed 30s tick.
   */
  async refresh(): Promise<void> {
    const { underlying, chain, selectedExpiration, isLoading } = this.getState();
    if (!underlying || !chain || isLoading) return;
    const gen = this.loadGeneration;
    try {
      const dto = await this.apiClient.optionsChain(underlying, selectedExpiration ?? undefined);
      if (gen !== this.loadGeneration) return;
      const current = this.getState().chain;
      if (!current) return;
      const updated = new Map(dto.contracts.map((contract) => [contract.symbol, contract]));
      const known = new Set(current.contracts.map((contract) => contract.symbol));
      const merged = current.contracts.map((contract) => updated.get(contract.symbol) ?? contract);
      const additions = dto.contracts.filter((contract) => !known.has(contract.symbol));
      this.set({
        chain: {
          ...current,
          underlyingPrice: dto.underlyingPrice,
          contracts: [...merged, ...additions],
        },
      });
    } catch {
      // Keep the last good chain.
    }
  }

  /** Expiration picker change; lazily fetches that expiration's contracts. */
  selectExpiration(expiration: string): void {
    if (expiration === this.getState().selectedExpiration) return;
    this.set({ selectedExpiration: expiration, selectedStrike: null });
    void this.ensureContracts(expiration);
  }

  private async ensureContracts(expiration: string): Promise<void> {
    const { underlying } = this.getState();
    const gen = this.loadGeneration;
    if (!underlying || this.loadedExpirations.has(expiration)) return;
    try {
      const contracts = await this.fetchContracts(underlying, expiration);
      // A load() that started meanwhile owns the chain now.
      if (gen !== this.loadGeneration) return;
      const { chain } = this.getState();
      if (contracts && chain) {
        this.set({ chain: { ...chain, contracts: [...chain.contracts, ...contracts] } });
        this.loadedExpirations.add(expiration);
        if (this.getState().selectedStrike === null) {
          const auto = this.autoContract;
          if (auto) this.set({ selectedStrike: auto.strike });
        }
      }
    } catch (error) {
      if (gen !== this.loadGeneration) return;
      this.set({ errorMessage: errorMessage(error) });
    }
  }

  private async fetchContracts(
    underlying: string,
    expiration: string,
  ): Promise<OptionContract[] | null> {
    const dto = await this.apiClient.optionsChain(underlying, expiration);
    return dto.contracts.filter((contract) => contract.expiration === expiration);
  }

  /** Manual-mode strike setter. */
  selectStrike(strike: number): void {
    this.set({ selectedStrike: strike });
  }
}
