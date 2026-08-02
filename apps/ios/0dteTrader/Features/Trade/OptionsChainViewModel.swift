import Foundation

/// Loads and holds the live options chain for the chart's underlying and drives
/// the trade panel's expiration / strike / AUTO-mode selection (PRD FR-13..16).
@MainActor
final class OptionsChainViewModel: ObservableObject {
    @Published private(set) var underlying: String = ""
    /// Backing storage for `chain`, written directly (bypassing the
    /// publishing setter below) when a tick updates a contract other than the
    /// one on screen — see `applyContractQuote`.
    private var chainStorage: OptionsChain?
    /// `TradePanelView`/`OrderPricingRow` hold this view model as
    /// `@ObservedObject` and re-render their whole body on any publish, and
    /// the only chain data either displays is `selectedContract`. Publishing
    /// on every tick would re-render the trade panel for a price nobody is
    /// showing whenever a held position's contract isn't the selected one.
    private(set) var chain: OptionsChain? {
        get { chainStorage }
        set {
            objectWillChange.send()
            chainStorage = newValue
        }
    }
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    @Published var optionType: OptionType = .call
    @Published var isAutoMode = true {
        didSet { if isAutoMode { isCurrMode = false } }
    }
    /// CURR mode: the ticket trades only contracts already held (FR follow-up
    /// to AUTO). Mutually exclusive with AUTO — turning either on turns the
    /// other off — and it filters the expiration/strike menus to holdings.
    @Published var isCurrMode = false {
        didSet {
            guard isCurrMode != oldValue else { return }
            if isCurrMode {
                isAutoMode = false
                preselectMostRecentHolding()
            }
        }
    }
    @Published private(set) var selectedExpiration: String?
    @Published var selectedStrike: Double?
    /// Live last price of the underlying (wired from the quote stream);
    /// AUTO uses it over the chain-load snapshot.
    @Published var underlyingLast: Double?

    /// Open positions for CURR mode's held-contract filter; wired by the
    /// trade screen to the trade view model's live positions.
    var positionsProvider: () -> [Position] = { [] }

    private let apiClient: APIClient
    /// AUTO's strikes-OTM preference (Profile → AUTO selection); injected so
    /// this view model never touches UserDefaults directly.
    private let autoOtmOffsetProvider: () -> Int
    /// Expirations whose contracts are already present locally.
    private var loadedExpirations: Set<String> = []
    /// Bumped by every load(); in-flight fetches bail after each await when a
    /// newer load has started, so a slow response can't clobber a newer symbol.
    private var loadGeneration = 0

    init(apiClient: APIClient, autoOtmOffset: @escaping () -> Int = { 1 }) {
        self.apiClient = apiClient
        self.autoOtmOffsetProvider = autoOtmOffset
    }

    /// The offset AUTO is walking with right now — also what arm() sends so
    /// the server resolves the same contract the panel shows.
    var autoOtmOffset: Int {
        autoOtmOffsetProvider()
    }

    var expirations: [String] {
        if isCurrMode {
            return Array(Set(heldContracts.map(\.expiration))).sorted()
        }
        return chain?.expirations ?? []
    }

