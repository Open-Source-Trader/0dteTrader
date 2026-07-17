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

    private let apiClient: APIClient
    /// Expirations whose contracts are already present locally.
    private var loadedExpirations: Set<String> = []

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
            expiration: selectedExpiration
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
        guard !isLoading else { return }
        if self.underlying != underlying {
            // New underlying: reset selection state.
            chain = nil
            selectedExpiration = nil
            selectedStrike = nil
            loadedExpirations = []
        }
        self.underlying = underlying
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let dto = try await apiClient.optionsChain(symbol: underlying, expiration: nil)
            var chain = OptionsChain(dto: dto)
            // If the server returns all expirations but only one expiration's
            // contracts, fetch the rest lazily via selectExpiration().
            loadedExpirations = Set(chain.contracts.map(\.expiration))
            let nearest = AutoContractSelector.nearestExpiration(chain.expirations)
            if let nearest, !loadedExpirations.contains(nearest) {
                if let extra = try await fetchContracts(underlying: underlying, expiration: nearest) {
                    chain.contracts.append(contentsOf: extra)
                    loadedExpirations.insert(nearest)
                }
            }
            self.chain = chain
            if selectedExpiration == nil || !chain.expirations.contains(selectedExpiration ?? "") {
                selectedExpiration = nearest ?? chain.expirations.first
            }
            if selectedStrike == nil, let auto = autoContract {
                selectedStrike = auto.strike
            }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
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
        guard !underlying.isEmpty, !loadedExpirations.contains(expiration) else { return }
        do {
            if let contracts = try await fetchContracts(underlying: underlying, expiration: expiration) {
                chain?.contracts.append(contentsOf: contracts)
                loadedExpirations.insert(expiration)
                if selectedStrike == nil, let auto = autoContract {
                    selectedStrike = auto.strike
                }
            }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
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
