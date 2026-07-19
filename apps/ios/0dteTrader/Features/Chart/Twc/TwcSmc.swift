import Foundation

/// TWC Heatmap V5 — SMC subset for phase 2 (twcSmc.ts port, 1:1):
/// swing/internal structure state (always computed — it feeds the confluence
/// engine's bias inputs), order blocks, and premium/discount zones. Drawing
/// is assembled from the final-bar state, like Pine's present-mode redraw.
enum TwcSmc {
    private static let internalSize = 5
    private static let zoneExtendBars = 20
    private static let obExtendBars = 40
    private static let maxOrderBlocks = 100

    private struct PivotState {
        var currentLevel: Double? = nil
        /// The level as of the END of the previous bar — Pine's ta.crossover
        /// compares close[1] against level[1], which matters on the exact bar
        /// a new pivot confirms.
        var prevBarLevel: Double? = nil
        var crossed = false
        var barIndex = 0
    }

    private struct OrderBlock {
        let barHigh: Double
        let barLow: Double
        let barIndex: Int
        let bias: Int // +1 bullish, -1 bearish
    }

    struct Result {
        /// Per-bar swing/internal structure bias (+1 / -1 / 0).
        let swingBias: [Int]
        let internalBias: [Int]
        let bands: [TwcBand]
        let labels: [TwcLabel]
    }

    /// Pine leg(): 0 = bearish leg (new high `size` bars back), 1 = bullish.
    private static func legAt(highs: [Double], lows: [Double], i: Int, size: Int, prevLeg: Int) -> Int {
        guard i >= size else { return prevLeg }
        var windowHigh = -Double.infinity
        var windowLow = Double.infinity
        for j in (i - size + 1)...i {
            windowHigh = max(windowHigh, highs[j])
            windowLow = min(windowLow, lows[j])
        }
        if highs[i - size] > windowHigh { return 0 }
        if lows[i - size] < windowLow { return 1 }
        return prevLeg
    }

