import SwiftUI
import UIKit
import XCTest
@testable import ZeroDTETrader

/// The order confirmation is an anchored popup like the chart's pickers, and
/// unlike them it is the last gate in front of a real order. These are the two
/// properties that difference buys: a tap outside cancels rather than confirms,
/// and nothing in it is out of view at the size it is drawn.
@MainActor
final class OrderConfirmPopupTests: XCTestCase {
    private func makeViewModels() -> (TradeViewModel, OptionsChainViewModel) {
        let baseURL = URL(string: "http://localhost:0")!
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: "test.confirm"),
            baseURL: baseURL
        )
        let apiClient = APIClient(baseURL: baseURL, sessionStore: sessionStore)
        return (TradeViewModel(apiClient: apiClient), OptionsChainViewModel(apiClient: apiClient))
    }

    private func armed() -> (TradeViewModel, ArmedOrderTicket) {
        let (tradeViewModel, chainViewModel) = makeViewModels()
        chainViewModel.isAutoMode = true
        tradeViewModel.arm(side: .buy, underlying: "SPY", chainViewModel: chainViewModel)
        return (tradeViewModel, tradeViewModel.armedTicket!)
    }

    // MARK: - Tapping away cancels

    func testUserDismiss_cancelsTheArmedOrder() {
        let (tradeViewModel, _) = armed()
        XCTAssertNotNil(tradeViewModel.armedTicket)

        OrderConfirmPopup.handleUserDismiss(tradeViewModel)

        // Cancelled, and nothing was submitted: the ticket is gone and no
        // submission ever started.
        XCTAssertNil(tradeViewModel.armedTicket)
        XCTAssertFalse(tradeViewModel.isSubmitting)
    }

    func testUserDismiss_whileSubmitting_keepsTheTicketAndThePopup() async {
        let (tradeViewModel, _) = armed()
        let submission = Task { await tradeViewModel.confirmArmedOrder() }
        // `confirmArmedOrder` flips `isSubmitting` before its first await, so
        // yielding until it does lands us inside the in-flight window without
        // depending on how fast the (refused) request comes back.
        for _ in 0..<100 where !tradeViewModel.isSubmitting {
            await Task.yield()
        }
        XCTAssertTrue(tradeViewModel.isSubmitting)

        OrderConfirmPopup.handleUserDismiss(tradeViewModel)

        // The order may still fill; the popup is where its result lands, so a
        // stray tap must not take it away.
        XCTAssertNotNil(tradeViewModel.armedTicket)
        await submission.value
    }

    /// The controller-level half of the same guarantee: a popup that supplied
    /// `onUserDismiss` has its scrim routed there, and the controller does not
    /// close it behind the callback's back.
    func testHudMenuController_userDismiss_routesThroughTheCallback() {
        let controller = HudMenuController()
        var cancelled = 0
        controller.present(
            id: OrderConfirmPopup.popupID,
            anchor: .zero,
            edge: .trailing,
            onUserDismiss: { cancelled += 1 },
            content: { _ in AnyView(EmptyView()) }
        )

        controller.userDismiss()

        XCTAssertEqual(cancelled, 1)
        XCTAssertNotNil(controller.presentation)
    }

    /// And the pickers are unchanged: no callback, so the scrim just closes.
    func testHudMenuController_userDismiss_withoutCallback_closes() {
        let controller = HudMenuController()
        controller.present(id: "symbol", anchor: .zero, edge: .leading) { _ in
            AnyView(EmptyView())
        }

        controller.userDismiss()

        XCTAssertNil(controller.presentation)
    }

    // MARK: - Nothing is clipped

    /// Room above the SELL/BUY row on the smallest screen the app supports.
    ///
    /// Portrait-only, iOS 17, so that is the iPhone SE at 375x667pt. The row is
    /// pinned near the bottom in both layouts — `AppSpacing.lg` above the safe
    /// area in fullscreen, the panel's own padding in split — so it starts no
    /// higher than 667 - 16 - 60 = 591pt. `HudMenuLayer` then takes its 6pt gap,
    /// the 20pt status bar and its 8pt screen inset off the top, leaving 557pt.
    /// Budgeted at 520 so the assertion has somewhere to fail before the panel
    /// starts scrolling.
    private static let smallestScreenBudget: CGFloat = 520
    /// 375pt wide, less the layer's 8pt inset on each side.
    private static let smallestScreenWidth: CGFloat = 375 - 16

    func testContent_fitsAboveTheTradeButtonsOnTheSmallestScreen() {
        let (tradeViewModel, ticket) = armed()
        // The tallest state that ships: a resolved preview with a spread, a
        // typed limit and the far-from-market warning under it.
        tradeViewModel.setPreviewForTesting(
            OrderPreview(
                contractSymbol: "SPY260727C00505000",
                price: 1.01,
                estBuyingPower: 101,
                bid: 1.0,
                ask: 1.02,
                warnings: [
                    "Your limit price is far from the current market. "
                        + "Check the premium before confirming."
                ]
            )
        )

        let host = UIHostingController(
            rootView: OrderConfirmPopup(tradeViewModel: tradeViewModel, ticket: ticket).content
        )
        let size = host.sizeThatFits(
            in: CGSize(width: Self.smallestScreenWidth, height: 10_000)
        )

        XCTAssertLessThanOrEqual(size.height, Self.smallestScreenBudget)
        // A floor too: a measurement that collapsed to nothing would pass the
        // ceiling while proving the opposite of what this test is for.
        XCTAssertGreaterThan(size.height, 200)
    }
}
