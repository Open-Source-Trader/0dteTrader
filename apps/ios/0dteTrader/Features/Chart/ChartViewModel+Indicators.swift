import UIKit

struct IndicatorRenderRevision: Equatable {
    let settings: IndicatorSettingsState
    let candles: [Candle]
    let l2Indicators: OrderBookIndicatorsDTO?
    let l2UnavailableReason: String
}

struct IndicatorRenderSnapshot: Equatable, Sendable {
    let renderModel: IndicatorRenderModel
    let priceOverlays: [IndicatorSeries]
    let overlayPlans: [IndicatorLiveRenderPlan]
    let profileRows: [PriceProfileRow]
    let subPanes: [IndicatorPanePresentation]

    static let empty = IndicatorRenderSnapshot(
        renderModel: .init(overlays: [], subPanes: []),
        priceOverlays: [],
        overlayPlans: [],
        profileRows: [],
        subPanes: []
    )

    static func make(
        registry: IndicatorRegistry,
        settings: IndicatorSettingsState,
        candles: [Candle],
        l2Indicators: OrderBookIndicatorsDTO? = nil,
        l2UnavailableReason: String = "No L2 data"
    ) throws -> IndicatorRenderSnapshot {
        let renderModel = try IndicatorRenderModel.make(
            registry: registry,
            settings: settings,
            candles: candles,
            l2Indicators: l2Indicators,
            l2UnavailableReason: l2UnavailableReason
        )
        return try make(renderModel: renderModel)
    }

    static func make(renderModel: IndicatorRenderModel) throws -> IndicatorRenderSnapshot {
        let overlayPlans = try renderModel.overlays.map(IndicatorLiveRenderer.plan)
        let subPanes = try renderModel.subPanes.map(IndicatorPanePresentation.init)
        let priceOverlays = overlayPlans.flatMap { plan in
            plan.series.map { series in
                IndicatorSeries(
                    id: series.styleToken,
                    name: series.label,
                    values: series.values
                )
            }
        }
        return IndicatorRenderSnapshot(
            renderModel: renderModel,
            priceOverlays: priceOverlays,
            overlayPlans: overlayPlans,
            profileRows: overlayPlans.flatMap(\.profileRows),
            subPanes: subPanes
        )
    }
}

struct ChartScriptPresentation {
    let renderModel: ScriptRenderModel?
    let warning: String?
}

extension ChartViewModel {
    var indicatorRenderModel: IndicatorRenderModel {
        indicatorRenderSnapshot.renderModel
    }

    var priceOverlays: [IndicatorSeries] {
        indicatorRenderSnapshot.priceOverlays
    }

    var overlayRenderPlans: [IndicatorLiveRenderPlan] {
        indicatorRenderSnapshot.overlayPlans
    }

    var priceProfileRows: [PriceProfileRow] {
        indicatorRenderSnapshot.profileRows
    }

    var subPanePresentations: [IndicatorPanePresentation] {
        indicatorRenderSnapshot.subPanes
    }

    var indicatorColors: [String: UIColor] {
        Dictionary(uniqueKeysWithValues: indicatorRegistry.indicators.flatMap { descriptor in
            descriptor.geometry.series.map { series in
                (series.styleToken, ChartStyle.indicatorColor(for: series.styleToken))
            }
        })
    }

    /// Change vs the open of the first candle of the current session — a
    /// client-side prev-close proxy (Quote carries no previous close).
    var dayChange: (change: Double, percent: Double)? {
        guard let last = candles.last else { return nil }
        let calendar = Calendar.current
        guard let sessionOpen = candles.first(where: {
            calendar.isDate($0.time, inSameDayAs: last.time)
        })?.open, sessionOpen > 0 else { return nil }
        let current = quote?.last ?? last.close
        let change = current - sessionOpen
        return (change, change / sessionOpen * 100)
    }

    var twcRenderModel: TwcRenderModel? {
        let seconds: Int
        if case .tick(let tickInterval) = interval {
            seconds = tickInterval.tickSize
        } else {
            seconds = Int(interval.seconds)
        }
        return TwcEngine.compute(
            candles: candles,
            settings: twcSettings,
            intervalSeconds: seconds
        )
    }

    var usrComputation: UsrComputation? {
        UsrEngine.compute(
            candles: candles,
            settings: usrSettings,
            chartIntervalSeconds: interval.isTick ? nil : interval.seconds,
            continuousSession: ChartSymbolCatalog.isContinuousMarket(symbol),
            lastCandleIsOpen: interval.isTick ? false : nil
        )
    }

    /// Computes each stateful script once for a chart presentation so the
    /// renderer and diagnostic row cannot observe different snapshots.
    var scriptPresentation: ChartScriptPresentation {
        let usr = usrComputation
        return ChartScriptPresentation(
            renderModel: ScriptRenderModel.merging([twcRenderModel, usr?.renderModel]),
            warning: usr?.warnings.first
        )
    }
}
