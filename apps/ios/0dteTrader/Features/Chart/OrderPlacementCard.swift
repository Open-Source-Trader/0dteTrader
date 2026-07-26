import SwiftUI

/// What the placement card collects before a line is armed.
struct OrderPlacementRequest: Identifiable, Equatable {
    /// Stable across price edits: the window is one continuous interaction, not
    /// a new request per keystroke.
    let id = "chart-placement"
    /// Level on the underlying the guide was left at.
    let price: Double
    let contract: OptionContract
}

/// The window behind the chart's `+`: pick a level, a side, a size, and how the
/// order executes when the level is hit. Every field is editable — the `+` puts
/// you roughly where you meant, and this is where you say exactly.
///
/// A HUD card floating over the chart rather than a sheet: the level you are
/// arming is on the chart, and a sheet covers it at exactly the moment you want
/// to look at it. The execution type is offered here (rather than inherited
/// silently) for the same reason it sits on the line itself — `market` into a
/// thin 0DTE spread and `mid` that never fills are both bad in different
/// situations, and the choice belongs in front of you when you arm the line.
struct OrderPlacementCard: View {
    let request: OrderPlacementRequest
    let defaultQuantity: Int
    let defaultOrderType: OrderType
    /// Editing the level here moves the guide on the chart — the number and the
    /// line are the same fact, so they must never disagree.
    let onPriceChange: (Double) -> Void
    let onPlace: (OrderSide, Int, OrderType) async -> Void
    let onCancel: () -> Void

    @State private var side: OrderSide = .buy
    @State private var quantity: Int
    @State private var orderType: OrderType
    @State private var isSubmitting = false
    /// Raw text, held for as long as the user is typing. A level cannot be
    /// reached keystroke by keystroke without passing through text that is not
    /// what a number would print as — `""`, `"."`, `"4300."` — so the field
    /// shows exactly what was typed and only *reports* a level when the text
    /// parses to one. Snapping back to the canonical string mid-word is what
    /// eats the decimal point: `"4300."` parses perfectly well to `4300`, and a
    /// field that re-renders `4300.00` at that moment turns `4300.50` into
    /// `430050`. Nil means "not being typed", so the canonical string shows.
    @State private var levelDraft: String?
    @FocusState private var priceFocused: Bool

    /// Trigger price step: one cent, the tick the level is rounded to anyway.
    private let priceStep = 0.01

    init(
        request: OrderPlacementRequest,
        defaultQuantity: Int,
        defaultOrderType: OrderType,
        onPriceChange: @escaping (Double) -> Void,
        onPlace: @escaping (OrderSide, Int, OrderType) async -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.request = request
        self.defaultQuantity = defaultQuantity
        self.defaultOrderType = defaultOrderType
        self.onPriceChange = onPriceChange
        self.onPlace = onPlace
        self.onCancel = onCancel
        _quantity = State(initialValue: defaultQuantity)
        _orderType = State(initialValue: defaultOrderType)
    }

    private var accent: Color { side == .buy ? .buyGreen : .sellRed }

