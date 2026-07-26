import SwiftUI

/// The trade panel's pricing row: five ways to price the order, one highlight.
///
/// Its own file rather than another member of `TradePanelView` because it owns
/// state — the field's raw draft and its focus — that nothing else on the panel
/// touches, and because the panel was within a few lines of the length ceiling.
struct OrderPricingRow: View {
    @ObservedObject var tradeViewModel: TradeViewModel
    @ObservedObject var chainViewModel: OptionsChainViewModel
    var density: TradePanelDensity = .roomy

    /// Raw keystrokes while the custom price is being typed; nil shows the
    /// settled price. A field that re-renders the canonical string mid-word
    /// eats the decimal point — see `customPriceBinding`.
    @State private var customPriceDraft: String?
    @FocusState private var customPriceFocused: Bool

    /// Five ways to price the order, one highlight. Custom hard left where the
    /// Mid button used to be, Market hard right, and the three readouts between
    /// them are selectable now rather than passive — each still shows its live
    /// price over its grey caption.
    ///
    /// One track, not five chips: these are one either/or, and five separately
    /// bordered controls across a row would read as five independent toggles.
    /// Laid out directly rather than through `HudSegmentedControl` because one
    /// of the five is a text field, but wearing that control's own track and
    /// highlight, so this row's chrome cannot drift from the panel's.
    var body: some View {
        let contract = chainViewModel.selectedContract
        return HStack(spacing: AppSpacing.xs) {
            customPriceSegment
            quoteSegment(.bid, "Bid", contract.map { Format.price($0.bid) })
            quoteSegment(.mid, "Mid", contract?.mid.map { Format.price($0) })
            quoteSegment(.ask, "Ask", contract.map { Format.price($0.ask) })
            labelSegment(.market, "Market")
        }
        .hudSegmentTrack()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Order pricing")
    }

    /// The Custom segment: a price field over the same grey caption its three
    /// neighbours wear.
    ///
    /// Selecting Custom and typing in it are the same gesture — focusing the
    /// field picks it — so there is no way to type a price into a segment that
    /// is not the one the order will use.
    private var customPriceSegment: some View {
        VStack(spacing: 0) {
            // `TextField` over a raw draft, not a numeric `FormatStyle`
            // binding: a formatted binding re-renders the canonical string on
            // every keystroke, which is what swallows the decimal point
            // half-way through `2.45`. Same rule, same helpers, as the
            // placement guide's level field — see PlacementGuide.swift.
            TextField("0.00", text: customPriceBinding)
                .keyboardType(.decimalPad)
                .focused($customPriceFocused)
                .font(.priceSmall)
                .multilineTextAlignment(.center)
                .accessibilityLabel("Custom limit price")
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { customPriceFocused = false }
                    }
                }
            Text("Custom")
                .font(.caption2)
        }
        .foregroundStyle(Color.secondary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .frame(maxWidth: .infinity, minHeight: density.segmentedMinHeight)
        .hudSegmentHighlight(isSelected: tradeViewModel.orderType == .custom)
        .contentShape(Rectangle())
        .onTapGesture {
            tradeViewModel.orderType = .custom
            customPriceFocused = true
        }
        // Typing is over, so the field can stop showing the keystrokes and show
        // the price they added up to.
        .onChange(of: customPriceFocused) { _, focused in
            if focused {
                tradeViewModel.orderType = .custom
            } else {
                customPriceDraft = nil
            }
        }
    }

    /// What the field shows: the keystrokes while typing, the settled price
    /// otherwise, and empty while there is none.
    private var customPriceText: String {
        if let customPriceDraft { return customPriceDraft }
        guard let price = tradeViewModel.customLimitPrice else { return "" }
        return String(format: "%.2f", price)
    }

    private var customPriceBinding: Binding<String> {
        Binding(
            get: { customPriceText },
            set: { raw in
                // Sanitised and then *always* assigned, never rejected: a
                // setter that returns early leaves SwiftUI's `get` handing back
                // the unchanged value, which does not reliably revert the text
                // field — so the field could read `2..45` while the model held
                // something else.
                let text = sanitiseLevelInput(raw, foldingComma: Self.foldsCommaToPoint)
                customPriceDraft = text
                tradeViewModel.setCustomLimitPrice(parseLevelInput(text))
            }
        )
    }

    /// Whether this locale's `decimalPad` decimal key emits a comma. Elsewhere
    /// a comma is a grouping mark and is dropped like any other stray
    /// character — see `sanitiseLevelInput`.
    private static var foldsCommaToPoint: Bool {
        Locale.current.decimalSeparator == ","
    }

    /// One selectable readout: price over its label. Both grey — the panel's
    /// chrome text is one colour — so the hierarchy is carried by type size and
    /// position rather than by brightness. Em dashes rather than a blank while
    /// the chain is loading or nothing is selected: the row keeps its columns
    /// and its height either way, and a dash says "no quote yet" where a blank
    /// says nothing at all.
    private func quoteSegment(_ type: OrderType, _ label: String, _ value: String?) -> some View {
        let isSelected = tradeViewModel.orderType == type
        return Button {
            guard !isSelected else { return }
            Haptics.selection()
            tradeViewModel.orderType = type
        } label: {
            VStack(spacing: 0) {
                Text(value ?? "—")
                    .font(.priceSmall)
                Text(label)
                    .font(.caption2)
            }
            .foregroundStyle(Color.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity, minHeight: density.segmentedMinHeight)
            .hudSegmentHighlight(isSelected: isSelected)
            .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// The Market end: a plain label, since there is no price to read off it.
    /// Hugging rather than filling, so the row's width goes to the readouts.
    private func labelSegment(_ type: OrderType, _ label: String) -> some View {
        let isSelected = tradeViewModel.orderType == type
        return Button {
            guard !isSelected else { return }
            Haptics.selection()
            tradeViewModel.orderType = type
        } label: {
            Text(label)
                .font(.panelLabel)
                .fontWeight(.semibold)
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(minWidth: 60, minHeight: density.segmentedMinHeight)
                .hudSegmentHighlight(isSelected: isSelected)
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
