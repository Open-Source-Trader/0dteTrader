import Foundation

struct PriceProfileRow: Codable, Equatable, Sendable {
    let low: Double
    let high: Double
    let volume: Double
    let inValueArea: Bool
}

struct IndicatorGeometry: Equatable, Sendable {
    let indicatorId: String
    let kind: IndicatorGeometryKind
    let series: [String: [Double?]]
    let rows: [PriceProfileRow]
    let unavailableReason: String?

    static func unavailable(descriptor: IndicatorDescriptor, reason: String) -> IndicatorGeometry {
        IndicatorGeometry(
            indicatorId: descriptor.id,
            kind: descriptor.geometry.kind,
            series: [:],
            rows: [],
            unavailableReason: reason
        )
    }
}

struct IndicatorRenderItem: Equatable, Identifiable, Sendable {
    var id: String { indicatorId }
    let indicatorId: String
    let descriptor: IndicatorDescriptor
    let geometry: IndicatorGeometry
}

struct IndicatorRenderModel: Equatable, Sendable {
    let overlays: [IndicatorRenderItem]
    let subPanes: [IndicatorRenderItem]

    static func make(
        registry: IndicatorRegistry,
        settings: IndicatorSettingsState,
        candles: [Candle],
        l2Indicators: OrderBookIndicatorsDTO? = nil,
        l2UnavailableReason: String = "No L2 data"
    ) throws -> IndicatorRenderModel {
        try IndicatorSettingsValidator.validate(settings, registry: registry)
        var overlays: [IndicatorRenderItem] = []
        var subPanes: [IndicatorRenderItem] = []
        for descriptor in registry.indicators {
            guard let setting = settings.indicators[descriptor.id], setting.enabled else { continue }
            let geometry = try IndicatorEngine.compute(
                indicatorId: descriptor.id,
                candles: candles,
                parameters: setting.parameters,
                registry: registry,
                l2Indicators: l2Indicators,
                l2UnavailableReason: l2UnavailableReason
            )
            let item = IndicatorRenderItem(
                indicatorId: descriptor.id,
                descriptor: descriptor,
                geometry: geometry
            )
            switch descriptor.pane {
            case .overlay: overlays.append(item)
            case .subpane: subPanes.append(item)
            }
        }
        return IndicatorRenderModel(overlays: overlays, subPanes: subPanes)
    }
}