    /// What the field shows: the keystrokes while typing, the settled level
    /// otherwise.
    private var levelText: String { levelDraft ?? Self.canonical(request.price) }
    /// A level the order can actually be armed at, or nil while there is none.
    private var levelValue: Double? { parseLevelInput(levelText) }
    private var levelValid: Bool { levelValue != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: AppSpacing.sm) {
            HStack {
                Text("PLACE ORDER LINE")
                    .font(.chipLabel)
                    .kerning(1.2)
                    .foregroundStyle(Color.appAccent)
                Spacer()
                Button(action: onCancel) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.secondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Dismiss")
            }

            levelRow
            contractLine

            HudSegmentedControl(
                options: [
                    .init(OrderSide.buy, "BUY", accent: .buyGreen),
                    .init(OrderSide.sell, "SELL", accent: .sellRed),
                ],
                selection: $side,
                minHeight: 32
            )
            HudSegmentedControl(
                options: [.init(OrderType.mid, "MID"), .init(OrderType.market, "MKT")],
                selection: $orderType,
                minHeight: 32
            )

            quantityRow

            Text(note)
                .font(.caption2)
                .foregroundStyle(levelValid ? Color.secondary : Color.appWarning)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: AppSpacing.sm) {
                cardButton("CANCEL", accent: .hudStroke, action: onCancel)
                cardButton(isSubmitting ? "PLACING…" : "PLACE", accent: accent) { submit() }
                    .disabled(isSubmitting || !levelValid)
                    .opacity(isSubmitting || !levelValid ? AppOpacity.dimmedAction : 1)
            }
        }
        .padding(AppSpacing.md)
        .frame(width: 260)
        // No glow: this sits over a chart that repaints on every tick, and every
        // glow is an offscreen render pass.
        .hudCard(accent: .hudStroke, glow: false)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Place a chart order")
    }

    /// The level is the field most likely to be adjusted the moment this opens,
    /// so it says why it is refusing rather than only that PLACE is dim.
    private var note: String {
        guard levelValid else { return "Enter a level above 0 to place this line." }
        return "Fires an order when \(request.contract.underlying) reaches "
            + "\(Format.price(request.price)). Watched by the app — not a "
            + "broker-side resting order."
    }

    private func submit() {
        // Mirrors the disabled state rather than trusting it: `.disabled` is a
        // rendering concern, and an order-entry control must not be able to
        // submit a level the user did not mean.
        guard !isSubmitting, levelValid else { return }
        isSubmitting = true
        Task {
            await onPlace(side, quantity, orderType)
            isSubmitting = false
        }
    }

    private var levelRow: some View {
        HStack(spacing: AppSpacing.sm) {
            Text("LEVEL")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
            // Text, not a numeric `FormatStyle` binding: a formatted binding
            // re-renders the canonical string on every keystroke, which is what
            // swallows the decimal point half-way through `4300.50`.
            TextField("Level", text: levelBinding)
                .keyboardType(.decimalPad)
                .focused($priceFocused)
                .font(.priceSmall)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, AppSpacing.sm)
                .frame(height: 30)
                .background {
                    HudPanelShape(chamfer: 5)
                        .fill(Color.black.opacity(0.35))
                        .overlay {
                            HudPanelShape(chamfer: 5)
                                .strokeBorder(
                                    levelValid
                                        ? (priceFocused ? Color.hudStroke : Color.hudStrokeDim)
                                        : Color.appWarning,
                                    lineWidth: 1
                                )
                        }
                }
                .accessibilityLabel("Trigger price")
                .accessibilityHint(levelValid ? "" : "Enter a level above 0 to place this line.")
                // Typing is over, so the field can stop showing the keystrokes
                // and show the level they added up to.
                .onChange(of: priceFocused) { _, focused in
                    if !focused { levelDraft = nil }
                }
            stepper(
                decrement: { stepLevel(by: -priceStep) },
                increment: { stepLevel(by: priceStep) },
                label: "level"
            )
        }
    }

    private var levelBinding: Binding<String> {
        Binding(
            get: { levelText },
            set: { raw in
                // `decimalPad` labels its separator key from the locale, so in a
                // comma-decimal locale the only decimal key on the keyboard
                // produces `,`. Folding it to `.` is what makes that key work;
                // `Double(_:)` and `Format.price` are both point-only.
                let text = raw.replacingOccurrences(of: ",", with: ".")
                // Shape-gated before parsing: refusing the keystroke leaves the
                // field showing what it had, which is the same thing a numeric
                // keypad would have done by not producing the character.
                guard isLevelInputShape(text) else { return }
                levelDraft = text
                if let value = parseLevelInput(text) { onPriceChange(rounded(value)) }
            }
        )
    }

    /// The stepper works off the armed level, not the draft — it is the
    /// "I am done typing" gesture as much as blur is.
    private func stepLevel(by delta: Double) {
        levelDraft = nil
        onPriceChange(rounded(request.price + delta))
    }

    private var contractLine: some View {
        Text(
            "\(request.contract.underlying) \(Format.strike(request.contract.strike))"
                + "\(request.contract.optionType == .call ? "C" : "P") · "
                + "\(request.contract.expiration)"
        )
        .font(.priceSmall)
        .foregroundStyle(.secondary)
    }

    private var quantityRow: some View {
        HStack(spacing: AppSpacing.sm) {
            Text("QTY")
                .font(.chipLabel)
                .foregroundStyle(.secondary)
            Text("\(quantity)")
                .font(.priceSmall)
                .monospacedDigit()
                .frame(maxWidth: .infinity, alignment: .trailing)
            stepper(
                decrement: { quantity = max(1, quantity - 1) },
                increment: { quantity = min(1000, quantity + 1) },
                label: "quantity"
            )
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Quantity")
        .accessibilityValue("\(quantity)")
    }

    private func stepper(
        decrement: @escaping () -> Void,
        increment: @escaping () -> Void,
        label: String
    ) -> some View {
        HStack(spacing: AppSpacing.xs) {
            stepperButton("minus", label: "Decrease \(label)", action: decrement)
            stepperButton("plus", label: "Increase \(label)", action: increment)
        }
    }

    private func stepperButton(
        _ symbol: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Image(systemName: symbol)
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.appAccent)
                .frame(width: 34, height: 30)
                .background {
                    HudPanelShape(chamfer: 5)
                        .fill(Color.hudStroke.opacity(0.12))
                        .overlay {
                            HudPanelShape(chamfer: 5)
                                .strokeBorder(Color.hudStrokeDim, lineWidth: 1)
                        }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
        .accessibilityLabel(label)
    }

    /// Chamfered at chip scale: `HudActionButtonStyle`'s double frame needs more
    /// height than these 36pt buttons have.
    private func cardButton(
        _ title: String,
        accent: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.chipLabel)
                .kerning(1)
                .foregroundStyle(accent)
                .frame(maxWidth: .infinity, minHeight: 36)
                .background {
                    HudPanelShape(chamfer: 6)
                        .fill(accent.opacity(0.16))
                        .overlay {
                            HudPanelShape(chamfer: 6)
                                .strokeBorder(accent, lineWidth: 1.2)
                        }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(AppPressStyle())
    }

    private func rounded(_ value: Double) -> Double {
        guard value.isFinite else { return request.price }
        return max(0.01, (value * 100).rounded() / 100)
    }

    /// What a settled level prints as. Two places must agree on it — the field
    /// after blur, and the level the shape check has to accept back.
    private static func canonical(_ price: Double) -> String {
        String(format: "%.2f", price)
    }
}
