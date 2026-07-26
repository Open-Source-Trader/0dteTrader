import SwiftUI

/// What the placement sheet collects before a line is armed.
struct OrderPlacementRequest: Identifiable, Equatable {
    /// Stable across price edits: the window is one continuous interaction, not
    /// a new request per keystroke.
    let id = "chart-placement"
    /// Level on the underlying the `+` handle armed.
    let price: Double
    let contract: OptionContract
}

/// The small window behind the `+` handle: pick a side, a size, and how the
/// order executes when the level is hit.
///
/// The execution type is offered here rather than inherited silently, for the
/// same reason it sits on the line itself — `market` into a thin 0DTE spread
/// and `mid` that never fills are both bad in different situations, and the
/// choice belongs in front of you when you arm the line.
struct OrderPlacementSheet: View {
    let request: OrderPlacementRequest
    let defaultQuantity: Int
    let defaultOrderType: OrderType
    let onPlace: (OrderSide, Int, OrderType) async -> Void
    let onCancel: () -> Void

    @State private var side: OrderSide = .buy
    @State private var quantity: Int
    @State private var orderType: OrderType
    @State private var isSubmitting = false

    init(
        request: OrderPlacementRequest,
        defaultQuantity: Int,
        defaultOrderType: OrderType,
        onPlace: @escaping (OrderSide, Int, OrderType) async -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.request = request
        self.defaultQuantity = defaultQuantity
        self.defaultOrderType = defaultOrderType
        self.onPlace = onPlace
        self.onCancel = onCancel
        _quantity = State(initialValue: defaultQuantity)
        _orderType = State(initialValue: defaultOrderType)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Level") {
                        Text("\(request.contract.underlying) @ \(Format.price(request.price))")
                            .monospacedDigit()
                    }
                    LabeledContent("Contract") {
                        Text(
                            "\(Format.strike(request.contract.strike))"
                                + "\(request.contract.optionType == .call ? "C" : "P")"
                        )
                        .monospacedDigit()
                    }
                    LabeledContent("Expiration") { Text(request.contract.expiration) }
                }

                Section {
                    Picker("Side", selection: $side) {
                        Text("BUY").tag(OrderSide.buy)
                        Text("SELL").tag(OrderSide.sell)
                    }
                    .pickerStyle(.segmented)

                    Picker("Execution", selection: $orderType) {
                        Text("MID").tag(OrderType.mid)
                        Text("MKT").tag(OrderType.market)
                    }
                    .pickerStyle(.segmented)

                    Stepper("Quantity: \(quantity)", value: $quantity, in: 1...1000)
                }

                Section {
                    Text(
                        "Fires an order when \(request.contract.underlying) reaches "
                            + "\(Format.price(request.price)). Watched by the app — not a "
                            + "broker-side resting order."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Place Order Line")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "Placing…" : "Place") {
                        guard !isSubmitting else { return }
                        isSubmitting = true
                        Task {
                            await onPlace(side, quantity, orderType)
                            isSubmitting = false
                        }
                    }
                    .disabled(isSubmitting)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