    // swiftlint:disable:next function_body_length
    static func compute(candles: [Candle], settings: TwcHeatmapSettings) -> Result {
        let n = candles.count
        let highs = candles.map(\.high)
        let lows = candles.map(\.low)
        let closes = candles.map(\.close)

        var swingBias = [Int](repeating: 0, count: n)
        var internalBias = [Int](repeating: 0, count: n)
        guard n > 0 else { return Result(swingBias: swingBias, internalBias: internalBias, bands: [], labels: []) }

        let wantSwingOB = settings.showSwingOrderBlocks
        let wantInternalOB = settings.showInternalOrderBlocks
        let mitigateOnClose = settings.orderBlockMitigation == "Close"

        // Volatility parse (swap high/low on bars ranging >= 2x the measure)
        let atr200 = TwcMath.pineAtr(candles, period: 200)
        var parsedHighs = [Double](repeating: 0, count: n)
        var parsedLows = [Double](repeating: 0, count: n)
        var cumTrueRange = 0.0
        for i in 0..<n {
            let prevClose = i > 0 ? closes[i - 1] : closes[i]
            cumTrueRange += max(highs[i] - lows[i], abs(highs[i] - prevClose), abs(lows[i] - prevClose))
            let measure: Double? = settings.orderBlockFilter == "Atr"
                ? atr200[i]
                : cumTrueRange / Double(max(i, 1))
            let highVolatility = measure.map { highs[i] - lows[i] >= 2 * $0 } ?? false
            parsedHighs[i] = highVolatility ? lows[i] : highs[i]
            parsedLows[i] = highVolatility ? highs[i] : lows[i]
        }

        // ── Fold state (Pine `var`s) ──
        var swingHigh = PivotState()
        var swingLow = PivotState()
        var internalHigh = PivotState()
        var internalLow = PivotState()
        var swingTrendBias = 0
        var internalTrendBias = 0
        var legSwing = 0
        var legInternal = 0
        var trailingTop: Double? = nil
        var trailingBottom: Double? = nil
        var lastTopIdx = 0
        var lastBottomIdx = 0
        var swingOrderBlocks: [OrderBlock] = []
        var internalOrderBlocks: [OrderBlock] = []

        func storeOrderBlock(pivot: PivotState, internal isInternal: Bool, bias: Int, barIndex: Int) {
            if isInternal ? !wantInternalOB : !wantSwingOB { return }
            // Bearish blocks anchor at the highest parsed high since the
            // broken pivot; bullish at the lowest parsed low.
            var anchor = pivot.barIndex
            var j = pivot.barIndex
            while j < barIndex {
                if bias == -1 {
                    if parsedHighs[j] > parsedHighs[anchor] { anchor = j }
                } else if parsedLows[j] < parsedLows[anchor] {
                    anchor = j
                }
                j += 1
            }
            let block = OrderBlock(barHigh: parsedHighs[anchor], barLow: parsedLows[anchor], barIndex: anchor, bias: bias)
            if isInternal {
                if internalOrderBlocks.count >= maxOrderBlocks { internalOrderBlocks.removeLast() }
                internalOrderBlocks.insert(block, at: 0)
            } else {
                if swingOrderBlocks.count >= maxOrderBlocks { swingOrderBlocks.removeLast() }
                swingOrderBlocks.insert(block, at: 0)
            }
        }

        func deleteOrderBlocks(_ blocks: inout [OrderBlock], at i: Int) {
            for index in stride(from: blocks.count - 1, through: 0, by: -1) {
                let block = blocks[index]
                let bearishSource = mitigateOnClose ? closes[i] : highs[i]
                let bullishSource = mitigateOnClose ? closes[i] : lows[i]
                let crossed = (block.bias == -1 && bearishSource > block.barHigh)
                    || (block.bias == 1 && bullishSource < block.barLow)
                if crossed { blocks.remove(at: index) }
            }
        }

        // A close crossing the tracked pivot flips the bias and (when
        // enabled) stores an order block from the opposing extreme.
        func displayStructure(internal isInternal: Bool, at i: Int) {
            let prevClose = i > 0 ? closes[i - 1] : closes[i]

            // Internal breaks coinciding with the swing level defer to swing
            // structure (Pine extra condition; confluence filter not ported).
            let extraBull = isInternal ? internalHigh.currentLevel != swingHigh.currentLevel : true
            let pivotHighLevel = isInternal ? internalHigh.currentLevel : swingHigh.currentLevel
            let pivotHighPrevLevel = isInternal ? internalHigh.prevBarLevel : swingHigh.prevBarLevel
            let pivotHighCrossed = isInternal ? internalHigh.crossed : swingHigh.crossed
            if let level = pivotHighLevel, let prevLevel = pivotHighPrevLevel, !pivotHighCrossed, extraBull,
               closes[i] > level, prevClose <= prevLevel {
                if isInternal {
                    internalHigh.crossed = true
                    internalTrendBias = 1
                    storeOrderBlock(pivot: internalHigh, internal: true, bias: 1, barIndex: i)
                } else {
                    swingHigh.crossed = true
                    swingTrendBias = 1
                    storeOrderBlock(pivot: swingHigh, internal: false, bias: 1, barIndex: i)
                }
            }

            let extraBear = isInternal ? internalLow.currentLevel != swingLow.currentLevel : true
            let pivotLowLevel = isInternal ? internalLow.currentLevel : swingLow.currentLevel
            let pivotLowPrevLevel = isInternal ? internalLow.prevBarLevel : swingLow.prevBarLevel
            let pivotLowCrossed = isInternal ? internalLow.crossed : swingLow.crossed
            if let level = pivotLowLevel, let prevLevel = pivotLowPrevLevel, !pivotLowCrossed, extraBear,
               closes[i] < level, prevClose >= prevLevel {
                if isInternal {
                    internalLow.crossed = true
                    internalTrendBias = -1
                    storeOrderBlock(pivot: internalLow, internal: true, bias: -1, barIndex: i)
                } else {
                    swingLow.crossed = true
                    swingTrendBias = -1
                    storeOrderBlock(pivot: swingLow, internal: false, bias: -1, barIndex: i)
                }
            }
        }

        func applyStructure(internal isInternal: Bool, size: Int, at i: Int, prevLeg: Int) -> Int {
            let leg = legAt(highs: highs, lows: lows, i: i, size: size, prevLeg: prevLeg)
            if leg != prevLeg, i >= size {
                let pivotIdx = i - size
                if leg == 1 {
                    // start of bullish leg → confirmed pivot LOW (keep the
                    // prev-bar level snapshot for crossover [1] semantics)
                    if isInternal {
                        internalLow = PivotState(
                            currentLevel: lows[pivotIdx],
                            prevBarLevel: internalLow.prevBarLevel,
                            crossed: false,
                            barIndex: pivotIdx
                        )
                    } else {
                        swingLow = PivotState(
                            currentLevel: lows[pivotIdx],
                            prevBarLevel: swingLow.prevBarLevel,
                            crossed: false,
                            barIndex: pivotIdx
                        )
                        trailingBottom = lows[pivotIdx]
                        lastBottomIdx = pivotIdx
                    }
                } else {
                    // start of bearish leg → confirmed pivot HIGH
                    if isInternal {
                        internalHigh = PivotState(
                            currentLevel: highs[pivotIdx],
                            prevBarLevel: internalHigh.prevBarLevel,
                            crossed: false,
                            barIndex: pivotIdx
                        )
                    } else {
                        swingHigh = PivotState(
                            currentLevel: highs[pivotIdx],
                            prevBarLevel: swingHigh.prevBarLevel,
                            crossed: false,
                            barIndex: pivotIdx
                        )
                        trailingTop = highs[pivotIdx]
                        lastTopIdx = pivotIdx
                    }
                }
            }
            return leg
        }

        for i in 0..<n {
            // Trailing extremes feed the premium/discount zones.
            if settings.showPremiumDiscountZones {
                trailingTop = max(highs[i], trailingTop ?? highs[i])
                if trailingTop == highs[i] { lastTopIdx = i }
                trailingBottom = min(lows[i], trailingBottom ?? lows[i])
                if trailingBottom == lows[i] { lastBottomIdx = i }
            }

            legSwing = applyStructure(internal: false, size: settings.swingsLength, at: i, prevLeg: legSwing)
            legInternal = applyStructure(internal: true, size: internalSize, at: i, prevLeg: legInternal)

            displayStructure(internal: true, at: i)
            displayStructure(internal: false, at: i)

            if wantInternalOB { deleteOrderBlocks(&internalOrderBlocks, at: i) }
            if wantSwingOB { deleteOrderBlocks(&swingOrderBlocks, at: i) }

            swingBias[i] = swingTrendBias
            internalBias[i] = internalTrendBias

            // Snapshot each pivot level for next bar's crossover [1] comparison
            swingHigh.prevBarLevel = swingHigh.currentLevel
            swingLow.prevBarLevel = swingLow.currentLevel
            internalHigh.prevBarLevel = internalHigh.currentLevel
            internalLow.prevBarLevel = internalLow.currentLevel
        }

        // ── Final-bar drawing ──
        var bands: [TwcBand] = []
        var labels: [TwcLabel] = []
        let lastBar = n - 1

        func pushOrderBlocks(_ blocks: [OrderBlock], count: Int, internal isInternal: Bool) {
            for block in blocks.prefix(min(count, blocks.count)) {
                let bullish = block.bias == 1
                bands.append(
                    TwcBand(
                        x1: Double(block.barIndex),
                        x2: Double(lastBar + obExtendBars),
                        yTop: block.barHigh,
                        yBottom: block.barLow,
                        fillColor: isInternal
                            ? (bullish ? TwcColors.internalBullishOB : TwcColors.internalBearishOB)
                            : (bullish ? TwcColors.swingBullishOB : TwcColors.swingBearishOB),
                        // Pine: swing blocks are outlined, internal fill-only
                        borderColor: isInternal
                            ? nil
                            : (bullish ? TwcColors.swingBullishOBBorder : TwcColors.swingBearishOBBorder)
                    )
                )
            }
        }
        if wantInternalOB { pushOrderBlocks(internalOrderBlocks, count: settings.internalOrderBlocksSize, internal: true) }
        if wantSwingOB { pushOrderBlocks(swingOrderBlocks, count: settings.swingOrderBlocksSize, internal: false) }

        if settings.showPremiumDiscountZones, let top = trailingTop, let bottom = trailingBottom {
            let leftIdx = min(lastTopIdx, lastBottomIdx)
            let rightIdx = lastBar + zoneExtendBars
            let premiumBottom = 0.95 * top + 0.05 * bottom
            let equilibriumTop = 0.525 * top + 0.475 * bottom
            let equilibriumBottom = 0.525 * bottom + 0.475 * top
            let discountTop = 0.95 * bottom + 0.05 * top

            func zone(_ yTop: Double, _ yBottom: Double, fill: String, text: String, textColor: String) {
                bands.append(TwcBand(x1: Double(leftIdx), x2: Double(rightIdx), yTop: yTop, yBottom: yBottom, fillColor: fill))
                labels.append(
                    TwcLabel(
                        barIndex: Double(rightIdx),
                        price: (yTop + yBottom) / 2,
                        text: text,
                        textColor: textColor,
                        align: .left
                    )
                )
            }
            zone(top, premiumBottom, fill: TwcColors.premiumZone, text: "Premium", textColor: TwcColors.premiumText)
            zone(equilibriumTop, equilibriumBottom, fill: TwcColors.equilibriumZone, text: "Equilibrium", textColor: TwcColors.equilibriumText)
            zone(discountTop, bottom, fill: TwcColors.discountZone, text: "Discount", textColor: TwcColors.discountText)
        }

        return Result(swingBias: swingBias, internalBias: internalBias, bands: bands, labels: labels)
    }
}