    /// Sorted unique strikes for the selected expiration + call/put. CURR
    /// mode narrows the pool to held contracts.
    var strikes: [Double] {
        guard let chain, let selectedExpiration else { return [] }
        let pool = isCurrMode ? heldContracts : chain.contracts
        let values = pool
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
            last: underlyingLast,
            otmOffset: autoOtmOffsetProvider()
        )
    }

    /// The contract the ticket resolves to: AUTO's pick, a held contract in
    /// CURR mode, or the manually selected expiration+strike otherwise.
    var selectedContract: OptionContract? {
        if isCurrMode {
            guard let selectedExpiration, let selectedStrike else { return nil }
            return heldContracts.first {
                $0.optionType == optionType
                    && $0.expiration == selectedExpiration
                    && $0.strike == selectedStrike
            }
        }
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

    // MARK: - CURR mode holdings

    /// Held (long) positions resolved to contracts on the loaded chain for
    /// the chart's underlying — what CURR mode lets the panel pick from. A
    /// position whose contract the chain cannot identify is left out, same as
    /// the flatten path's resolver.
    private var heldLegs: [(position: Position, contract: OptionContract)] {
        guard let chain else { return [] }
        return positionsProvider().compactMap { position in
            guard position.quantity > 0,
                  let contract = chain.contracts.first(where: { $0.symbol == position.symbol }),
                  contract.underlying == underlying
            else { return nil }
            return (position, contract)
        }
    }

    var heldContracts: [OptionContract] {
        heldLegs.map(\.contract)
    }

    /// Whether CURR has anything to offer — the chip disables itself otherwise.
    var hasHeldContracts: Bool {
        !heldLegs.isEmpty
    }

    /// CURR just switched on: land the pickers on the most recently opened
    /// holding (max `openedAt`; when no position carries a record, the first
    /// held one).
    private func preselectMostRecentHolding() {
        let legs = heldLegs
        guard !legs.isEmpty else { return }
        let mostRecent: (position: Position, contract: OptionContract)
        if legs.contains(where: { $0.position.openedAt != nil }) {
            mostRecent = legs.max { lhs, rhs in
                (lhs.position.openedAt ?? .distantPast) < (rhs.position.openedAt ?? .distantPast)
            } ?? legs[0]
        } else {
            mostRecent = legs[0]
        }
        optionType = mostRecent.contract.optionType
        selectedExpiration = mostRecent.contract.expiration
        selectedStrike = mostRecent.contract.strike
    }

    #if DEBUG
    /// Seeds a chain and selection without a network round trip (tests only).
    func setChainForTesting(_ chain: OptionsChain, expiration: String, strike: Double) {
        self.chain = chain
        self.underlying = chain.underlying
        self.selectedExpiration = expiration
        self.selectedStrike = strike
        self.isAutoMode = false
    }
    #endif

    // MARK: - Loading

    func load(underlying: String) async {
        loadGeneration += 1
        let gen = loadGeneration
        if self.underlying != underlying {
            // New underlying: reset selection state. CURR is per-underlying —
            // the owned legs it was scoped to belong to the old symbol.
            chain = nil
            isCurrMode = false
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
            if !Self.isCredentialError(error) {
                errorMessage = error.userMessage
            }
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
        // Duplicate ticks (unchanged bid/ask/last) are common on a busy stream;
        // skipping them avoids both the array copy below and a @Published
        // notification/SwiftUI re-render for a value that hasn't moved.
        guard old.bid != quote.bid || old.ask != quote.ask || old.last != quote.last else { return }
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
        // A tick for anything other than the contract on screen changes
        // nothing the trade panel shows — write it through without
        // publishing so a held position's quote doesn't re-render the panel
        // (see `chain`'s doc comment).
        if quote.symbol == selectedContract?.symbol {
            self.chain = chain
        } else {
            chainStorage = chain
        }
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
        if isCurrMode {
            // Held contracts are already on the chain (that is what qualified
            // them), so nothing to fetch — land on the first held strike
            // rather than reseeding from AUTO's possibly un-held pick.
            selectedStrike = strikes.first
            return
        }
        Task { await ensureContracts(for: expiration) }
    }

    func ensureContracts(for expiration: String) async {
        let underlying = self.underlying
        let gen = loadGeneration
        guard !underlying.isEmpty, !loadedExpirations.contains(expiration) else {
            // Contracts are already local (revisiting a prior expiration) —
            // manual mode still needs its strike reseeded.
            if selectedStrike == nil, let auto = autoContract {
                selectedStrike = auto.strike
            }
            return
        }
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
            if !Self.isCredentialError(error) {
                errorMessage = error.userMessage
            }
        } catch {
            guard gen == loadGeneration else { return }
            errorMessage = error.localizedDescription
        }
    }

    private static func isCredentialError(_ error: APIError) -> Bool {
        if case let .server(_, message, _) = error {
            return message.lowercased().contains("credentials")
        }
        return false
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
