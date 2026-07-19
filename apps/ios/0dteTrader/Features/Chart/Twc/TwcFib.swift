import Foundation

/// TWC Heatmap V5 — SD Fibonacci / Gann engine (twcFib.ts port, 1:1). A
/// single left-to-right fold reproduces the Pine script's per-bar `var` state
/// (zigzag pivots, instant flips, hit latches, ratio growth); geometry is
/// assembled from the state after the final bar. Pine deletes and redraws all
/// objects per swing, so a full recompute is equivalent.
enum TwcFib {
    private static let fibNeg0618 = -0.618033988749895
    private static let fib0618 = 0.618033988749895
    private static let fib0786 = 0.786151377757423
    private static let fib1618 = 1.618033988749895
    private static let epsilon = 0.0001
    private static let lineLookback = 1200
    private static let projXRight = 40

    private struct RatioEntry {
        let ratio: Double
        let color: String
    }

    struct Result {
        let segments: [TwcSegment]
        let bands: [TwcBand]
        let labels: [TwcLabel]

        static let empty = Result(segments: [], bands: [], labels: [])
    }

    private static func round4(_ v: Double) -> Double { (v * 10_000).rounded() / 10_000 }
    private static func approxEqual(_ a: Double, _ b: Double) -> Bool { abs(a - b) < epsilon }

    private static func seedRatios(useStandard: Bool) -> [RatioEntry] {
        [
            RatioEntry(ratio: round4(useStandard ? fibNeg0618 : -0.1618), color: TwcColors.red50),
            RatioEntry(ratio: 0, color: TwcColors.white50),
            RatioEntry(ratio: round4(fib0618), color: TwcColors.amberBand),
            RatioEntry(ratio: round4(fib0786), color: TwcColors.amberBand),
            RatioEntry(ratio: 1, color: TwcColors.white50),
        ]
    }

