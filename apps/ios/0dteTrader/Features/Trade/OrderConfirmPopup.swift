import SwiftUI

/// Where the order confirmation hangs from: the SELL/BUY row that armed it.
///
/// Its own key rather than `HudMenuAnchorKey`, which every chip on the screen
/// already publishes into — read at screen level that one reduces to whichever
/// chip reported last, which is a chart chip about as often as not.
struct TradeActionsAnchorKey: PreferenceKey {
    static let defaultValue: CGRect? = nil

    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
        value = nextValue() ?? value
    }
}

extension View {
    /// Publishes this row's frame as the box the order confirmation opens from.
    /// Applied to the SELL/BUY row in both layouts.
    func tradeActionsAnchorSource() -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: TradeActionsAnchorKey.self,
                    value: proxy.frame(in: .global)
                )
            }
        }
    }
}

/// Arm-then-confirm popup (FR-19): shows the server-resolved contract, price,
/// buying power and warnings, then submits with the armed idempotency key.
///
/// An anchored popup rather than a sheet, so it wears the same chrome as the
/// ticker, interval, indicator, strike and expiration popups. It is the only
/// one of them that is not a picker, and the difference is load-bearing:
///
/// - Nothing here confirms except the Confirm button. The scrim routes through
///   `handleUserDismiss`, which cancels; there is no other way out.
/// - It is modal in the sense the pickers are — the scrim takes every touch
///   underneath, SELL/BUY included, and `.isModal` keeps VoiceOver inside it —
///   and additionally refuses to close mid-submission, because the order may
///   still fill and its result belongs on the surface that sent it.
/// - Anchored to the row that armed it, opening upward out of SELL/BUY. That is
///   where the eye already is, and the room above that row is the whole screen.
struct OrderConfirmPopup: View {
    @ObservedObject var tradeViewModel: TradeViewModel
    let ticket: ArmedOrderTicket

    /// This popup's slot in the screen's popup layer.
    static let popupID = "order-confirm"

    /// What a tap on the scrim means. Cancel, never confirm — and nothing at
    /// all once the order is in flight, since the popup is where its result
    /// lands.
    ///
    /// Clearing the ticket is what closes the popup: the screen presents off
    /// `armedTicket`, so the state and the presentation cannot disagree.
    @MainActor
    static func handleUserDismiss(_ tradeViewModel: TradeViewModel) {
        guard !tradeViewModel.isSubmitting else { return }
        tradeViewModel.cancelArmedOrder()
    }

    private var sideColor: Color {
        ticket.side == .buy ? .buyGreen : .sellRed
    }

    /// The ticket carries the raw wire value; an unrecognised one is printed as
    /// it came rather than mislabelled as something else.
    private var pricingDescription: String {
        OrderType(rawValue: ticket.request.orderType)?.pricingDescription ?? ticket.request.orderType
    }

    var body: some View {
        ScrollView(.vertical) {
            content
        }
        // `basedOnSize`: at the default text size the content fits the room
        // above SELL/BUY on every supported screen — `OrderConfirmPopupTests`
        // measures it against the smallest — so this never scrolls in practice.
        // It is here so an accessibility text size that outgrows the panel
        // degrades to a scroll rather than to a clipped warning row.
        .scrollBounceBehavior(.basedOnSize)
        // Full width. A picker is as wide as its widest row; a decision surface
        // is as wide as the row it is deciding about.
        .frame(maxWidth: .infinity)
        .hudMenuPanel()
    }

