import XCTest
@testable import ZeroDTETrader

/// The toast toggle gates success/info banners only — errors always surface.
@MainActor
final class TradeViewModelToastTests: XCTestCase {
    private func makeViewModel() -> TradeViewModel {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(keychainStore: KeychainStore(service: "test.toast"), baseURL: baseURL)
        return TradeViewModel(apiClient: APIClient(baseURL: baseURL, sessionStore: sessionStore))
    }

    func testPolicyOff_suppressesSuccessAndInfo() {
        let viewModel = makeViewModel()
        viewModel.toastPolicy = { false }

        viewModel.showToast("filled", style: .success)
        XCTAssertNil(viewModel.toast)

        viewModel.showToast("update", style: .info)
        XCTAssertNil(viewModel.toast)
    }

    func testPolicyOff_errorsStillShow() {
        let viewModel = makeViewModel()
        viewModel.toastPolicy = { false }

        viewModel.showToast("rejected", style: .error)

        XCTAssertEqual(viewModel.toast?.message, "rejected")
    }

    func testPolicyOn_showsEverything() {
        let viewModel = makeViewModel()
        viewModel.toastPolicy = { true }

        viewModel.showToast("filled", style: .success)

        XCTAssertEqual(viewModel.toast?.message, "filled")
    }

    /// Nil policy (previews/tests that never wire it) keeps the old behaviour.
    func testNoPolicy_showsEverything() {
        let viewModel = makeViewModel()

        viewModel.showToast("update", style: .info)

        XCTAssertEqual(viewModel.toast?.message, "update")
    }
}
