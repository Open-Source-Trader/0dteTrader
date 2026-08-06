import DGCharts
import UIKit

final class IndicatorPriceProfileOverlayView: UIView {
    weak var chart: CombinedChartView?
    var rows: [PriceProfileRow] = [] {
        didSet {
            if rows != oldValue { setNeedsDisplay() }
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
        guard let chart,
              !rows.isEmpty,
              let context = UIGraphicsGetCurrentContext()
        else { return }
        let content = chart.viewPortHandler.contentRect
        let maximumVolume = rows.map(\.volume).max() ?? 0
        guard maximumVolume > 0 else { return }
        let transformer = chart.getTransformer(forAxis: .left)
        context.saveGState()
        context.clip(to: content)
        for row in rows {
            let top = transformer.pixelForValues(x: 0, y: row.high).y
            let bottom = transformer.pixelForValues(x: 0, y: row.low).y
            guard top.isFinite, bottom.isFinite else { continue }
            let height = max(abs(bottom - top), 1)
            let width = content.width * 0.28 * CGFloat(row.volume / maximumVolume)
            let color = ChartStyle.indicatorColor(
                for: row.inValueArea ? "indicator.vpvr.value_area" : "indicator.vpvr.row"
            )
            context.setFillColor(color.withAlphaComponent(row.inValueArea ? 0.28 : 0.14).cgColor)
            context.fill(CGRect(x: content.maxX - width, y: min(top, bottom), width: width, height: height))
        }
        context.restoreGState()
    }
}
