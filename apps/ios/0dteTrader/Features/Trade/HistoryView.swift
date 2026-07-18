import SwiftUI

/// Trade history sheet: every order with its fill status and the realized P/L
/// its closing fills produced, plus the running net total.
struct HistoryView: View {
    let apiClient: APIClient

    @Environment(\.dismiss) private var dismiss
    @State private var history: TradeHistoryDTO?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if let history {
                    content(history)
                } else if let errorMessage {
                    ErrorStateView(message: errorMessage, systemImage: "exclamationmark.triangle") {
                        Task { await load() }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    skeletonList
                }
            }
            .background(Color.appBackground)
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .transaction { $0.animation = .easeOut(duration: 0.2) }
        }
        .task { await load() }
    }

    private func load() async {
        errorMessage = nil
        do {
            let result = try await apiClient.orderHistory()
            withAnimation(.easeOut(duration: 0.2)) {
                history = result
            }
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Skeleton rows shaped like history rows while the first load runs.
    private var skeletonList: some View {
        List {
            ForEach(0..<6, id: \.self) { _ in
                VStack(alignment: .leading, spacing: AppSpacing.xs) {
                    SkeletonView(cornerRadius: AppRadius.sm)
                        .frame(height: 15)
                    SkeletonView(cornerRadius: AppRadius.sm)
                        .frame(width: 220, height: 12)
                }
                .padding(.vertical, AppSpacing.xs)
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private func content(_ history: TradeHistoryDTO) -> some View {
        if history.entries.isEmpty {
            ContentUnavailableView(
                "No Orders Yet",
                systemImage: "clock.arrow.circlepath",
                description: Text("Filled and working orders will appear here.")
            )
        } else {
            List {
                Section {
                    HStack {
                        Text("Net realized P/L")
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(Format.signedPrice(history.totalRealizedPnl))
                            .font(.priceLarge)
                            .foregroundStyle(history.totalRealizedPnl > 0 ? Color.pnlPositive
                                             : history.totalRealizedPnl < 0 ? Color.pnlNegative : .secondary)
                    }
                }

                Section {
                    ForEach(history.entries, id: \.orderId) { entry in
                        row(entry)
                    }
                }
            }
            .refreshable { await load() }
        }
    }

    private func row(_ entry: TradeHistoryEntryDTO) -> some View {
        VStack(alignment: .leading, spacing: AppSpacing.xs) {
            HStack {
                Text("\(entry.side.uppercased()) \(entry.quantity) \(entry.contractSymbol)")
                    .font(.system(.subheadline, design: .monospaced).weight(.semibold))
                    .lineLimit(1)
                Spacer()
                Text(OrderStatus(tolerant: entry.status).displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor(entry.status))
            }
            HStack {
                Text(detailLine(entry))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let realized = entry.realizedPnl {
                    Text(Format.signedPrice(realized))
                        .font(.priceSmall.weight(.semibold))
                        .foregroundStyle(realized > 0 ? Color.pnlPositive : realized < 0 ? Color.pnlNegative : .secondary)
                }
            }
        }
        .padding(.vertical, AppSpacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.side.uppercased()) \(entry.quantity) \(entry.contractSymbol), \(OrderStatus(tolerant: entry.status).displayName)")
        .accessibilityValue(entry.realizedPnl.map { "realized P/L \(Format.signedPrice($0)) dollars" } ?? "")
    }

    private func detailLine(_ entry: TradeHistoryEntryDTO) -> String {
        var parts: [String] = [OrderType(rawValue: entry.orderType)?.displayName ?? entry.orderType]
        if let filled = entry.filledPrice {
            parts.append("filled @ \(Format.price(filled))")
        } else if let limit = entry.limitPrice {
            parts.append("limit \(Format.price(limit))")
        }
        if let date = DateParsing.dateTime(entry.timestamp) {
            parts.append(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))
        }
        return parts.joined(separator: " · ")
    }

    private func statusColor(_ status: String) -> Color {
        switch OrderStatus(tolerant: status) {
        case .filled: return .buyGreen
        case .rejected: return .sellRed
        default: return .secondary
        }
    }
}
