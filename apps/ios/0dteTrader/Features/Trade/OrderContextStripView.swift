import SwiftUI

struct OrderFinancialSummary: Equatable {
    let contract: String
    let quantity: String
    let debit: String
    let breakeven: String
    let maxLoss: String
}

struct OrderContextSummary: Equatable {
    enum Kind: Equatable {
        case empty
        case loading
        case quoteUnavailable
        case orderPreview
        case position
    }

    enum PnlTone: Equatable {
        case positive
        case negative
        case flat
    }

    let kind: Kind
    let primary: String
    let secondary: String
    let tertiary: String?
    let pnlTone: PnlTone?
    let warning: String?
    let financialSummary: OrderFinancialSummary?

    var accessibilityText: String {
        [primary, secondary, tertiary, warning].compactMap { $0 }.joined(separator: ". ")
    }
}

enum OrderContextSummaryBuilder {
    static func build(
        selectedContract: OptionContract?,
        positions: [Position],
        quantity: Int,
        orderType: OrderType,
        customLimitPrice: Double?,
        isQuoteLoading: Bool,
        warning: String? = nil
    ) -> OrderContextSummary {
        let optionPositions = positions.filter { $0.assetClass == .option }
        let matchingPosition = selectedContract.flatMap { contract in
            optionPositions.first { $0.symbol == contract.symbol }
        }
        if let position = matchingPosition ?? optionPositions.first {
            let label: String
            if matchingPosition != nil, let selectedContract {
                label = contractLabel(selectedContract)
            } else {
                label = position.symbol
            }
            let basis = abs(position.avgPrice * Double(position.quantity) * position.multiplier)
            let pnlPercent = basis > 0 ? (position.unrealizedPnl / basis) * 100 : 0
            let tone: OrderContextSummary.PnlTone = position.unrealizedPnl > 0
                ? .positive
                : (position.unrealizedPnl < 0 ? .negative : .flat)
            return OrderContextSummary(
                kind: .position,
                primary: "\(label) · Qty \(abs(position.quantity))",
                secondary: "\(signedMoney(position.unrealizedPnl)) · \(Format.signedPrice(pnlPercent, fractionDigits: 0))%",
                tertiary: "Entry \(money(position.avgPrice)) · Mark \(money(position.markPrice)) · No stop/target",
                pnlTone: tone,
                warning: prefixedWarning(warning),
                financialSummary: nil
            )
        }

        guard let selectedContract else {
            return OrderContextSummary(
                kind: isQuoteLoading ? .loading : .empty,
                primary: isQuoteLoading ? "Loading option quote…" : "No contract selected",
                secondary: isQuoteLoading
                    ? "BUY/SELL unlock when a quote is ready"
                    : "Pick an expiration and strike to preview risk",
                tertiary: nil,
                pnlTone: nil,
                warning: prefixedWarning(warning),
                financialSummary: nil
            )
        }

        guard let price = price(for: selectedContract, orderType: orderType, customLimitPrice: customLimitPrice),
              selectedContract.ask >= selectedContract.bid
        else {
            return OrderContextSummary(
                kind: isQuoteLoading ? .loading : .quoteUnavailable,
                primary: "\(contractLabel(selectedContract)) · Qty \(quantity)",
                secondary: isQuoteLoading ? "Refreshing quote…" : "Quote unavailable",
                tertiary: nil,
                pnlTone: nil,
                warning: prefixedWarning(warning),
                financialSummary: nil
            )
        }

        let spread = selectedContract.ask - selectedContract.bid
        let debit = price * Double(quantity) * 100
        let breakeven = selectedContract.optionType == .call
            ? selectedContract.strike + price
            : selectedContract.strike - price
        return OrderContextSummary(
            kind: .orderPreview,
            primary: "\(contractLabel(selectedContract)) · Qty \(quantity)",
            secondary: "Debit \(money(debit)) · Max loss \(money(debit)) · Spread \(money(spread))",
            tertiary: "Breakeven \(money(breakeven))",
            pnlTone: nil,
            warning: prefixedWarning(warning),
            financialSummary: OrderFinancialSummary(
                contract: contractLabel(selectedContract),
                quantity: "\(quantity)",
                debit: money(debit),
                breakeven: money(breakeven),
                maxLoss: money(debit)
            )
        )
    }

    private static func contractLabel(_ contract: OptionContract) -> String {
        "\(contract.underlying) \(Format.strike(contract.strike))\(contract.optionType.shortName)"
    }

