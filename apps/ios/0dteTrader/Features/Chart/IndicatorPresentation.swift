import Foundation

enum IndicatorAvailability: Equatable, Sendable {
    case available
    case noL2Data
}

struct IndicatorControlItem: Identifiable, Equatable, Sendable {
    let descriptor: IndicatorDescriptor
    let availability: IndicatorAvailability

    var id: String { descriptor.id }
    var displayName: String { descriptor.displayName }
    var requiresL2: Bool { descriptor.requiresL2 }
    var parameters: [String: IndicatorParameterDescriptor] { descriptor.parameters }
}

struct IndicatorControlCatalog: Equatable, Sendable {
    let overlays: [IndicatorControlItem]
    let subPanes: [IndicatorControlItem]

    init(registry: IndicatorRegistry, hasL2Data: Bool = false) {
        let controls = registry.indicators.map { descriptor in
            IndicatorControlItem(
                descriptor: descriptor,
                availability: descriptor.requiresL2 && !hasL2Data ? .noL2Data : .available
            )
        }
        overlays = controls.filter { $0.descriptor.pane == .overlay }
        subPanes = controls.filter { $0.descriptor.pane == .subpane }
    }
}

enum IndicatorTogglePolicy {
    static func canChange(availability: IndicatorAvailability, isEnabled: Bool) -> Bool {
        availability == .available || isEnabled
    }
}

struct IndicatorSeriesPresentation: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case line
        case histogram
    }

    let id: String
    let label: String
    let styleToken: String
    let kind: Kind
    let values: [Double?]
}

struct IndicatorFillPresentation: Equatable, Sendable {
    let upperSeriesId: String
    let lowerSeriesId: String
    let styleToken: String
}

struct IndicatorFillRun: Equatable, Sendable {
    let indices: [Int]
    let upper: [Double]
    let lower: [Double]
}

enum IndicatorFillGeometry {
    static func contiguousRuns(upper: [Double?], lower: [Double?]) -> [IndicatorFillRun] {
        var runs: [IndicatorFillRun] = []
        var indices: [Int] = []
        var upperValues: [Double] = []
        var lowerValues: [Double] = []
        func flush() {
            if indices.count >= 2 {
                runs.append(.init(indices: indices, upper: upperValues, lower: lowerValues))
            }
            indices = []
            upperValues = []
            lowerValues = []
        }
        for index in 0..<min(upper.count, lower.count) {
            if let upperValue = upper[index], let lowerValue = lower[index] {
                indices.append(index)
                upperValues.append(upperValue)
                lowerValues.append(lowerValue)
            } else {
                flush()
            }
        }
        flush()
        return runs
    }
}

struct IndicatorLiveRenderPlan: Equatable, Sendable {
    let indicatorId: String
    let kind: IndicatorGeometryKind
    let series: [IndicatorSeriesPresentation]
    let fills: [IndicatorFillPresentation]
    let profileRows: [PriceProfileRow]
    let unavailableReason: String?
}

enum IndicatorLiveRenderer {
    static func plan(item: IndicatorRenderItem) throws -> IndicatorLiveRenderPlan {
        guard item.geometry.kind == item.descriptor.geometry.kind else {
            throw IndicatorRegistryError.invalid(
                "\(item.indicatorId) geometry kind does not match its descriptor."
            )
        }
        let series: [IndicatorSeriesPresentation]
        if item.geometry.kind == .priceProfile {
            series = []
        } else {
            series = try item.descriptor.geometry.series.map { descriptor in
                let values: [Double?]
                if let computed = item.geometry.series[descriptor.id] {
                    values = computed
                } else if item.geometry.unavailableReason != nil {
                    values = []
                } else {
                    throw IndicatorRegistryError.invalid(
                        "\(item.indicatorId) did not produce the \(descriptor.id) series."
                    )
                }
                return IndicatorSeriesPresentation(
                    id: descriptor.id,
                    label: descriptor.label,
                    styleToken: descriptor.styleToken,
                    kind: item.geometry.kind == .histogram || descriptor.renderAs == "histogram"
                        ? .histogram
                        : .line,
                    values: values
                )
            }
        }
        let fills: [IndicatorFillPresentation]
        if item.geometry.kind == .band,
           let upper = item.descriptor.geometry.series.first,
           let lower = item.descriptor.geometry.series.last {
            fills = [.init(
                upperSeriesId: upper.id,
                lowerSeriesId: lower.id,
                styleToken: upper.styleToken
            )]
        } else if item.geometry.kind == .cloud,
                  let spanA = item.descriptor.geometry.series.first(where: { $0.id == "spanA" }),
                  let spanB = item.descriptor.geometry.series.first(where: { $0.id == "spanB" }) {
            fills = [.init(
                upperSeriesId: spanA.id,
                lowerSeriesId: spanB.id,
                styleToken: spanA.styleToken
            )]
        } else {
            fills = []
        }
        return IndicatorLiveRenderPlan(
            indicatorId: item.indicatorId,
            kind: item.geometry.kind,
            series: series,
            fills: fills,
            profileRows: item.geometry.rows,
            unavailableReason: item.geometry.unavailableReason
        )
    }
}

struct IndicatorPanePresentation: Identifiable, Equatable, Sendable {
    private struct GuideConfiguration {
        let lines: [Double]
        let range: ClosedRange<Double>
    }

    private static let guides: [String: GuideConfiguration] = [
        "rsi": .init(lines: [30, 70], range: 0...100),
        "stochastic": .init(lines: [20, 80], range: 0...100),
        "williams_r": .init(lines: [-80, -20], range: -100...0),
    ]

    let id: String
    let title: String
    let series: [IndicatorSeriesPresentation]
    let guideLines: [Double]
    let yRange: ClosedRange<Double>?
    let unavailableReason: String?

    init(item: IndicatorRenderItem) throws {
        let plan = try IndicatorLiveRenderer.plan(item: item)
        id = item.indicatorId
        title = item.descriptor.displayName
        unavailableReason = plan.unavailableReason
        series = plan.series
        guideLines = Self.guides[item.indicatorId]?.lines ?? []
        yRange = Self.guides[item.indicatorId]?.range
    }
}
