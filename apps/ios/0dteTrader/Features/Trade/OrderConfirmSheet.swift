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
        VStack(spacing: 16) {
            Capsule()
                .fill(Color.appBorder)
                .frame(width: 40, height: 5)
                .padding(.top, 8)

            Text("Confirm \(ticket.side.displayName)")
                .font(.title3.bold())

            Text(ticket.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            VStack(spacing: 10) {
                LabeledContent("Quantity", value: "\(ticket.request.quantity)")
                LabeledContent("Order type", value: ticket.request.orderType == OrderType.mid.rawValue ? "Limit at mid" : "Market")

                if tradeViewModel.isPreviewLoading {
                    HStack {
                        ProgressView()
                        Text("Resolving contract…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else if let preview = tradeViewModel.preview {
                    LabeledContent("Contract", value: preview.contractSymbol)
                        .font(.subheadline)
                    LabeledContent("Est. price", value: Format.price(preview.price))
                    LabeledContent("Est. buying power", value: Format.price(preview.estBuyingPower))
                    ForEach(preview.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
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
            .padding()
            .frame(maxWidth: .infinity)
            .background(Color.appSurface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            HStack(spacing: 12) {
                Button("Cancel") {
                    tradeViewModel.cancelArmedOrder()
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity, minHeight: 52)

                Button {
                    Task { await tradeViewModel.confirmArmedOrder() }
                } label: {
                    Group {
                        if tradeViewModel.isSubmitting {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Confirm \(ticket.side.displayName)")
                                .font(.headline)
                        }
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(confirmEnabled ? sideColor : sideColor.opacity(0.35))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!confirmEnabled)
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .presentationDetents([.medium])
        .presentationDragIndicator(.hidden)
    }

    private var confirmEnabled: Bool {
        tradeViewModel.preview != nil && !tradeViewModel.isSubmitting && !tradeViewModel.isPreviewLoading
    }
}