    /// The panel's contents at their natural height.
    ///
    /// Split out from the scroll view around them because the height budget is
    /// about *this*: a `ScrollView` measures as whatever it is offered, so it
    /// cannot answer "does the warning row fit". `OrderConfirmPopupTests` sizes
    /// this against the smallest supported screen.
    @ViewBuilder
    var content: some View {
        VStack(spacing: AppSpacing.lg) {
            Text(ticket.summary)
                .font(.title3.bold())
                .multilineTextAlignment(.center)

            VStack(spacing: AppSpacing.md) {
                LabeledContent("Quantity", value: "\(ticket.request.quantity)")
                LabeledContent("Order type", value: pricingDescription)
                // With a typed price this popup is the last place a wrong
                // number can be caught, so it prints the number as entered
                // rather than only the server's resolved price — and the
                // spread beside it below, since a premium with nothing to
                // compare it to catches nothing.
                if let limitPrice = ticket.request.limitPrice {
                    LabeledContent("Your limit") {
                        Text(Format.price(limitPrice)).font(.priceMedium)
                    }
                }

                if tradeViewModel.isPreviewLoading {
                    // Placeholder rows mirror the loaded layout so the card
                    // doesn't jump when the preview resolves.
                    LabeledContent("Contract") {
                        Text("MES 5000C").font(.priceMedium)
                    }
                    LabeledContent("Est. price") {
                        Text(Format.price(0)).font(.priceLarge)
                    }
                    LabeledContent("Est. buying power") {
                        Text(Format.price(0)).font(.priceMedium)
                    }
                    .redacted(reason: .placeholder)
                } else if let preview = tradeViewModel.preview {
                    LabeledContent("Contract") {
                        Text(preview.contractSymbol).font(.priceMedium)
                    }
                    if let bid = preview.bid, let ask = preview.ask {
                        LabeledContent("Bid / Ask") {
                            Text("\(Format.price(bid)) / \(Format.price(ask))")
                                .font(.priceMedium)
                        }
                    }
                    LabeledContent("Est. price") {
                        Text(Format.price(preview.price))
                            .font(.priceLarge)
                            .foregroundStyle(sideColor)
                    }
                    LabeledContent("Est. buying power") {
                        Text(Format.price(preview.estBuyingPower)).font(.priceMedium)
                    }
                    ForEach(preview.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(Color.appWarning)
                    }
                }

                if let previewError = tradeViewModel.previewError {
                    Text(previewError)
                        .font(.footnote)
                        .foregroundStyle(Color.pnlNegative)
                        .multilineTextAlignment(.center)
                    Button("Retry") {
                        Task { await tradeViewModel.loadPreview() }
                    }
                    .font(.footnote)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: tradeViewModel.isPreviewLoading)
            .padding()
            .frame(maxWidth: .infinity)
            .background {
                HudPanelShape(chamfer: 8)
                    .fill(Color.appSurface)
                    .overlay {
                        HudPanelShape(chamfer: 8)
                            .strokeBorder(
                                (ticket.side == .buy ? Color.buyGreen : Color.sellRed).opacity(0.55),
                                lineWidth: 1
                            )
                    }
            }

            HStack(spacing: AppSpacing.md) {
                Button("Cancel") {
                    tradeViewModel.cancelArmedOrder()
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity, minHeight: 52)
                // The scrim's rule, restated on the button: once the order
                // is in flight there is nothing left here to cancel.
                .disabled(tradeViewModel.isSubmitting)

                Button {
                    Haptics.impact(.medium)
                    Task { await tradeViewModel.confirmArmedOrder() }
                } label: {
                    ZStack {
                        Text("Confirm \(ticket.side.displayName)")
                            .font(.headline)
                            .opacity(tradeViewModel.isSubmitting ? 0 : 1)
                        if tradeViewModel.isSubmitting {
                            ProgressView()
                                .tint(.white)
                        }
                    }
                    .animation(.easeInOut(duration: 0.15), value: tradeViewModel.isSubmitting)
                    .font(.hudButton)
                    .foregroundStyle(confirmEnabled
                        ? (ticket.side == .buy ? Color.buyGreen : Color.sellRed)
                        : .secondary)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(HudActionButtonStyle(
                    accent: confirmEnabled
                        ? (ticket.side == .buy ? Color.buyGreen : Color.sellRed)
                        : Color.hudStroke.opacity(0.35)
                ))
                .disabled(!confirmEnabled)
                .accessibilityLabel(tradeViewModel.isSubmitting
                    ? "Submitting order"
                    : "Confirm \(ticket.side.displayName)")
            }

            if let submitError = tradeViewModel.submitError {
                Label(submitError, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.pnlNegative)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, AppSpacing.lg)
        .padding(.vertical, AppSpacing.lg)
    }

    private var confirmEnabled: Bool {
        tradeViewModel.preview != nil && !tradeViewModel.isSubmitting && !tradeViewModel.isPreviewLoading
    }
}
