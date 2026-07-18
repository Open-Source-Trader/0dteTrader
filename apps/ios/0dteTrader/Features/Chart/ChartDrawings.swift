import Foundation

/// Chart annotation tools (TradingView-style), selectable from the chart
/// header's drawing dropdown.
enum DrawingTool: String, CaseIterable, Identifiable, Sendable {
    case cursor
    case trend
    case ray
    case hline
    case rect
    case alert

    var id: String { rawValue }

    var title: String {
        switch self {
        case .cursor: return "Select / Pan"
        case .trend: return "Trend Line"
        case .ray: return "Ray"
        case .hline: return "Horizontal Line"
        case .rect: return "Box"
        case .alert: return "Price Alert"
        }
    }

    var systemImage: String {
        switch self {
        case .cursor: return "cursorarrow"
        case .trend: return "line.diagonal"
        case .ray: return "arrow.up.right"
        case .hline: return "minus"
        case .rect: return "rectangle"
        case .alert: return "bell"
        }
    }
}

/// Anchor for a drawing: bucket time (epoch seconds, may fall between or
/// beyond bars) and price. Time-anchored shapes stay put across pan/zoom,
/// live appends and reloads.
struct DrawingPoint: Codable, Equatable, Sendable {
    var time: TimeInterval
    var price: Double
}

struct ChartDrawing: Codable, Equatable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case trend
        case ray
        case hline
        case rect
    }

    let id: UUID
    var kind: Kind
    var p1: DrawingPoint
    /// Absent for hline (price level only).
    var p2: DrawingPoint?
}

struct PriceAlert: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    var price: Double
    /// Set when the alert fires; fired alerts stay on the chart (dimmed)
    /// until deleted instead of vanishing silently. Absent in older payloads.
    var firedAt: Date? = nil
}

/// Per-symbol chart annotations (trend lines, rays, horizontal lines, boxes,
/// price alerts), persisted in UserDefaults under `chart.drawings.<symbol>`.
@MainActor
final class ChartDrawingsModel: ObservableObject {
    @Published var tool: DrawingTool = .cursor
    @Published private(set) var drawings: [ChartDrawing] = []
    @Published private(set) var alerts: [PriceAlert] = []
    @Published var selectedId: UUID?

    private let defaults: UserDefaults
    private var symbol = ""

    private struct Payload: Codable {
        var drawings: [ChartDrawing]
        var alerts: [PriceAlert]
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var hasAnnotations: Bool { !drawings.isEmpty || !alerts.isEmpty }

    func setSymbol(_ symbol: String) {
        guard symbol != self.symbol else { return }
        self.symbol = symbol
        tool = .cursor
        selectedId = nil
        if let data = defaults.data(forKey: storageKey),
           let payload = try? JSONDecoder().decode(Payload.self, from: data) {
            drawings = payload.drawings
            alerts = payload.alerts
        } else {
            drawings = []
            alerts = []
        }
    }

    func add(_ drawing: ChartDrawing) {
        drawings.append(drawing)
        selectedId = drawing.id
        tool = .cursor
        persist()
    }

    func addAlert(price: Double) {
        alerts.append(PriceAlert(id: UUID(), price: price))
        tool = .cursor
        persist()
    }

    func update(id: UUID, p1: DrawingPoint, p2: DrawingPoint?) {
        guard let index = drawings.firstIndex(where: { $0.id == id }) else { return }
        drawings[index].p1 = p1
        drawings[index].p2 = p2
        persist()
    }

    func updateAlert(id: UUID, price: Double) {
        guard let index = alerts.firstIndex(where: { $0.id == id }) else { return }
        alerts[index].price = price
        persist()
    }

    /// Removes the selection if any, else clears every annotation for the symbol.
    func removeSelectedOrClear() {
        if let selectedId {
            drawings.removeAll { $0.id == selectedId }
            alerts.removeAll { $0.id == selectedId }
            self.selectedId = nil
        } else {
            drawings = []
            alerts = []
        }
        persist()
    }

    /// Returns alerts crossed between two consecutive last prices. Crossed
    /// alerts are marked fired (fire once) and stay rendered dimmed until the
    /// user deletes them, so the price level isn't lost when it matters most.
    func checkAlerts(previousLast: Double, last: Double) -> [PriceAlert] {
        guard previousLast != last else { return [] }
        let crossed = alerts.filter { $0.firedAt == nil && (previousLast - $0.price) * (last - $0.price) <= 0 }
        guard !crossed.isEmpty else { return [] }
        let crossedIds = Set(crossed.map(\.id))
        let now = Date()
        for index in alerts.indices where crossedIds.contains(alerts[index].id) {
            alerts[index].firedAt = now
        }
        persist()
        return crossed
    }

    private var storageKey: String { "chart.drawings.\(symbol)" }

    private func persist() {
        guard !symbol.isEmpty else { return }
        if let data = try? JSONEncoder().encode(Payload(drawings: drawings, alerts: alerts)) {
            defaults.set(data, forKey: storageKey)
        }
    }
}
