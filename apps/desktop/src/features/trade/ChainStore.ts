import type {
  OptionContract,
  OptionType,
  OptionsChain,
  Position,
  Quote,
} from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { errorMessage } from '../../core/api/ApiError';
import { Store } from '../../core/observable';
import { parseOccSymbol } from '../../core/models/occSymbol';
import type { SettingsStore } from '../../core/storage/SettingsStore';
import { nearestExpiration, selectAutoOTM } from './autoContractSelector';

interface ChainStoreState {
  underlying: string;
  chain: OptionsChain | null;
  isLoading: boolean;
  errorMessage: string | null;
  optionType: OptionType;
  isAutoMode: boolean;
  /** CURR mode: pick among currently-owned contracts only. Excludes AUTO. */
  isCurrMode: boolean;
  selectedExpiration: string | null;
  selectedStrike: number | null;
  /** Live last price of the underlying; AUTO uses it over the chain snapshot. */
  underlyingLast: number | null;
}

/** An owned long leg on this chain's underlying, resolved through the chain. */
interface CurrLeg {
  position: Position;
  contract: OptionContract;
}

/** Most recently opened leg: max `openedAt`; legs without one lose, and when
 *  none carries it the first in the positions array wins. */
function mostRecentLeg(legs: CurrLeg[]): CurrLeg | null {
  if (legs.length === 0) return null;
  let best = legs[0];
  for (const leg of legs) {
    const opened = leg.position.openedAt;
    if (opened && (!best.position.openedAt || opened > best.position.openedAt)) best = leg;
  }
  return best;
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

  /** Open positions source for CURR mode; wired from the container
   *  (TradeStore owns positions). Null only in tests. */
  positionsProvider: (() => Position[]) | null = null;

  constructor(
    private readonly apiClient: ApiClient,
    /** AUTO-offset preference source; absent (tests) falls back to +1. */
    private readonly settings?: Pick<SettingsStore, 'autoOtmOffset'>,
  ) {
    super({
      underlying: '',
      chain: null,
      isLoading: false,
      errorMessage: null,
      optionType: 'call',
      isAutoMode: true,
      isCurrMode: false,
      selectedExpiration: null,
      selectedStrike: null,
      underlyingLast: null,
    });
  }

  /** Owned long legs on this chain's underlying (CURR mode's universe).
   *  Resolved through the loaded chain when possible (live quotes), else from
   *  the OCC symbol itself — the chain only carries one expiration's contracts
   *  at a time, and a holding on a not-yet-fetched expiration must still show
   *  up. Synthesized legs carry zero quotes until their expiration loads. */
  get currLegs(): CurrLeg[] {
    const { chain, underlying } = this.getState();
    if (!chain) return [];
    const positions = this.positionsProvider?.() ?? [];
    const legs: CurrLeg[] = [];
    for (const position of positions) {
      if (position.quantity <= 0) continue;
      const onChain = chain.contracts.find((contract) => contract.symbol === position.symbol);
      if (onChain) {
        if (onChain.underlying === underlying) legs.push({ position, contract: onChain });
        continue;
      }
      const parsed = parseOccSymbol(position.symbol);
      if (!parsed || parsed.underlying !== underlying) continue;
      legs.push({
        position,
        contract: {
          symbol: position.symbol,
          underlying: parsed.underlying,
          expiration: parsed.expiration,
          strike: parsed.strike,
          optionType: parsed.optionType,
          bid: 0,
          ask: 0,
          last: 0,
        },
      });
    }
    return legs;
  }

  /** CURR legs on the currently selected side — the CALL/PUT toggle picks
   *  which holdings CURR is operating on. */
  private currLegsOfSelectedType(): CurrLeg[] {
    const { optionType } = this.getState();
    return this.currLegs.filter((leg) => leg.contract.optionType === optionType);
  }

  /** Whether an open long exists for the chart underlying (CURR chip gate —
   *  either side; the CALL/PUT toggle chooses which side inside the mode). */
  get hasCurrPositions(): boolean {
    return this.currLegs.length > 0;
  }

  get expirations(): string[] {
    const { chain, isCurrMode } = this.getState();
    if (!chain) return [];
    if (isCurrMode) {
      return [
        ...new Set(this.currLegsOfSelectedType().map((leg) => leg.contract.expiration)),
      ].sort();
    }
    return chain.expirations;
  }

  /** Sorted unique strikes for the selected expiration + call/put; CURR mode
   *  lists only owned contracts. */
  get strikes(): number[] {
    const { chain, selectedExpiration, optionType, isCurrMode } = this.getState();
    if (!chain || !selectedExpiration) return [];
    const contracts = isCurrMode ? this.currLegs.map((leg) => leg.contract) : chain.contracts;
    const values = contracts
      .filter(
        (contract) =>
          contract.optionType === optionType && contract.expiration === selectedExpiration,
      )
      .map((contract) => contract.strike);
    return [...new Set(values)].sort((a, b) => a - b);
  }

  /** AUTO's configured distance from the ATM anchor (Profile preference). */
  get autoOtmOffset(): number {
    return this.settings?.autoOtmOffset ?? 1;
  }

  /** The contract AUTO mode would trade right now. */
  get autoContract(): OptionContract | null {
    const { chain, optionType, selectedExpiration, underlyingLast } = this.getState();
    if (!chain) return null;
    return selectAutoOTM(chain, optionType, selectedExpiration, underlyingLast, this.autoOtmOffset);
  }

  /** The contract the ticket resolves to (AUTO pick, or manual exp+strike). */
  get selectedContract(): OptionContract | null {
    const { chain, isAutoMode, isCurrMode, optionType, selectedExpiration, selectedStrike } =
      this.getState();
    if (isAutoMode) return this.autoContract;
    if (!chain || selectedExpiration === null || selectedStrike === null) return null;
    // CURR resolves among owned legs only: a selection left over from before
    // the mode (or from the other side of the CALL/PUT toggle) must never
    // quietly resolve to a contract the user does not hold.
    const pool = isCurrMode
      ? this.currLegsOfSelectedType().map((leg) => leg.contract)
      : chain.contracts;
    return (
      pool.find(
        (contract) =>
          contract.optionType === optionType &&
          contract.expiration === selectedExpiration &&
          contract.strike === selectedStrike,
      ) ?? null
    );
  }

  setOptionType(optionType: OptionType): void {
    this.set({ optionType });
    // CURR follows the CALL/PUT toggle: flipping sides re-lands the pickers on
    // that side's most recent holding (or clears them when none is held).
    if (this.getState().isCurrMode) this.preselectCurrLeg();
  }

  setAutoMode(isAutoMode: boolean): void {
    // AUTO and CURR are mutually exclusive pickers.
    this.set(isAutoMode ? { isAutoMode, isCurrMode: false } : { isAutoMode });
  }

  /** CURR mode: restrict the pickers to currently-owned contracts on the
   *  selected side. Turning it on leaves AUTO and preselects the most
   *  recently opened holding — of the toggled side when one is held there,
   *  else flipping the toggle to the side that is. */
  setCurrMode(isCurrMode: boolean): void {
    if (!isCurrMode) {
      this.set({ isCurrMode: false });
      return;
    }
    this.set({ isCurrMode: true, isAutoMode: false });
    if (this.currLegsOfSelectedType().length === 0) {
      const recent = mostRecentLeg(this.currLegs);
      if (recent) this.set({ optionType: recent.contract.optionType });
    }
    this.preselectCurrLeg();
  }

  /** Lands the CURR pickers on the selected side's most recently opened
   *  holding; a side with nothing held clears them (menus go empty and the
   *  ticket refuses to arm rather than resolving an un-owned contract). */
  private preselectCurrLeg(): void {
    const recent = mostRecentLeg(this.currLegsOfSelectedType());
    this.set(
      recent
        ? {
            selectedExpiration: recent.contract.expiration,
            selectedStrike: recent.contract.strike,
          }
        : { selectedExpiration: null, selectedStrike: null },
    );
    // A holding on a not-yet-fetched expiration was resolved from its OCC
    // symbol; fetch that expiration's contracts so quotes fill in.
    if (recent) void this.ensureContracts(recent.contract.expiration);
  }

  /** Live tick for the chain's underlying (wired from the quote stream). */
  setUnderlyingLast(last: number): void {
    this.set({ underlyingLast: last });
  }

  /** Live tick for a subscribed option contract: updates its bid/ask/last in place. */
  applyContractQuote(quote: Quote): void {
    const { chain } = this.getState();
    if (!chain) return;
    const index = chain.contracts.findIndex((contract) => contract.symbol === quote.symbol);
    if (index === -1) return;
    const contract = chain.contracts[index];
    if (contract.bid === quote.bid && contract.ask === quote.ask && contract.last === quote.last) {
      return;
    }
    const contracts = chain.contracts.slice();
    contracts[index] = { ...contract, bid: quote.bid, ask: quote.ask, last: quote.last };
    this.set({ chain: { ...chain, contracts } });
  }

  // MARK: - Loading

  async load(underlying: string): Promise<void> {
    const gen = ++this.loadGeneration;
    if (this.getState().underlying !== underlying) {
      // New underlying: reset selection state. CURR is per-underlying — the
      // owned legs it was scoped to belong to the old symbol.
      this.loadedExpirations = new Set();
      this.set({
        chain: null,
        isCurrMode: false,
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
      const updated = new Map(
        dto.contracts.map((contract: OptionContract) => [contract.symbol, contract]),
      );
      const known = new Set(current.contracts.map((contract: OptionContract) => contract.symbol));
      const merged = current.contracts.map(
        (contract: OptionContract) => updated.get(contract.symbol) ?? contract,
      );
      const additions = dto.contracts.filter(
        (contract: OptionContract) => !known.has(contract.symbol),
      );
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
    if (this.getState().isCurrMode) {
      // CURR: land on the selected side's most recently opened leg of that
      // expiration rather than leaving the strike empty (its menu only lists
      // owned ones). The CALL/PUT toggle stays the user's — never overridden.
      const recent = mostRecentLeg(
        this.currLegsOfSelectedType().filter((leg) => leg.contract.expiration === expiration),
      );
      if (recent) this.set({ selectedStrike: recent.contract.strike });
    }
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
    return dto.contracts.filter((contract: OptionContract) => contract.expiration === expiration);
  }

  /** Manual-mode strike setter. */
  selectStrike(strike: number): void {
    this.set({ selectedStrike: strike });
  }
}
