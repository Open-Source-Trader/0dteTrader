import SwiftUI

/// Trade history sheet: every order with its fill status and the realized P/L
/// its closing fills produced, plus the running net total.
struct HistoryView: View {
    let apiClient: APIClient

    @State private var history: TradeHistoryDTO?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if let history {
                    content(history)
                } else if let errorMessage {
                    Text(errorMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Color.appBackground)
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task { await load() }
    }

    private func load() async {
        do {
            history = try await apiClient.orderHistory()
        } catch let error as APIError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @ViewBuilder
    private func content(_ history: TradeHistoryDTO) -> some View {
        List {
            Section {
                HStack {
                    Text("Net realized P/L")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(Format.signedPrice(history.totalRealizedPnl))
                        .font(.priceMedium)
                        .foregroundStyle(history.totalRealizedPnl >= 0 ? Color.buyGreen : Color.sellRed)
                }
            }

            Section {
                if history.entries.isEmpty {
                    Text("No orders yet.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(history.entries, id: \.orderId) { entry in
                        row(entry)
                    }
                }
            }
        }
    }

    private func row(_ entry: TradeHistoryEntryDTO) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("\(entry.side.uppercased()) \(entry.quantity) \(entry.contractSymbol)")
                    .font(.subheadline.weight(.semibold))
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
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(realized >= 0 ? Color.buyGreen : Color.sellRed)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func detailLine(_ entry: TradeHistoryEntryDTO) -> String {
        var parts: [String] = [OrderType(rawValue: entry.orderType)?.displayName ?? entry.orderType]
        if let filled = entry.filledPrice {
            parts.append("filled @ \(Format.price(filled))")
        } else if let limit = entry.limitPrice {
            parts.append("limit \(Format.price(limit))")
        }
        if let date = DateParsing.dateTime(entry.timestamp) {
            parts.append(date.formatted(date: .abbreviated, time: .shortened))
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
