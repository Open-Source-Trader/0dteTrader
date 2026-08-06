import CoreGraphics
import DGCharts

/// `CandleStickChartRenderer` subclass that varies each candle's body width
/// with its relative volume (TradingView "Volume Candles"), while leaving
/// shadow (wick) drawing byte-identical to the stock renderer. Installed in
/// place of the stock renderer only while `volumeWeightedCandleWidth` is on;
/// see `CandleChartRepresentable.updateUIView` for the swap.
final class VolumeWeightedCandleStickChartRenderer: CandleStickChartRenderer {
    /// Per-bar volumes, index-aligned with the candle data set's entries.
    /// Set by the coordinator before each draw pass, mirroring how
    /// `dataProvider` is already injected by the base class.
    var volumes: [Double] = []

    override func drawDataSet(context: CGContext, dataSet: CandleChartDataSetProtocol) {
        guard let dataProvider else { return }

        let trans = dataProvider.getTransformer(forAxis: dataSet.axisDependency)
        let phaseY = animator.phaseY
        let showCandleBar = dataSet.showCandleBar

        // Same visible-range calculation the base renderer performs via its
        // private `_xBounds` — reconstructed here since that property isn't
        // visible to a subclass outside the DGCharts module.
        let bounds = XBounds(chart: dataProvider, dataSet: dataSet, animator: animator)

        context.saveGState()
        context.setLineWidth(dataSet.shadowWidth)

        // Pixel spacing between adjacent bars at the current zoom level,
        // computed once per draw pass (not per bar) and reused as
        // `normalCandleWidth` for every visible candle.
        let unitPixels = trans.pixelForValues(x: 1, y: 0)
        let originPixels = trans.pixelForValues(x: 0, y: 0)
        let normalCandleWidthPx = abs(unitPixels.x - originPixels.x)

        var visibleVolumes: [Double] = []
        if bounds.range >= 0 {
            for j in bounds.min...(bounds.min + bounds.range) where j < volumes.count {
                visibleVolumes.append(volumes[j])
            }
        }
        let referenceVolumePx = CandleWidth.referenceVolume(visibleVolumes)

        var shadowPoints = [CGPoint](repeating: CGPoint(), count: 4)

        for j in bounds where j < dataSet.entryCount {
            guard let e = dataSet.entryForIndex(j) as? CandleChartDataEntry else { continue }

            let xPos = e.x
            let open = e.open
            let close = e.close
            let high = e.high
            let low = e.low

            if showCandleBar {
                shadowPoints[0].x = CGFloat(xPos)
                shadowPoints[1].x = CGFloat(xPos)
                shadowPoints[2].x = CGFloat(xPos)
                shadowPoints[3].x = CGFloat(xPos)

                if open > close {
                    shadowPoints[0].y = CGFloat(high * phaseY)
                    shadowPoints[1].y = CGFloat(open * phaseY)
                    shadowPoints[2].y = CGFloat(low * phaseY)
                    shadowPoints[3].y = CGFloat(close * phaseY)
                } else if open < close {
                    shadowPoints[0].y = CGFloat(high * phaseY)
                    shadowPoints[1].y = CGFloat(close * phaseY)
                    shadowPoints[2].y = CGFloat(low * phaseY)
                    shadowPoints[3].y = CGFloat(open * phaseY)
                } else {
                    shadowPoints[0].y = CGFloat(high * phaseY)
                    shadowPoints[1].y = CGFloat(open * phaseY)
                    shadowPoints[2].y = CGFloat(low * phaseY)
                    shadowPoints[3].y = shadowPoints[1].y
                }

                trans.pointValuesToPixel(&shadowPoints)

                var shadowColor: NSUIColor!
                if dataSet.shadowColorSameAsCandle {
                    if open > close {
                        shadowColor = dataSet.decreasingColor ?? dataSet.color(atIndex: j)
                    } else if open < close {
                        shadowColor = dataSet.increasingColor ?? dataSet.color(atIndex: j)
                    } else {
                        shadowColor = dataSet.neutralColor ?? dataSet.color(atIndex: j)
                    }
                }
                if shadowColor == nil {
                    shadowColor = dataSet.shadowColor ?? dataSet.color(atIndex: j)
                }

                context.setStrokeColor(shadowColor.cgColor)
                context.strokeLineSegments(between: shadowPoints)

                // Body: transform the center/open/close to pixel space first,
                // then inflate the x-extent by the volume-weighted width in
                // pixel space. This sidesteps any value-space distortion the
                // upstream value-space rect would otherwise need to account
                // for, and keeps the candle centered on its own timestamp
                // regardless of computed width.
                let centerPixel = trans.pixelForValues(x: xPos, y: 0)
                let openPixel = trans.pixelForValues(x: xPos, y: open * Double(phaseY))
                let closePixel = trans.pixelForValues(x: xPos, y: close * Double(phaseY))

                let volume = j < volumes.count ? volumes[j] : 0
                let width = CandleWidth.calculate(
                    volume: volume,
                    referenceVolume: referenceVolumePx,
                    normalCandleWidth: normalCandleWidthPx
                )

                // Snap to whole device pixels: the stock renderer's rects
                // read crisp because they land on the pixel grid, while
                // unsnapped fractional rects blur under anti-aliasing —
                // most visible at narrow, volume-weighted widths. Snapping
                // the edges rather than the center keeps width as close to
                // the computed value as a whole pixel count allows while
                // staying visually centered.
                let left = (centerPixel.x - width / 2).rounded()
                let right = max(left + 1, (centerPixel.x + width / 2).rounded())
                let top = min(openPixel.y, closePixel.y).rounded()
                let bottom = max(top + 1, max(openPixel.y, closePixel.y).rounded())
                let bodyRect = CGRect(x: left, y: top, width: right - left, height: bottom - top)

                if open > close {
                    let color = dataSet.decreasingColor ?? dataSet.color(atIndex: j)
                    if dataSet.isDecreasingFilled {
                        context.setFillColor(color.cgColor)
                        context.fill(bodyRect)
                        // Hairline border in the body's own color: separates
                        // one candle's edge from its neighbor instead of a
                        // flat, borderless fill reading as a smeared block at
                        // narrow widths (same treatment as the up-candle's
                        // hollow stroke, which is already crisp by nature).
                        context.setStrokeColor(color.cgColor)
                        context.stroke(bodyRect.insetBy(dx: 0.5, dy: 0.5))
                    } else {
                        context.setStrokeColor(color.cgColor)
                        context.stroke(bodyRect)
                    }
                } else if open < close {
                    let color = dataSet.increasingColor ?? dataSet.color(atIndex: j)
                    if dataSet.isIncreasingFilled {
                        context.setFillColor(color.cgColor)
                        context.fill(bodyRect)
                        context.setStrokeColor(color.cgColor)
                        context.stroke(bodyRect.insetBy(dx: 0.5, dy: 0.5))
                    } else {
                        context.setStrokeColor(color.cgColor)
                        context.stroke(bodyRect)
                    }
                } else {
                    let color = dataSet.neutralColor ?? dataSet.color(atIndex: j)
                    context.setStrokeColor(color.cgColor)
                    context.stroke(bodyRect)
                }
            }
        }

        context.restoreGState()
    }
}