    private static func price(
        for contract: OptionContract,
        orderType: OrderType,
        customLimitPrice: Double?
    ) -> Double? {
        switch orderType {
        case .custom:
            return customLimitPrice
        case .bid:
            return contract.bid > 0 ? contract.bid : nil
        case .ask:
            return contract.ask > 0 ? contract.ask : nil
        case .market:
            return contract.last > 0 ? contract.last : contract.mid
        case .mid:
            return contract.mid
        }
    }

    private static func money(_ value: Double, fractionDigits: Int = 2) -> String {
        "$\(Format.price(value, fractionDigits: fractionDigits))"
    }

    private static func signedMoney(_ value: Double, fractionDigits: Int = 2) -> String {
        let sign = value > 0 ? "+" : (value < 0 ? "-" : "")
        return "\(sign)$\(Format.price(abs(value), fractionDigits: fractionDigits))"
    }

    private static func prefixedWarning(_ warning: String?) -> String? {
        guard let warning, !warning.isEmpty else { return nil }
        return warning.hasPrefix("Options Structure") ? warning : "Options Structure unavailable: \(warning)"
    }
}

struct OrderContextStripView: View {
    let selectedContract: OptionContract?
    let positions: [Position]
    let quantity: Int
    let orderType: OrderType
    let customLimitPrice: Double?
    let isQuoteLoading: Bool
    let warning: String?
    var onRetryWarning: (() -> Void)?

    private var summary: OrderContextSummary {
        OrderContextSummaryBuilder.build(
            selectedContract: selectedContract,
            positions: positions,
            quantity: quantity,
            orderType: orderType,
            customLimitPrice: customLimitPrice,
            isQuoteLoading: isQuoteLoading,
            warning: warning
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let warning = summary.warning {
                warningRow(warning)
            }
            if let financialSummary = summary.financialSummary {
                financialGrid(financialSummary)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: AppSpacing.sm) {
                    Text(summary.primary)
                        .font(.system(.caption, design: .monospaced).weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .layoutPriority(2)
                    Spacer(minLength: AppSpacing.xs)
                    Text(summary.secondary)
                        .font(.system(.caption2, design: .monospaced).weight(.semibold))
                        .foregroundStyle(pnlColor)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .multilineTextAlignment(.trailing)
                        .layoutPriority(1)
                }
                if let tertiary = summary.tertiary {
                    Text(tertiary)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        }
        .padding(.horizontal, AppSpacing.md)
        .padding(.vertical, summary.warning == nil ? 7 : 6)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .center)
        .background {
            HudPanelShape(chamfer: 7)
                .fill(Color.hudPanel)
                .overlay {
                    HudPanelShape(chamfer: 7)
                        .strokeBorder(Color.hudStrokeDim.opacity(0.65), lineWidth: 1)
                }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Order context")
        .accessibilityValue(summary.accessibilityText)
    }

    private var pnlColor: Color {
        switch summary.pnlTone {
        case .positive: return .pnlPositive
        case .negative: return .pnlNegative
        case .flat, nil: return .secondary
        }
    }

    private func financialGrid(_ financialSummary: OrderFinancialSummary) -> some View {
        Grid(alignment: .leading, horizontalSpacing: AppSpacing.md, verticalSpacing: AppSpacing.xs) {
            GridRow {
                Text(financialSummary.contract)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: true, vertical: false)
                SummaryValue(label: "Qty", value: financialSummary.quantity)
                SummaryValue(label: "Debit", value: financialSummary.debit)
            }
            GridRow {
                SummaryValue(label: "Breakeven", value: financialSummary.breakeven)
                    .gridCellColumns(2)
                SummaryValue(label: "Max loss", value: financialSummary.maxLoss)
            }
        }
        .font(.system(.caption2, design: .monospaced))
        .monospacedDigit()
    }

    private func warningRow(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(Color.appWarning)
                .accessibilityHidden(true)
            Text(message)
                .font(.caption2)
                .foregroundStyle(Color.appWarning)
                .lineLimit(1)
                .truncationMode(.tail)
            if let onRetryWarning {
                Spacer(minLength: AppSpacing.xs)
                Button("Retry", action: onRetryWarning)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.secondary)
            }
        }
    }
}

private struct SummaryValue: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: AppSpacing.xs) {
            Text(label)
                .foregroundStyle(Color.secondary)
            Text(value)
                .foregroundStyle(Color.primary)
                .fontWeight(.semibold)
        }
        .fixedSize(horizontal: true, vertical: false)
    }
}
