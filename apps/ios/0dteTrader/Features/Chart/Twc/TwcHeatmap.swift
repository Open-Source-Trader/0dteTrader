import Foundation

/// TWC Heatmap V5 — heatmap ensemble (HMM + MSI), SuperTrend stack, MACD
/// alignment, Bollinger envelope, markers, regime candle colors and the bias
/// banner (twcHeatmap.ts port, 1:1).
enum TwcHeatmap {
    // HMM emission archetypes (mean, sigma) per state for (return, volatility)
    private static let muRet = (bull: 0.7, chop: 0.0, bear: -0.7)
    private static let sdRet = (bull: 0.9, chop: 0.6, bear: 0.9)
    private static let muVol = (bull: 0.3, chop: -0.3, bear: 0.5)
    private static let sdVol = (bull: 1.0, chop: 0.8, bear: 1.0)

    struct Result {
        let candleColors: [String?]?
        let markers: [TwcMarker]
        let lines: [TwcLine]
        let fills: [TwcAreaFill]
        let banner: TwcBanner?
        /// ta.atr(14) reused by the fib engine (minMove + Gann fallback scale).
        let atr14: [Double?]
        // ── Per-bar series consumed by the confluence engine ──
        let msi: [Double?]
        /// CTF supertrend direction sign per bar: +1 bull, -1 bear, 0 warm-up.
        let ctfDir: [Int]
        /// All-enabled HTF stack agreement per bar, respecting toggles.
        let stackDir: [Int]
        /// ST-gated heatmap LONG/SHORT triggers per bar.
        let crossUp: [Bool]
        let crossDn: [Bool]
    }

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    static func compute(candles: [Candle], settings: TwcHeatmapSettings, intervalSeconds: Int) -> Result {
        let n = candles.count
        let src = TwcMath.sourceSeries(candles, source: settings.source)
        let closes = candles.map(\.close)
        let atr14 = TwcMath.pineAtr(candles, period: 14)

        // ── MODEL 1: HMM observations ──
        let logret: [Double?] = src.indices.map { i in
            let prev = i > 0 ? src[i - 1] : src[i]
            return prev == 0 ? 0 : log(src[i] / prev)
        }
        let zRet = TwcMath.zscore(logret, period: settings.hmmLook)
        let zVol = TwcMath.zscore(atr14, period: settings.hmmLook)

        // HMM forward fold (posteriors seeded uniform; na observations carry
        // the transition prior forward — same as Pine's underflow branch)
        let off = (1 - settings.hmmStay) / 2
        let stay = settings.hmmStay
        var pBull = 1.0 / 3
        var pChop = 1.0 / 3
        var pBear = 1.0 / 3
        var hmmDominant = [Int](repeating: 0, count: n)
        var sHmm = [Double](repeating: 1.0 / 3, count: n)
        for i in 0..<n {
            let priBull = stay * pBull + off * pChop + off * pBear
            let priChop = off * pBull + stay * pChop + off * pBear
            let priBear = off * pBull + off * pChop + stay * pBear
            var unSum = 0.0
            var unBull = 0.0
            var unChop = 0.0
            var unBear = 0.0
            if let zr = zRet[i], let zv = zVol[i] {
                unBull = priBull * TwcMath.gaussPdf(zr, mu: muRet.bull, sigma: sdRet.bull)
                    * TwcMath.gaussPdf(zv, mu: muVol.bull, sigma: sdVol.bull)
                unChop = priChop * TwcMath.gaussPdf(zr, mu: muRet.chop, sigma: sdRet.chop)
                    * TwcMath.gaussPdf(zv, mu: muVol.chop, sigma: sdVol.chop)
                unBear = priBear * TwcMath.gaussPdf(zr, mu: muRet.bear, sigma: sdRet.bear)
                    * TwcMath.gaussPdf(zv, mu: muVol.bear, sigma: sdVol.bear)
                unSum = unBull + unChop + unBear
            }
            if unSum > 0 {
                pBull = unBull / unSum
                pChop = unChop / unSum
                pBear = unBear / unSum
            } else {
                pBull = priBull
                pChop = priChop
                pBear = priBear
            }
            hmmDominant[i] = pBull >= max(pChop, pBear) ? 1 : (pBear >= max(pBull, pChop) ? -1 : 0)
            sHmm[i] = pBull
        }

        // ── MODEL 2: VWAP z-score ──
        let vw = TwcMath.sessionVwap(candles, intervalSeconds: intervalSeconds)
        let dev: [Double?] = src.indices.map { i in vw[i].map { src[i] - $0 } }
        let vwapZ = TwcMath.zscore(dev, period: settings.vwapLook)

        // ── MODEL 3: linear regression slope sign ──
        let lrNow = TwcMath.linreg(src, period: settings.lenLR, offset: 0)
        let lrPrev = TwcMath.linreg(src, period: settings.lenLR, offset: 1)
        let lrSign: [Int] = src.indices.map { i in
            guard let a = lrNow[i], let b = lrPrev[i] else { return 0 }
            let slope = a - b
            return slope > 0 ? 1 : (slope < 0 ? -1 : 0)
        }

        // ── MODEL 4: Holt-Winters velocity ──
        var hwLevel: Double? = nil
        var hwTrend = 0.0
        var hwSign = [Int](repeating: 0, count: n)
        for i in 0..<n {
            let prevLevel = hwLevel ?? src[i]
            let level = settings.hwAlpha * src[i] + (1 - settings.hwAlpha) * (prevLevel + hwTrend)
            hwTrend = settings.hwBeta * (level - prevLevel) + (1 - settings.hwBeta) * hwTrend
            hwLevel = level
            hwSign[i] = hwTrend > 0 ? 1 : (hwTrend < 0 ? -1 : 0)
        }

        // ── MODEL 5: Center of Gravity turn sign ──
        let cog = TwcMath.cogSeries(src, period: settings.lenCoG)
        let cogSign: [Int] = cog.indices.map { i in
            let prev = i > 0 ? cog[i - 1] : 0
            return cog[i] > prev ? 1 : (cog[i] < prev ? -1 : 0)
        }

        // ── Forecast index + MSI composite ──
        let ema20 = IndicatorEngine.ema(src, period: 20)
        let ema50 = IndicatorEngine.ema(src, period: 50)
        var trendRun = 0
        var msi = [Double?](repeating: nil, count: n)
        for i in 0..<n {
            let voteSum = lrSign[i] + hwSign[i] + cogSign[i]
            let forecastIdx = voteSum > 0 ? 1 : (voteSum < 0 ? -1 : 0)
            let emaVel: Int
            if let e20 = ema20[i], let e50 = ema50[i] {
                emaVel = e20 > e50 ? 1 : (e20 < e50 ? -1 : 0)
            } else {
                emaVel = 0
            }
            let prevLr = i > 0 ? lrSign[i - 1] : 0
            trendRun = (lrSign[i] == prevLr && lrSign[i] != 0) ? trendRun + 1 : 0
            let runScore = Double(min(trendRun, 20)) / 20

            guard let vz = vwapZ[i] else { continue } // MSI na until warm-up
            let sFcst = Double(forecastIdx + 1) / 2
            let sVwap = max(0, min(1, 0.5 + vz / 4))
            let sEmav = Double(emaVel + 1) / 2
            let sRun = lrSign[i] > 0 ? 0.5 + 0.5 * runScore : (lrSign[i] < 0 ? 0.5 - 0.5 * runScore : 0.5)
            msi[i] = 100 * (0.3 * sHmm[i] + 0.3 * sFcst + 0.15 * sVwap + 0.15 * sEmav + 0.1 * sRun)
        }

        // ── SuperTrend stack ──
        let ctf = TwcMath.supertrend(candles, factor: settings.ctfMultiplier, atrPeriod: settings.ctfAtrLength)
        let resample = TwcMath.resampleHtf(candles, intervalSeconds: intervalSeconds)
        let htfAtrLen = settings.useCustomHTFAtrLength ? settings.htfAtrLength : 50
        let htf3 = TwcMath.supertrend(resample.htfCandles, factor: 3.0, atrPeriod: htfAtrLen)
        let htf4 = TwcMath.supertrend(resample.htfCandles, factor: 4.0, atrPeriod: htfAtrLen)
        let htf3Value = TwcMath.mapConfirmedHtf(htf3.value, chartToHtf: resample.chartToHtf)
        let htf3Dir = TwcMath.mapConfirmedHtf(htf3.direction, chartToHtf: resample.chartToHtf)
        let htf4Value = TwcMath.mapConfirmedHtf(htf4.value, chartToHtf: resample.chartToHtf)
        let htf4Dir = TwcMath.mapConfirmedHtf(htf4.direction, chartToHtf: resample.chartToHtf)

        // ── MACD alignment (compacted-signal EMA matches Pine's na-skipping) ──
        let macdValues = IndicatorEngine.macd(
            candles: candles,
            fastPeriod: settings.macdFast,
            slowPeriod: settings.macdSlow,
            signalPeriod: settings.macdSignal
        )

        // ── Bollinger (length fixed 20) ──
        let bb2 = IndicatorEngine.bollingerBands(candles: candles, period: 20, multiplier: 2)
        let bb3 = IndicatorEngine.bollingerBands(candles: candles, period: 20, multiplier: 3)

        // ── Per-bar signal derivation ──
        var markers: [TwcMarker] = []
        var candleColors: [String?]? = settings.colorBars ? [String?](repeating: nil, count: n) : nil
        var ctfDirOut = [Int](repeating: 0, count: n)
        var stackDirOut = [Int](repeating: 0, count: n)
        var crossUpOut = [Bool](repeating: false, count: n)
        var crossDnOut = [Bool](repeating: false, count: n)
        var lastStackBull = false
        var lastStackBear = false

        for i in 0..<n {
            let ctfDir = ctf.direction[i]
            let ctfBullish = ctfDir.map { $0 < 0 } ?? false
            let ctfBearish = ctfDir.map { $0 > 0 } ?? false
            // NOTE: the gate reads the HTF x3 direction regardless of the
            // showHTF3 display toggle (Pine behavior); warm-up blocks signals.
            let h3 = htf3Dir[i]
            let stackAgreeBull = ctfBullish && (h3.map { $0 < 0 } ?? false)
            let stackAgreeBear = ctfBearish && (h3.map { $0 > 0 } ?? false)
            if i == n - 1 {
                lastStackBull = stackAgreeBull
                lastStackBear = stackAgreeBear
            }
            ctfDirOut[i] = ctfBullish ? 1 : (ctfBearish ? -1 : 0)

            // All-ENABLED HTF stack agreement (display toggles included,
            // unlike the signal gate) — the confluence `stackDir` component.
            // Pine counts a toggled-on HTF toward enabledCount even while its
            // direction is warming up (na), which forces stackDir to 0 then.
            let h4 = htf4Dir[i]
            let included3 = settings.showHTF3
            let included4 = settings.showHTF4
            let enabledCount = (included3 ? 1 : 0) + (included4 ? 1 : 0)
            let bullCount = (included3 && (h3.map { $0 < 0 } ?? false) ? 1 : 0)
                + (included4 && (h4.map { $0 < 0 } ?? false) ? 1 : 0)
            let bearCount = (included3 && (h3.map { $0 > 0 } ?? false) ? 1 : 0)
                + (included4 && (h4.map { $0 > 0 } ?? false) ? 1 : 0)
            stackDirOut[i] = enabledCount > 0 && bullCount == enabledCount
                ? 1
                : (enabledCount > 0 && bearCount == enabledCount ? -1 : 0)

            // ST-gated heatmap triggers (independent of showMarkers; feed CL/CS)
            let rawUp = TwcMath.crossesOver(msi, at: i, threshold: settings.msiBullThr) && hmmDominant[i] == 1
            let rawDn = TwcMath.crossesUnder(msi, at: i, threshold: settings.msiBearThr) && hmmDominant[i] == -1
            crossUpOut[i] = rawUp && stackAgreeBull
            crossDnOut[i] = rawDn && stackAgreeBear

            // Regime candle color: saturation tracks |MSI - 50|
            if candleColors != nil {
                let hidden = settings.hideUnalignedCandles && !stackAgreeBull && !stackAgreeBear
                if let m = msi[i], !hidden {
                    let conv = max(0, min(1, abs(m - 50) / 50))
                    let transparency = (80 - conv * 70).rounded()
                    let base = hmmDominant[i] == 1
                        ? TwcColors.bull
                        : (hmmDominant[i] == -1 ? TwcColors.bear : TwcColors.chop)
                    candleColors?[i] = TwcColors.withOpacity(base, (100 - transparency) / 100)
                }
            }

            if settings.showMarkers {
                // Regime flip diamonds
                let prevDom = i > 0 ? hmmDominant[i - 1] : 0
                if hmmDominant[i] == 1 && prevDom != 1 {
                    markers.append(TwcMarker(barIndex: i, placement: .belowBar, shape: .diamond, color: TwcColors.bull, sizeTiny: true))
                }
                if hmmDominant[i] == -1 && prevDom != -1 {
                    markers.append(TwcMarker(barIndex: i, placement: .aboveBar, shape: .diamond, color: TwcColors.bear, sizeTiny: true))
                }

                // ST-gated heatmap LONG/SHORT triangles
                if crossUpOut[i] {
                    markers.append(TwcMarker(barIndex: i, placement: .belowBar, shape: .triangleUp, color: TwcColors.bull, sizeTiny: false))
                }
                if crossDnOut[i] {
                    markers.append(TwcMarker(barIndex: i, placement: .aboveBar, shape: .triangleDown, color: TwcColors.bear, sizeTiny: false))
                }
            }

            // VWAP rip: |z| first crossing the stretch threshold, split by
            // sign (the Pine alert-only trigger, surfaced as amber pills).
            // Pine's nz(vwapZ[1]) substitutes 0 for na, so the rip can fire
            // on the very first bar the z-score exists.
            let ripPrevAbs = i > 0 ? (vwapZ[i - 1].map { abs($0) } ?? 0) : 0
            if settings.showVwapRip, let z = vwapZ[i],
               abs(z) >= settings.vwapWarn, ripPrevAbs < settings.vwapWarn {
                if z > 0 {
                    markers.append(TwcMarker(barIndex: i, placement: .aboveBar, shape: .labelDown, color: TwcColors.vwapRip, sizeTiny: true, text: "RIP"))
                } else {
                    markers.append(TwcMarker(barIndex: i, placement: .belowBar, shape: .labelUp, color: TwcColors.vwapRip, sizeTiny: true, text: "RIP"))
                }
            }

            // MACD + SuperTrend alignment triangles (own toggle)
            if settings.showMacdAlign {
                if TwcMath.seriesCrossOver(macdValues.macdLine, macdValues.signalLine, at: i) && stackAgreeBull {
                    markers.append(TwcMarker(barIndex: i, placement: .belowBar, shape: .triangleUp, color: TwcColors.macdBull, sizeTiny: false))
                }
                if TwcMath.seriesCrossUnder(macdValues.macdLine, macdValues.signalLine, at: i) && stackAgreeBear {
                    markers.append(TwcMarker(barIndex: i, placement: .aboveBar, shape: .triangleDown, color: TwcColors.macdBear, sizeTiny: false))
                }
            }

            // CTF flip Buy/Sell pills
            if settings.showBuySellSignals && i > 0 {
                let prevDir = ctf.direction[i - 1]
                if ctfBullish, let pd = prevDir, pd > 0 {
                    markers.append(TwcMarker(barIndex: i, placement: .belowBar, shape: .labelUp, color: TwcColors.stBull, sizeTiny: true, text: "Buy"))
                }
                if ctfBearish, let pd = prevDir, pd < 0 {
                    markers.append(TwcMarker(barIndex: i, placement: .aboveBar, shape: .labelDown, color: TwcColors.stBear, sizeTiny: true, text: "Sell"))
                }
            }

            // Envelope rejection: confirmed on the CLOSED prior bar, drawn
            // one bar back (Pine offset = -1)
            if settings.showEnvelopeRejection && i >= 1 {
                let useThird = settings.rejectionEnvelope == "3 Std"
                let upperArr = useThird ? bb3.upper : bb2.upper
                let lowerArr = useThird ? bb3.lower : bb2.lower
                if let u1 = upperArr[i - 1],
                   candles[i - 1].high > u1, candles[i - 1].close < u1, closes[i] < closes[i - 1] {
                    markers.append(TwcMarker(barIndex: i - 1, placement: .aboveBar, shape: .triangleDown, color: TwcColors.stBear, sizeTiny: true))
                }
                if let l1 = lowerArr[i - 1],
                   candles[i - 1].low < l1, candles[i - 1].close > l1, closes[i] > closes[i - 1] {
                    markers.append(TwcMarker(barIndex: i - 1, placement: .belowBar, shape: .triangleUp, color: TwcColors.stBull, sizeTiny: true))
                }
            }
        }

        // ── Line + fill series ──
        var lines: [TwcLine] = []
        var fills: [TwcAreaFill] = []
        func splitByDir(_ values: [Double?], _ dirs: [Double?], wantBull: Bool) -> [Double?] {
            values.indices.map { i in
                guard let v = values[i], let d = dirs[i] else { return nil }
                return wantBull ? (d < 0 ? v : nil) : (d > 0 ? v : nil)
            }
        }

        if settings.showCTFLine {
            lines.append(TwcLine(id: "ctfBull", values: splitByDir(ctf.value, ctf.direction, wantBull: true), color: TwcColors.stBull, lineWidth: 2))
            lines.append(TwcLine(id: "ctfBear", values: splitByDir(ctf.value, ctf.direction, wantBull: false), color: TwcColors.stBear, lineWidth: 2))
        }
        if settings.showTransparentHighlight {
            let opacity = Double(100 - settings.highlightTransparency) / 100
            let hl2 = candles.map { ($0.high + $0.low) / 2 }
            fills.append(
                TwcAreaFill(
                    id: "ctfHighlight",
                    top: hl2,
                    bottom: ctf.value,
                    colors: ctf.direction.map { dir in
                        dir.map { TwcColors.withOpacity($0 < 0 ? "#00D68F" : "#FF5252", opacity) }
                    }
                )
            )
        }
        if settings.showHTF3 {
            lines.append(TwcLine(id: "htf3Bull", values: splitByDir(htf3Value, htf3Dir, wantBull: true), color: TwcColors.stBull, lineWidth: 2))
            lines.append(TwcLine(id: "htf3Bear", values: splitByDir(htf3Value, htf3Dir, wantBull: false), color: TwcColors.stBear, lineWidth: 2))
        }
        if settings.showHTF4 {
            lines.append(TwcLine(id: "htf4Bull", values: splitByDir(htf4Value, htf4Dir, wantBull: true), color: TwcColors.stBull, lineWidth: 2))
            lines.append(TwcLine(id: "htf4Bear", values: splitByDir(htf4Value, htf4Dir, wantBull: false), color: TwcColors.stBear, lineWidth: 2))
        }
        if settings.showBB2 || settings.showBB3 {
            lines.append(TwcLine(id: "bbBasis", values: bb2.middle, color: TwcColors.bbBasis, lineWidth: 1))
        }
        if settings.showBB2 {
            lines.append(TwcLine(id: "bbUpper2", values: bb2.upper, color: TwcColors.bbSigma2, lineWidth: 1))
            lines.append(TwcLine(id: "bbLower2", values: bb2.lower, color: TwcColors.bbSigma2, lineWidth: 1))
            fills.append(TwcAreaFill(id: "bb2Fill", top: bb2.upper, bottom: bb2.lower, colors: bb2.upper.map { $0 == nil ? nil : TwcColors.bbSigma2Fill }))
        }
        if settings.showBB3 {
            lines.append(TwcLine(id: "bbUpper3", values: bb3.upper, color: TwcColors.bbSigma3, lineWidth: 1))
            lines.append(TwcLine(id: "bbLower3", values: bb3.lower, color: TwcColors.bbSigma3, lineWidth: 1))
            fills.append(TwcAreaFill(id: "bb3Fill", top: bb3.upper, bottom: bb3.lower, colors: bb3.upper.map { $0 == nil ? nil : TwcColors.bbSigma3Fill }))
        }

        // ── Bias banner (last bar stack agreement) ──
        let banner: TwcBanner? = settings.showBiasBanner
            ? TwcBanner(
                text: lastStackBull ? settings.biasLongText : (lastStackBear ? settings.biasShortText : settings.biasChopText),
                color: lastStackBull ? TwcColors.bannerLong : (lastStackBear ? TwcColors.bannerShort : TwcColors.bannerChop),
                position: settings.biasBannerPosition,
                size: settings.biasBannerSize
            )
            : nil

        return Result(
            candleColors: candleColors,
            markers: markers,
            lines: lines,
            fills: fills,
            banner: banner,
            atr14: atr14,
            msi: msi,
            ctfDir: ctfDirOut,
            stackDir: stackDirOut,
            crossUp: crossUpOut,
            crossDn: crossDnOut
        )
    }
}