    /// Pine fib_ensureExtRatios: dedup-append into the store.
    private static func ensureExtRatios(_ store: inout [RatioEntry], ratios: [Double], colors: [String]) {
        for (i, ratio) in ratios.enumerated() {
            let rounded = round4(ratio)
            if !store.contains(where: { approxEqual($0.ratio, rounded) }) {
                store.append(RatioEntry(ratio: rounded, color: colors[i]))
            }
        }
    }

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    static func compute(candles: [Candle], settings: TwcHeatmapSettings, atr14: [Double?]) -> Result {
        guard settings.showFibonacci, !candles.isEmpty else { return .empty }

        let n = candles.count
        let prd = settings.fibPeriod
        let highs = candles.map(\.high)
        let lows = candles.map(\.low)
        let opens = candles.map(\.open)
        let closes = candles.map(\.close)
        let volumes = candles.map { Double($0.volume) }
        let useWick = settings.fibPivotSource == "Wick"
        let negExtLevel = settings.useStandardRatios ? fibNeg0618 : -0.1618

        func pivotPriceAt(_ idx: Int, isHigh: Bool) -> Double {
            if useWick { return isHigh ? highs[idx] : lows[idx] }
            return isHigh ? max(opens[idx], closes[idx]) : min(opens[idx], closes[idx])
        }

        // Simple Pivots confirmations, precomputed (value at confirmation bar)
        let simple = settings.fibMethod == "Simple Pivots"
        let ph = simple ? TwcMath.pivotHigh(highs, left: prd, right: prd) : []
        let pl = simple ? TwcMath.pivotLow(lows, left: prd, right: prd) : []

        // ── Fold state (Pine `var`s) ──
        var zz: [Double] = [] // [val, idx, val, idx, ...] newest first, cap 30
        var dir = 0
        var pendingVal: Double? = nil
        var pendingIdx = 0
        var pendingDir = 0
        var pendingBar: Int? = nil
        var hit0618Ret = false
        var ratios = seedRatios(useStandard: settings.useStandardRatios)
        var prevBase: Double? = nil
        var prevLast: Double? = nil
        var prevBaseIdx: Int? = nil
        var prevLastIdx: Int? = nil
        var prevAllowMaxPT = -2
        var prevBand0 = false
        var prevMaxHit = -1
        var gannFixedScale: Double? = nil
        var dirAtPrevBarEnd = 0

        func zzAdd(_ value: Double, _ idx: Int) {
            zz.insert(contentsOf: [value, Double(idx)], at: 0)
            while zz.count > 30 { zz.removeLast(2) }
        }
        func zzUpdate(_ value: Double, _ idx: Int) {
            if zz.isEmpty {
                zzAdd(value, idx)
            } else if (dir == 1 && value > zz[0]) || (dir == -1 && value < zz[0]) {
                zz[0] = value
                zz[1] = Double(idx)
            }
        }

        var finalBase = 0.0
        var finalLast = 0.0
        var finalBaseIdx = 0
        var finalLastIdx = 0
        var finalHasSwing = false
        var finalHits = [Bool](repeating: false, count: 10)
        var finalAllowMaxPT = -1
        var finalMaxHitRange = 0

        for i in 0..<n {
            // ── 1. Swing detection ──
            if !simple {
                // Volume Filtered
                let confirmDelay = prd
                let phOff = TwcMath.highestBarsOffset(highs, at: i, length: prd)
                let plOff = TwcMath.lowestBarsOffset(lows, at: i, length: prd)
                let vOff = TwcMath.highestBarsOffset(volumes, at: i, length: prd)
                let snap = 2
                let nearH = abs(vOff - phOff) <= snap
                let nearL = abs(vOff - plOff) <= snap
                let isNewHigh = phOff == 0 && nearH
                let isNewLow = plOff == 0 && nearL

                if isNewHigh && !isNewLow {
                    pendingIdx = i
                    pendingVal = pivotPriceAt(i, isHigh: true)
                    pendingDir = 1
                    pendingBar = i
                } else if isNewLow && !isNewHigh {
                    pendingIdx = i
                    pendingVal = pivotPriceAt(i, isHigh: false)
                    pendingDir = -1
                    pendingBar = i
                } else if isNewHigh && isNewLow {
                    let mid = (highs[i] + lows[i]) / 2
                    let asHigh = highs[i] - mid >= mid - lows[i]
                    pendingIdx = i
                    pendingVal = pivotPriceAt(i, isHigh: asHigh)
                    pendingDir = asHigh ? 1 : -1
                    pendingBar = i
                }

                if let bar = pendingBar, i - bar >= confirmDelay, let pv = pendingVal {
                    var stillValid = true
                    for j in 0...min(confirmDelay - 1, i) {
                        if pendingDir == 1 {
                            if highs[i - j] > highs[pendingIdx] {
                                stillValid = false
                                break
                            }
                        } else if lows[i - j] < lows[pendingIdx] {
                            stillValid = false
                            break
                        }
                    }
                    if stillValid {
                        let minMove = atr14[i].map { $0 * 0.25 }
                        var shouldAdd = true
                        if zz.count >= 2, let mm = minMove, abs(pv - zz[0]) < mm {
                            shouldAdd = false
                        }
                        if shouldAdd {
                            if pendingDir != dir || zz.isEmpty {
                                zzAdd(pv, pendingIdx)
                            } else {
                                let isHigher = pendingDir == 1 && pv > zz[0]
                                let isLower = pendingDir == -1 && pv < zz[0]
                                if isHigher || isLower { zzUpdate(pv, pendingIdx) }
                            }
                            dir = pendingDir
                        }
                    }
                    pendingVal = nil
                    pendingDir = 0
                    pendingBar = nil
                }
            } else {
                // Simple Pivots
                let hasHigh = ph[i] != nil
                let hasLow = pl[i] != nil
                let pivotIdx = i - prd
                if pivotIdx >= 0, hasHigh || hasLow {
                    let finalPh = hasHigh ? pivotPriceAt(pivotIdx, isHigh: true) : 0
                    let finalPl = hasLow ? pivotPriceAt(pivotIdx, isHigh: false) : 0
                    if hasHigh && hasLow {
                        if dir == 1 {
                            dir = -1
                            zzAdd(finalPl, pivotIdx)
                        } else if dir == -1 {
                            dir = 1
                            zzAdd(finalPh, pivotIdx)
                        } else {
                            dir = 1
                            zzAdd(finalPh, pivotIdx)
                        }
                    } else if hasHigh {
                        if dir == 1 {
                            let currentHigh = zz.isEmpty ? -999_999 : zz[0]
                            if finalPh > currentHigh { zzUpdate(finalPh, pivotIdx) }
                        } else {
                            dir = 1
                            zzAdd(finalPh, pivotIdx)
                        }
                    } else if hasLow {
                        if dir == -1 {
                            let currentLow = zz.isEmpty ? 999_999 : zz[0]
                            if finalPl < currentLow { zzUpdate(finalPl, pivotIdx) }
                        } else {
                            dir = -1
                            zzAdd(finalPl, pivotIdx)
                        }
                    }
                }
            }

            // Gann Auto-ATR scale freezes on the first bar with a valid ATR
            if settings.gannScaleMethod == "Auto (ATR-based)", gannFixedScale == nil, let a = atr14[i] {
                gannFixedScale = a * settings.gannATRMultiplier
            }

            let swingFlip = dir != dirAtPrevBarEnd
            dirAtPrevBarEnd = dir

            // ── 2. Per-bar fib logic (needs two pivots) ──
            guard zz.count >= 4 else { continue }

            var b = zz[2]
            var l = zz[0]
            var bIdx = Int(zz[3].rounded())
            var lIdx = Int(zz[1].rounded())
            var d = l - b
            var up = d >= 0
            var forceRebuild = false

            // Instant flip on threshold break
            if settings.flipEnable {
                let rFlip: Double
                if settings.flipLevel == "0.000" {
                    rFlip = 0
                } else if settings.flipLevel == "±0.618" {
                    rFlip = up ? negExtLevel : -negExtLevel
                } else {
                    rFlip = up ? -1.618 : 1.618
                }
                let flipPx = b + d * rFlip
                let doFlip: Bool
                if settings.flipTrigger == "Wick" {
                    doFlip = up ? lows[i] < flipPx : highs[i] > flipPx
                } else {
                    doFlip = up ? closes[i] < flipPx : closes[i] > flipPx
                }
                if doFlip {
                    let newVal = settings.flipTrigger == "Wick" ? (up ? lows[i] : highs[i]) : closes[i]
                    zzAdd(newVal, i)
                    dir = up ? -1 : 1
                    dirAtPrevBarEnd = dir
                    ratios = seedRatios(useStandard: settings.useStandardRatios)
                    b = zz[2]
                    l = zz[0]
                    bIdx = Int(zz[3].rounded())
                    lIdx = Int(zz[1].rounded())
                    d = l - b
                    up = d >= 0
                    forceRebuild = true
                }
            }

            let pivotChanged = b != prevBase || l != prevLast || bIdx != prevBaseIdx || lIdx != prevLastIdx
            if swingFlip || pivotChanged || forceRebuild {
                hit0618Ret = false
            }

            // ── 3. Hit scan since the last pivot (cap 500 bars) ──
            let maxLookback = min(max(0, i - lIdx), 500, i)
            var hits = [Bool](repeating: false, count: 10)
            if maxLookback > 0 {
                var maxHigh = -Double.infinity
                var minLow = Double.infinity
                for j in (i - maxLookback + 1)...i {
                    maxHigh = max(maxHigh, highs[j])
                    minLow = min(minLow, lows[j])
                }
                for k in 1...9 {
                    let level = b + d * Double(k)
                    hits[k] = up ? maxHigh >= level : minLow <= level
                }
                let lvl0618 = b + d * fib0618
                hit0618Ret = up ? maxHigh >= lvl0618 : minLow <= lvl0618
            }

            // ── 4. Ratio growth ──
            if settings.ptAlwaysShowFirst {
                ensureExtRatios(&ratios, ratios: [fib1618, 1.786], colors: [TwcColors.gold50, TwcColors.gold50])
            }
            if hits[1] {
                ensureExtRatios(
                    &ratios,
                    ratios: [1.162, fib1618, 1.786, 2.0],
                    colors: [TwcColors.white50, TwcColors.gold50, TwcColors.gold50, TwcColors.white50]
                )
            }
            for k in 2...9 where hits[k] {
                ensureExtRatios(
                    &ratios,
                    ratios: [Double(k) + 0.618, Double(k) + 0.786, Double(k) + 1],
                    colors: [TwcColors.gold50, TwcColors.gold50, TwcColors.white50]
                )
            }

            // ── 5. PT gates ──
            var allowMaxPT = settings.ptAlwaysShowFirst ? 1 : -1
            if hit0618Ret { allowMaxPT = max(allowMaxPT, 0) }
            for k in 1...9 where hits[k] { allowMaxPT = max(allowMaxPT, k) }
            var maxHitRange = 0
            for k in stride(from: 9, through: 1, by: -1) where hits[k] {
                maxHitRange = k
                break
            }

            let ptChanged = allowMaxPT != prevAllowMaxPT || hit0618Ret != prevBand0 || maxHitRange != prevMaxHit
            if swingFlip || pivotChanged || prevBase == nil || forceRebuild || ptChanged {
                prevBase = b
                prevLast = l
                prevBaseIdx = bIdx
                prevLastIdx = lIdx
                prevAllowMaxPT = allowMaxPT
                prevBand0 = hit0618Ret
                prevMaxHit = maxHitRange
            }

            finalBase = b
            finalLast = l
            finalBaseIdx = bIdx
            finalLastIdx = lIdx
            finalHasSwing = true
            finalHits = hits
            finalAllowMaxPT = allowMaxPT
            finalMaxHitRange = maxHitRange
        }

        guard finalHasSwing else { return .empty }

        // ── Geometry assembly from the final-bar state ──
        let lastBar = n - 1
        let diff = finalLast - finalBase
        func clampStart(_ x: Int) -> Int {
            min(max(x, max(0, lastBar - lineLookback)), lastBar)
        }

        let finalAtr = atr14[lastBar]
        var pricePerBar: Double
        switch settings.gannScaleMethod {
        case "Swing-Relative (Original)":
            pricePerBar = abs(diff) / Double(max(1, abs(finalLastIdx - finalBaseIdx)))
        case "Auto (ATR-based)":
            pricePerBar = gannFixedScale ?? (finalAtr.map { $0 * settings.gannATRMultiplier } ?? 0)
        default:
            pricePerBar = settings.gannManualScale
        }
        if pricePerBar == 0 { pricePerBar = finalAtr.map { $0 * 0.1 } ?? 1 }

        let boxH = abs(diff)
        let gannWidth = min(max(1, Int((boxH / pricePerBar).rounded())), 500)
        let gannXL = clampStart(finalLastIdx)
        let gannXR = min(gannXL + gannWidth, lastBar + 500)

        let extensionBars = settings.showGannFan ? max(projXRight, gannXR - lastBar) : projXRight
        let xRight = lastBar + extensionBars

        var segments: [TwcSegment] = []
        var bands: [TwcBand] = []
        var labels: [TwcLabel] = []

        // Per-ratio visibility ladder (hit-gated; alwaysShowFirst reveals
        // exactly the 1.618/1.786 band lines early)
        func ratioVisible(_ r: Double) -> Bool {
            if r <= 1 + epsilon { return true }
            if r <= 2 + epsilon {
                return finalHits[1]
                    || (settings.ptAlwaysShowFirst && (approxEqual(r, round4(fib1618)) || approxEqual(r, 1.786)))
            }
            for k in 2...9 where r <= Double(k + 1) + epsilon { return finalHits[k] }
            return finalHits[9]
        }

        var ratioX1: [Double: Int] = [:]
        for entry in ratios {
            let x1 = clampStart(approxEqual(entry.ratio, 1) ? finalLastIdx : finalBaseIdx)
            ratioX1[entry.ratio] = x1
            guard ratioVisible(entry.ratio) else { continue }
            let level = finalBase + diff * entry.ratio
            segments.append(TwcSegment(x1: Double(x1), y1: level, x2: Double(xRight), y2: level, color: entry.color, width: 2, style: .solid))

            if settings.showFibRatioLabels || settings.showFibPriceLabels {
                var parts: [String] = []
                if settings.showFibRatioLabels {
                    parts.append(formatRatio(entry.ratio))
                }
                if settings.showFibPriceLabels {
                    let price = String(format: "%.2f", level)
                    parts.append(settings.showFibRatioLabels ? "(\(price))" : price)
                }
                let onLeft = settings.fibLabelPosition == "Left"
                labels.append(
                    TwcLabel(
                        barIndex: Double(onLeft ? x1 - 1 : xRight),
                        price: level,
                        text: parts.joined(separator: "  "),
                        textColor: TwcColors.fibLabel,
                        align: onLeft ? .right : .left
                    )
                )
            }
        }

        // Profit-target bands + labels
        if settings.shadeBands || settings.showPTLabels {
            var ptN = 1
            for kk in 0...max(0, finalAllowMaxPT) {
                if kk > finalAllowMaxPT { continue }
                // Pine parity: band 0 (the 0.618–0.786 retracement shade)
                // NEVER renders on TradingView — the script looks up its
                // 0.786 end line by the literal key "0.786" while the stored
                // seed ratio rounds to 0.7862, so the lookup silently fails.
                if kk == 0 { continue }
                let rStart = round4(Double(kk) + 0.618)
                let rEnd = round4(Double(kk) + 0.786)
                guard let startEntry = ratios.first(where: { approxEqual($0.ratio, rStart) }),
                      let endEntry = ratios.first(where: { approxEqual($0.ratio, rEnd) })
                else { continue }
                let yStart = finalBase + diff * startEntry.ratio
                let yEnd = finalBase + diff * endEntry.ratio
                let xLeft = max(ratioX1[startEntry.ratio] ?? 0, ratioX1[endEntry.ratio] ?? 0)
                if settings.shadeBands {
                    bands.append(
                        TwcBand(
                            x1: Double(xLeft),
                            x2: Double(xRight),
                            yTop: max(yStart, yEnd),
                            yBottom: min(yStart, yEnd),
                            fillColor: TwcColors.amberBand
                        )
                    )
                }
                let isExtBand = rStart >= 1
                if settings.showPTLabels && (isExtBand || !settings.ptExtensionsOnly) {
                    labels.append(
                        TwcLabel(
                            barIndex: Double(min(xLeft + 20, lastBar + projXRight / 2)),
                            price: (yStart + yEnd) / 2,
                            text: "\(settings.ptPrefix)\(ptN)",
                            textColor: TwcColors.ptText,
                            bgColor: TwcColors.ptPill,
                            align: .center
                        )
                    )
                }
                if isExtBand { ptN += 1 }
            }
        }

        // Gann squares: projected forward from the fib-1 pivot; one square per
        // unlocked extension range, stacked vertically in the same time span
        if settings.showGannFan, gannXR - gannXL >= 1, boxH > 0 {
            let boxW = gannXR - gannXL
            let fanAngles: [(on: Bool, ratio: Double)] = [
                (settings.gann1x1, 1), (settings.gann2x1, 2), (settings.gann1x2, 0.5),
                (settings.gann3x1, 3), (settings.gann1x3, 0.333), (settings.gann4x1, 4),
                (settings.gann1x4, 0.25), (settings.gann8x1, 8), (settings.gann1x8, 0.125),
            ]
            func cornerRay(_ cx: Int, _ cy: Double, _ dxSign: Int, _ dySign: Double, _ ratio: Double) {
                let endX = ratio <= 1
                    ? cx + dxSign * boxW
                    : cx + dxSign * max(1, Int((Double(boxW) / ratio).rounded()))
                let endY = ratio <= 1 ? cy + dySign * ratio * boxH : cy + dySign * boxH
                segments.append(TwcSegment(x1: Double(cx), y1: cy, x2: Double(endX), y2: endY, color: TwcColors.gannFan, width: 1, style: .dotted))
            }
            for k in 0...max(0, finalMaxHitRange) {
                let yA = finalBase + diff * Double(k)
                let yB = finalBase + diff * Double(k + 1)
                let yTop = max(yA, yB)
                let yBot = min(yA, yB)
                for angle in fanAngles where angle.on {
                    cornerRay(gannXL, yTop, 1, -1, angle.ratio)
                    cornerRay(gannXL, yBot, 1, 1, angle.ratio)
                    cornerRay(gannXR, yTop, -1, -1, angle.ratio)
                    cornerRay(gannXR, yBot, -1, 1, angle.ratio)
                }
                if settings.showGannBox {
                    let frame = TwcColors.gannBox
                    segments.append(TwcSegment(x1: Double(gannXL), y1: yTop, x2: Double(gannXR), y2: yTop, color: frame, width: 1, style: .dashed))
                    segments.append(TwcSegment(x1: Double(gannXL), y1: yBot, x2: Double(gannXR), y2: yBot, color: frame, width: 1, style: .dashed))
                    segments.append(TwcSegment(x1: Double(gannXL), y1: yTop, x2: Double(gannXL), y2: yBot, color: frame, width: 1, style: .dashed))
                    segments.append(TwcSegment(x1: Double(gannXR), y1: yTop, x2: Double(gannXR), y2: yBot, color: frame, width: 1, style: .dashed))
                }
            }
        }

        return Result(segments: segments, bands: bands, labels: labels)
    }

