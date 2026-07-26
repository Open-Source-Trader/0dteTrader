import SwiftUI

/// Arm-then-confirm sheet (FR-19): shows the server-resolved contract, price,
/// buying power and warnings, then submits with the armed idempotency key.
struct OrderConfirmSheet: View {
    @ObservedObject var tradeViewModel: TradeViewModel
    let ticket: ArmedOrderTicket

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
            VStack(spacing: AppSpacing.lg) {
                Text(ticket.summary)
                    .font(.title3.bold())
                    .multilineTextAlignment(.center)

                VStack(spacing: AppSpacing.md) {
                    LabeledContent("Quantity", value: "\(ticket.request.quantity)")
                    LabeledContent("Order type", value: pricingDescription)
                    // With a typed price this sheet is the last place a wrong
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
            .padding(.top, AppSpacing.sm)
            .padding(.bottom, AppSpacing.md)
        }
        .scrollBounceBehavior(.basedOnSize)
        // The app's own fill rather than the stock sheet grey: this is the last
        // thing you look at before an order goes out, and it should read as
        // part of the same instrument as the panel that armed it.
        .background(Color.appBackground)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.appBackground)
    }

    private var confirmEnabled: Bool {
        tradeViewModel.preview != nil && !tradeViewModel.isSubmitting && !tradeViewModel.isPreviewLoading
    }
}
