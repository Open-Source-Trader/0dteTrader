import DGCharts
import UIKit

final class IndicatorFillOverlayView: UIView {
    weak var chart: CombinedChartView?
    var plans: [IndicatorLiveRenderPlan] = [] {
        didSet {
            if plans != oldValue { setNeedsDisplay() }
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func draw(_ rect: CGRect) {
        guard let chart, let context = UIGraphicsGetCurrentContext() else { return }
        let content = chart.viewPortHandler.contentRect
        let transformer = chart.getTransformer(forAxis: .left)
        context.saveGState()
        context.clip(to: content)
        for plan in plans {
            let series = Dictionary(uniqueKeysWithValues: plan.series.map { ($0.id, $0.values) })
            for fill in plan.fills {
                guard let upper = series[fill.upperSeriesId],
                      let lower = series[fill.lowerSeriesId]
                else { continue }
                context.setFillColor(
                    ChartStyle.indicatorColor(for: fill.styleToken).withAlphaComponent(0.16).cgColor
                )
                for run in IndicatorFillGeometry.contiguousRuns(upper: upper, lower: lower) {
                    let path = CGMutablePath()
                    for (offset, index) in run.indices.enumerated() {
                        let point = transformer.pixelForValues(x: Double(index), y: run.upper[offset])
                        if offset == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    }
                    for offset in run.indices.indices.reversed() {
                        let point = transformer.pixelForValues(
                            x: Double(run.indices[offset]),
                            y: run.lower[offset]
                        )
                        path.addLine(to: point)
                    }
                    path.closeSubpath()
                    context.addPath(path)
                    context.fillPath()
                }
            }
        }
        context.restoreGState()
    }
}
