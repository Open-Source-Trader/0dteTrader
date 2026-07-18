import Foundation

/// Loads and holds the live options chain for the chart's underlying and drives
/// the trade panel's expiration / strike / AUTO-mode selection (PRD FR-13..16).
@MainActor
final class OptionsChainViewModel: ObservableObject {
    @Published private(set) var underlying: String = ""
    @Published private(set) var chain: OptionsChain?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    @Published var optionType: OptionType = .call
    @Published var isAutoMode = true
    @Published private(set) var selectedExpiration: String?
    @Published var selectedStrike: Double?
    /// Live last price of the underlying (wired from the quote stream);
    /// AUTO uses it over the chain-load snapshot.
    @Published var underlyingLast: Double?

    private let apiClient: APIClient
    /// Expirations whose contracts are already present locally.
    private var loadedExpirations: Set<String> = []
    /// Bumped by every load(); in-flight fetches bail after each await when a
    /// newer load has started, so a slow response can't clobber a newer symbol.
    private var loadGeneration = 0

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    var expirations: [String] {
        chain?.expirations ?? []
    }

    /// Sorted unique strikes for the selected expiration + call/put.
    var strikes: [Double] {
        guard let chain, let selectedExpiration else { return [] }
        let values = chain.contracts
            .filter { $0.optionType == optionType && $0.expiration == selectedExpiration }
            .map(\.strike)
        return Array(Set(values)).sorted()
    }

    /// The contract AUTO mode would trade right now (FR-15).
    var autoContract: OptionContract? {
        guard let chain else { return nil }
        return AutoContractSelector.selectAutoOTM(
            chain: chain,
            optionType: optionType,
            expiration: selectedExpiration,
            last: underlyingLast
        )
    }

    /// The contract the ticket resolves to: AUTO's pick, or the manually
    /// selected expiration+strike in manual mode.
    var selectedContract: OptionContract? {
        if isAutoMode {
            return autoContract
        }
        guard let chain, let selectedExpiration, let selectedStrike else { return nil }
        return chain.contracts.first {
            $0.optionType == optionType
                && $0.expiration == selectedExpiration
                && $0.strike == selectedStrike
        }
    }

    // MARK: - Loading

    func load(underlying: String) async {
        loadGeneration += 1
        let gen = loadGeneration
        if self.underlying != underlying {
            // New underlying: reset selection state.
            chain = nil
            selectedExpiration = nil
            selectedStrike = nil
            underlyingLast = nil
            loadedExpirations = []
        }
        self.underlying = underlying
        isLoading = true
        errorMessage = nil
        defer {
            if gen == loadGeneration { isLoading = false }
        }
        do {
            let dto = try await apiClient.optionsChain(symbol: underlying, expiration: nil)
            guard gen == loadGeneration else { return }
            var chain = OptionsChain(dto: dto)
            // If the server returns all expirations but only one expiration's
            // contracts, fetch the rest lazily via selectExpiration().
            var loaded = Set(chain.contracts.map(\.expiration))
            let nearest = AutoContractSelector.nearestExpiration(chain.expirations)
            if let nearest, !loaded.contains(nearest) {
                if let extra = try await fetchContracts(underlying: underlying, expiration: nearest) {
                    guard gen == loadGeneration else { return }
                    chain.contracts.append(contentsOf: extra)
                    loaded.insert(nearest)
                }
                guard gen == loadGeneration else { return }
            }
            loadedExpirations = loaded
            self.chain = chain
            if selectedExpiration == nil || !chain.expirations.contains(selectedExpiration ?? "") {
                selectedExpiration = nearest ?? chain.expirations.first
            }
            if selectedStrike == nil, let auto = autoContract {
                selectedStrike = auto.strike
            }
        } catch let error as APIError {
            guard gen == loadGeneration else { return }
            errorMessage = error.userMessage
        } catch {
            guard gen == loadGeneration else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// Live tick for a subscribed option contract: updates its bid/ask/last in place.
    func applyContractQuote(_ quote: Quote) {
        guard var chain,
              let index = chain.contracts.firstIndex(where: { $0.symbol == quote.symbol })
        else { return }
        let old = chain.contracts[index]
        chain.contracts[index] = OptionContract(
            symbol: old.symbol,
            underlying: old.underlying,
            expiration: old.expiration,
            strike: old.strike,
            optionType: old.optionType,
            bid: quote.bid,
            ask: quote.ask,
            last: quote.last
        )
        self.chain = chain
    }

    /// Background re-fetch of the loaded chain's quotes (bid/ask/underlyingPrice)
    /// without touching selections. Errors are swallowed: the last good chain
    /// stays up rather than toasting every failed 30s tick.
    func refresh() async {
        guard !underlying.isEmpty, chain != nil, !isLoading else { return }
        let underlying = self.underlying
        let gen = loadGeneration
        do {
            let dto = try await apiClient.optionsChain(symbol: underlying, expiration: selectedExpiration)
            guard gen == loadGeneration, let current = chain else { return }
            let fresh = OptionsChain(dto: dto)
            let updated = Dictionary(fresh.contracts.map { ($0.symbol, $0) }, uniquingKeysWith: { _, new in new })
            let known = Set(current.contracts.map(\.symbol))
            var merged = current.contracts.map { updated[$0.symbol] ?? $0 }
            merged.append(contentsOf: fresh.contracts.filter { !known.contains($0.symbol) })
            chain = OptionsChain(
                underlying: current.underlying,
                underlyingPrice: fresh.underlyingPrice,
                expirations: current.expirations,
                contracts: merged
            )
        } catch {
            // Keep the last good chain.
        }
    }

    /// Expiration picker change: fetches that expiration's contracts if the
    /// initial chain response didn't include them.
    func selectExpiration(_ expiration: String) {
        guard expiration != selectedExpiration else { return }
        selectedExpiration = expiration
        selectedStrike = nil
        Task { await ensureContracts(for: expiration) }
    }

    func ensureContracts(for expiration: String) async {
        let underlying = self.underlying
        let gen = loadGeneration
        guard !underlying.isEmpty, !loadedExpirations.contains(expiration) else { return }
        do {
            if let contracts = try await fetchContracts(underlying: underlying, expiration: expiration) {
                // A load() that started meanwhile owns the chain now.
                guard gen == loadGeneration else { return }
                chain?.contracts.append(contentsOf: contracts)
                loadedExpirations.insert(expiration)
                if selectedStrike == nil, let auto = autoContract {
                    selectedStrike = auto.strike
                }
            }
        } catch let error as APIError {
            guard gen == loadGeneration else { return }
            errorMessage = error.userMessage
        } catch {
            guard gen == loadGeneration else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func fetchContracts(underlying: String, expiration: String) async throws -> [OptionContract]? {
        let dto = try await apiClient.optionsChain(symbol: underlying, expiration: expiration)
        return OptionsChain(dto: dto).contracts.filter { $0.expiration == expiration }
    }

    /// Manual-mode strike setter; ignores values not on the chain.
    func selectStrike(_ strike: Double) {
        selectedStrike = strike
    }
}
