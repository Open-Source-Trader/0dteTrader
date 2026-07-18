import SwiftUI

/// Arm-then-confirm sheet (FR-19): shows the server-resolved contract, price,
/// buying power and warnings, then submits with the armed idempotency key.
struct OrderConfirmSheet: View {
    @ObservedObject var tradeViewModel: TradeViewModel
    let ticket: ArmedOrderTicket

    private var sideColor: Color {
        ticket.side == .buy ? .buyGreen : .sellRed
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: AppSpacing.lg) {
                Text(ticket.summary)
                    .font(.title3.bold())
                    .multilineTextAlignment(.center)

                VStack(spacing: AppSpacing.md) {
                    LabeledContent("Quantity", value: "\(ticket.request.quantity)")
                    LabeledContent("Order type", value: ticket.request.orderType == OrderType.mid.rawValue ? "Limit at mid" : "Market")

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
                .background(Color.appSurface)
                .clipShape(RoundedRectangle(cornerRadius: AppRadius.lg, style: .continuous))

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
                        .foregroundStyle(confirmEnabled ? .white : .secondary)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(confirmEnabled ? Color.appAccentFill : Color.appSurfaceElevated)
                        .clipShape(RoundedRectangle(cornerRadius: AppRadius.lg, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(AppPressStyle())
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
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.appBackground)
    }

    private var confirmEnabled: Bool {
        tradeViewModel.preview != nil && !tradeViewModel.isSubmitting && !tradeViewModel.isPreviewLoading
    }
}
