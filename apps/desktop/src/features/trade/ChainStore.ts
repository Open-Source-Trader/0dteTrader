import type { OptionContract, OptionType, OptionsChain } from '@0dtetrader/shared-types';
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
}

/**
 * Options chain + expiration/strike/AUTO selection state
 * (OptionsChainViewModel.swift analog), including the lazy per-expiration
 * contract fetch.
 */
export class ChainStore extends Store<ChainStoreState> {
  /** Expirations whose contracts are already present locally. */
  private loadedExpirations = new Set<string>();

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
    const { chain, optionType, selectedExpiration } = this.getState();
    if (!chain) return null;
    return selectAutoOTM(chain, optionType, selectedExpiration);
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

  // MARK: - Loading

  async load(underlying: string): Promise<void> {
    if (this.getState().isLoading) return;
    if (this.getState().underlying !== underlying) {
      // New underlying: reset selection state.
      this.loadedExpirations = new Set();
      this.set({ chain: null, selectedExpiration: null, selectedStrike: null });
    }
    this.set({ underlying, isLoading: true, errorMessage: null });
    try {
      const dto = await this.apiClient.optionsChain(underlying);
      const chain: OptionsChain = { ...dto, contracts: [...dto.contracts] };
      this.loadedExpirations = new Set(chain.contracts.map((contract) => contract.expiration));
      const nearest = nearestExpiration(chain.expirations);
      if (nearest !== null && !this.loadedExpirations.has(nearest)) {
        const extra = await this.fetchContracts(underlying, nearest);
        if (extra) {
          chain.contracts.push(...extra);
          this.loadedExpirations.add(nearest);
        }
      }
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
      this.set({ errorMessage: errorMessage(error) });
    } finally {
      this.set({ isLoading: false });
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
    if (!underlying || this.loadedExpirations.has(expiration)) return;
    try {
      const contracts = await this.fetchContracts(underlying, expiration);
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