    /// Direction-only zigzag fold (Pine f_calcFibDirection): the same swing
    /// detection + instant flip, returning +1/-1 per bar once two pivots
    /// exist, 0 before. Runs regardless of showFibonacci — it feeds the
    /// confluence score and the six MTF votes (fibDirectionSeries in twcFib.ts).
    // swiftlint:disable:next function_body_length cyclomatic_complexity
    static func fibDirectionSeries(candles: [Candle], settings: TwcHeatmapSettings) -> [Int] {
        let n = candles.count
        var direction = [Int](repeating: 0, count: n)
        guard n > 0 else { return direction }
        let prd = settings.fibPeriod
        let highs = candles.map(\.high)
        let lows = candles.map(\.low)
        let opens = candles.map(\.open)
        let closes = candles.map(\.close)
        let volumes = candles.map { Double($0.volume) }
        let atr14 = TwcMath.pineAtr(candles, period: 14)
        let useWick = settings.fibPivotSource == "Wick"
        let negExtLevel = settings.useStandardRatios ? fibNeg0618 : -0.1618
        let simple = settings.fibMethod == "Simple Pivots"
        let ph = simple ? TwcMath.pivotHigh(highs, left: prd, right: prd) : []
        let pl = simple ? TwcMath.pivotLow(lows, left: prd, right: prd) : []

        func pivotPriceAt(_ idx: Int, isHigh: Bool) -> Double {
            if useWick { return isHigh ? highs[idx] : lows[idx] }
            return isHigh ? max(opens[idx], closes[idx]) : min(opens[idx], closes[idx])
        }

        var zz: [Double] = []
        var dir = 0
        var pendingVal: Double? = nil
        var pendingIdx = 0
        var pendingDir = 0
        var pendingBar: Int? = nil

        func zzAdd(_ value: Double, _ idx: Int) {
            zz.insert(contentsOf: [value, Double(idx)], at: 0)
            while zz.count > 30 { zz.removeLast(2) }
        }

        for i in 0..<n {
            if !simple {
                let phOff = TwcMath.highestBarsOffset(highs, at: i, length: prd)
                let plOff = TwcMath.lowestBarsOffset(lows, at: i, length: prd)
                let vOff = TwcMath.highestBarsOffset(volumes, at: i, length: prd)
                let isNewHigh = phOff == 0 && abs(vOff - phOff) <= 2
                let isNewLow = plOff == 0 && abs(vOff - plOff) <= 2
                if isNewHigh != isNewLow {
                    pendingIdx = i
                    pendingVal = pivotPriceAt(i, isHigh: isNewHigh)
                    pendingDir = isNewHigh ? 1 : -1
                    pendingBar = i
                } else if isNewHigh, isNewLow {
                    let mid = (highs[i] + lows[i]) / 2
                    let asHigh = highs[i] - mid >= mid - lows[i]
                    pendingIdx = i
                    pendingVal = pivotPriceAt(i, isHigh: asHigh)
                    pendingDir = asHigh ? 1 : -1
                    pendingBar = i
                }
                if let bar = pendingBar, i - bar >= prd, let pv = pendingVal {
                    var stillValid = true
                    for j in 0...min(prd - 1, i) {
                        if pendingDir == 1 ? highs[i - j] > highs[pendingIdx] : lows[i - j] < lows[pendingIdx] {
                            stillValid = false
                            break
                        }
                    }
                    if stillValid {
                        let skip = zz.count >= 2 && atr14[i].map { abs(pv - zz[0]) < $0 * 0.25 } ?? false
                        if !skip {
                            if pendingDir != dir || zz.isEmpty {
                                zzAdd(pv, pendingIdx)
                            } else if (pendingDir == 1 && pv > zz[0]) || (pendingDir == -1 && pv < zz[0]) {
                                zz[0] = pv
                                zz[1] = Double(pendingIdx)
                            }
                            dir = pendingDir
                        }
                    }
                    pendingVal = nil
                    pendingDir = 0
                    pendingBar = nil
                }
            } else {
                let hasHigh = ph[i] != nil
                let hasLow = pl[i] != nil
                let pivotIdx = i - prd
                if pivotIdx >= 0, hasHigh || hasLow {
                    let finalPh = hasHigh ? pivotPriceAt(pivotIdx, isHigh: true) : 0
                    let finalPl = hasLow ? pivotPriceAt(pivotIdx, isHigh: false) : 0
                    if hasHigh, hasLow {
                        let toLow = dir == 1
                        dir = toLow ? -1 : 1
                        zzAdd(toLow ? finalPl : finalPh, pivotIdx)
                    } else if hasHigh {
                        if dir == 1 {
                            if zz.count >= 2, finalPh > zz[0] {
                                zz[0] = finalPh
                                zz[1] = Double(pivotIdx)
                            }
                        } else {
                            dir = 1
                            zzAdd(finalPh, pivotIdx)
                        }
                    } else if hasLow {
                        if dir == -1 {
                            if zz.count >= 2, finalPl < zz[0] {
                                zz[0] = finalPl
                                zz[1] = Double(pivotIdx)
                            }
                        } else {
                            dir = -1
                            zzAdd(finalPl, pivotIdx)
                        }
                    }
                }
            }

            guard zz.count >= 4 else { continue }
            var base = zz[2]
            var last = zz[0]
            var diff = last - base
            var isUp = diff >= 0

            if settings.flipEnable {
                let rFlip: Double
                if settings.flipLevel == "0.000" {
                    rFlip = 0
                } else if settings.flipLevel == "±0.618" {
                    rFlip = isUp ? negExtLevel : -negExtLevel
                } else {
                    rFlip = isUp ? -1.618 : 1.618
                }
                let flipPx = base + diff * rFlip
                let doFlip: Bool
                if settings.flipTrigger == "Wick" {
                    doFlip = isUp ? lows[i] < flipPx : highs[i] > flipPx
                } else {
                    doFlip = isUp ? closes[i] < flipPx : closes[i] > flipPx
                }
                if doFlip {
                    let newVal = settings.flipTrigger == "Wick" ? (isUp ? lows[i] : highs[i]) : closes[i]
                    zzAdd(newVal, i)
                    dir = isUp ? -1 : 1
                    base = zz[2]
                    last = zz[0]
                    diff = last - base
                    isUp = diff >= 0
                }
            }
            direction[i] = isUp ? 1 : -1
        }
        return direction
    }

    /// "1.618" / "1" style formatting matching the desktop label text.
    private static func formatRatio(_ ratio: Double) -> String {
        var text = String(format: "%.4f", ratio)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text.isEmpty ? "0" : text
    }
}
