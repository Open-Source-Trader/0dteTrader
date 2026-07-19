import SwiftUI

/// Dedicated TradingView-style settings screen for the TWC Heatmap V5 script
/// indicator: every phase-1 input from the Pine script, grouped like its
/// input groups (TwcSettingsView.tsx analog). Changes apply and persist
/// immediately through the bound view-model settings.
struct TwcSettingsView: View {
    @Binding var settings: TwcHeatmapSettings

    var body: some View {
        Form {
            Section("Core Models") {
                picker("Source", $settings.source, TwcHeatmapSettings.sourceOptions)
                Stepper("LinReg Length: \(settings.lenLR)", value: $settings.lenLR, in: 3...200)
                    .monospacedDigit()
                Stepper("HW Alpha: \(format2(settings.hwAlpha))", value: $settings.hwAlpha, in: 0.01...1, step: 0.01)
                    .monospacedDigit()
                Stepper("HW Beta: \(format2(settings.hwBeta))", value: $settings.hwBeta, in: 0.01...1, step: 0.01)
                    .monospacedDigit()
                Stepper("CoG Length: \(settings.lenCoG)", value: $settings.lenCoG, in: 3...100)
                    .monospacedDigit()
            }

            Section("Hidden Markov Model") {
                Stepper("Lookback: \(settings.hmmLook)", value: $settings.hmmLook, in: 10...200)
                    .monospacedDigit()
                Stepper("Self-Persistence: \(format2(settings.hmmStay))", value: $settings.hmmStay, in: 0.5...0.99, step: 0.01)
                    .monospacedDigit()
            }

            Section("VWAP Z-Score") {
                Stepper("Lookback: \(settings.vwapLook)", value: $settings.vwapLook, in: 5...200)
                    .monospacedDigit()
                Stepper("Stretch Threshold: \(format1(settings.vwapWarn))", value: $settings.vwapWarn, in: 0.5...4, step: 0.1)
                    .monospacedDigit()
                Toggle("VWAP Rip Markers", isOn: $settings.showVwapRip)
            }

            Section("MSI / Signal Logic") {
                Stepper("Bullish Threshold: \(Int(settings.msiBullThr))%", value: $settings.msiBullThr, in: 50...99, step: 1)
                    .monospacedDigit()
                Stepper("Bearish Threshold: \(Int(settings.msiBearThr))%", value: $settings.msiBearThr, in: 1...50, step: 1)
                    .monospacedDigit()
            }

            Section("Visuals") {
                Toggle("Regime Candles", isOn: $settings.colorBars)
                Toggle("Show Signal Markers", isOn: $settings.showMarkers)
                Toggle("Hide Regime Candles when not aligned", isOn: $settings.hideUnalignedCandles)
            }

            Section("Fibonacci Levels") {
                Toggle("Show Fibonacci Levels", isOn: $settings.showFibonacci)
                if settings.showFibonacci {
                    Stepper("Zigzag Period: \(settings.fibPeriod)", value: $settings.fibPeriod, in: 5...50)
                        .monospacedDigit()
                    picker("Detection Method", $settings.fibMethod, TwcHeatmapSettings.fibMethodOptions)
                    picker("Label Position", $settings.fibLabelPosition, TwcHeatmapSettings.labelPositionOptions)
                    Toggle("Ratio Labels", isOn: $settings.showFibRatioLabels)
                    Toggle("Price Labels", isOn: $settings.showFibPriceLabels)
                    picker("Pivot Price Source", $settings.fibPivotSource, TwcHeatmapSettings.pivotSourceOptions)
                    Toggle("Standard Fibonacci Ratios", isOn: $settings.useStandardRatios)
                }
            }

            Section("Fib Flip / Reject") {
                Toggle("Instant flip on threshold break", isOn: $settings.flipEnable)
                if settings.flipEnable {
                    picker("Trigger uses", $settings.flipTrigger, TwcHeatmapSettings.flipTriggerOptions)
                    picker("Level", $settings.flipLevel, TwcHeatmapSettings.flipLevelOptions)
                }
            }

            Section("Profit Target Zones") {
                Toggle("Shade target bands", isOn: $settings.shadeBands)
                Toggle("Profit target labels", isOn: $settings.showPTLabels)
                Toggle("Extensions only (≥1.000)", isOn: $settings.ptExtensionsOnly)
                LabeledContent("Label prefix") {
                    TextField("Prefix", text: $settings.ptPrefix)
                        .multilineTextAlignment(.trailing)
                }
                Toggle("Always show first target zone", isOn: $settings.ptAlwaysShowFirst)
            }

            Section("Gann Square") {
                Toggle("Show Gann Square", isOn: $settings.showGannFan)
                Toggle("Show Gann Box Frame", isOn: $settings.showGannBox)
                if settings.showGannFan {
                    picker("Scale Method", $settings.gannScaleMethod, TwcHeatmapSettings.gannScaleOptions)
                    if settings.gannScaleMethod == "Manual" {
                        Stepper("Units per Bar: \(format1(settings.gannManualScale))", value: $settings.gannManualScale, in: 0.1...100, step: 0.1)
                            .monospacedDigit()
                    }
                    if settings.gannScaleMethod == "Auto (ATR-based)" {
                        Stepper("ATR Multiplier: \(format2(settings.gannATRMultiplier))", value: $settings.gannATRMultiplier, in: 0.01...1, step: 0.01)
                            .monospacedDigit()
                    }
                    Toggle("1x1 (45°)", isOn: $settings.gann1x1)
                    Toggle("2x1 (63.4°)", isOn: $settings.gann2x1)
                    Toggle("1x2 (26.6°)", isOn: $settings.gann1x2)
                    Toggle("3x1 (71.6°)", isOn: $settings.gann3x1)
                    Toggle("1x3 (18.4°)", isOn: $settings.gann1x3)
                    Toggle("4x1 (76°)", isOn: $settings.gann4x1)
                    Toggle("1x4 (14°)", isOn: $settings.gann1x4)
                    Toggle("8x1 (82.9°)", isOn: $settings.gann8x1)
                    Toggle("1x8 (7.1°)", isOn: $settings.gann1x8)
                }
            }

            Section("CTF SuperTrend") {
                Stepper("ATR Length: \(settings.ctfAtrLength)", value: $settings.ctfAtrLength, in: 1...50)
                    .monospacedDigit()
                Stepper("Multiplier: \(format1(settings.ctfMultiplier))", value: $settings.ctfMultiplier, in: 0.1...10, step: 0.1)
                    .monospacedDigit()
                Toggle("Show CTF Line", isOn: $settings.showCTFLine)
                Toggle("Show CTF Buy/Sell Labels", isOn: $settings.showBuySellSignals)
            }

            Section("Highlight") {
                Toggle("Transparent Highlight", isOn: $settings.showTransparentHighlight)
                if settings.showTransparentHighlight {
                    Stepper("Transparency: \(settings.highlightTransparency)", value: $settings.highlightTransparency, in: 0...100)
                        .monospacedDigit()
                }
            }

            Section("HTF Stack (6x timeframe)") {
                Toggle("Show HTF x3", isOn: $settings.showHTF3)
                Toggle("Show HTF x4", isOn: $settings.showHTF4)
                Toggle("Custom HTF ATR Length", isOn: $settings.useCustomHTFAtrLength)
                if settings.useCustomHTFAtrLength {
                    Stepper("HTF ATR Length: \(settings.htfAtrLength)", value: $settings.htfAtrLength, in: 1...50)
                        .monospacedDigit()
                }
            }

            Section("Bollinger Bands") {
                Toggle("Show 2 Std Bands", isOn: $settings.showBB2)
                Toggle("Show 3 Std Bands", isOn: $settings.showBB3)
                Toggle("Envelope Rejection Triangles", isOn: $settings.showEnvelopeRejection)
                if settings.showEnvelopeRejection {
                    picker("Rejection Envelope", $settings.rejectionEnvelope, TwcHeatmapSettings.envelopeOptions)
                }
            }

            Section("SuperTrend Gate / MACD Alignment") {
                Toggle("MACD + SuperTrend Signals", isOn: $settings.showMacdAlign)
                if settings.showMacdAlign {
                    Stepper("MACD Fast: \(settings.macdFast)", value: $settings.macdFast, in: 1...50)
                        .monospacedDigit()
                    Stepper("MACD Slow: \(settings.macdSlow)", value: $settings.macdSlow, in: 1...200)
                        .monospacedDigit()
                    Stepper("MACD Signal: \(settings.macdSignal)", value: $settings.macdSignal, in: 1...50)
                        .monospacedDigit()
                }
            }

            Section("Order Blocks") {
                Toggle("Swing Order Blocks", isOn: $settings.showSwingOrderBlocks)
                if settings.showSwingOrderBlocks {
                    Stepper("Swing Blocks Shown: \(settings.swingOrderBlocksSize)", value: $settings.swingOrderBlocksSize, in: 1...20)
                        .monospacedDigit()
                }
                Toggle("Internal Order Blocks", isOn: $settings.showInternalOrderBlocks)
                if settings.showInternalOrderBlocks {
                    Stepper("Internal Blocks Shown: \(settings.internalOrderBlocksSize)", value: $settings.internalOrderBlocksSize, in: 1...20)
                        .monospacedDigit()
                }
                picker("Filter", $settings.orderBlockFilter, TwcHeatmapSettings.orderBlockFilterOptions)
                picker("Mitigation", $settings.orderBlockMitigation, TwcHeatmapSettings.orderBlockMitigationOptions)
                Stepper("Swing Length: \(settings.swingsLength)", value: $settings.swingsLength, in: 10...100)
                    .monospacedDigit()
            }

            Section("Premium & Discount Zones") {
                Toggle("Show Zones", isOn: $settings.showPremiumDiscountZones)
            }

            Section("Unified Confluence Engine") {
                Toggle("Show Confluence Markers (CL/CS)", isOn: $settings.showConfMarkers)
                Toggle("Gate signals by score", isOn: $settings.useConfluenceGate)
                Stepper("Bullish Score Threshold: \(Int(settings.confBullThr))", value: $settings.confBullThr, in: 50...100, step: 1)
                    .monospacedDigit()
                Stepper("Bearish Score Threshold: \(Int(settings.confBearThr))", value: $settings.confBearThr, in: 0...50, step: 1)
                    .monospacedDigit()
                picker("Timeframe 1", $settings.mtfTf1, TwcHeatmapSettings.mtfTimeframeOptions)
                picker("Timeframe 2", $settings.mtfTf2, TwcHeatmapSettings.mtfTimeframeOptions)
                picker("Timeframe 3", $settings.mtfTf3, TwcHeatmapSettings.mtfTimeframeOptions)
                picker("Timeframe 4", $settings.mtfTf4, TwcHeatmapSettings.mtfTimeframeOptions)
                picker("Timeframe 5", $settings.mtfTf5, TwcHeatmapSettings.mtfTimeframeOptions)
                picker("Timeframe 6", $settings.mtfTf6, TwcHeatmapSettings.mtfTimeframeOptions)
            }

            Section("Bias Banner") {
                Toggle("Show Bias Banner", isOn: $settings.showBiasBanner)
                if settings.showBiasBanner {
                    picker("Position", $settings.biasBannerPosition, TwcHeatmapSettings.bannerPositionOptions)
                    picker("Text Size", $settings.biasBannerSize, TwcHeatmapSettings.bannerSizeOptions)
                    LabeledContent("Long Text") {
                        TextField("Long", text: $settings.biasLongText)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Short Text") {
                        TextField("Short", text: $settings.biasShortText)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Chop Text") {
                        TextField("Chop", text: $settings.biasChopText)
                            .multilineTextAlignment(.trailing)
                    }
                }
            }

            Section {
                Button("Reset to Defaults", role: .destructive) {
                    var defaults = TwcHeatmapSettings.default
                    defaults.enabled = settings.enabled
                    settings = defaults
                }
            }
        }
        .navigationTitle("TWC Heatmap V5")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(Color.appBackground)
        .tint(.appAccent)
    }

    private func picker(_ title: String, _ binding: Binding<String>, _ options: [String]) -> some View {
        Picker(title, selection: binding) {
            ForEach(options, id: \.self) { Text($0).tag($0) }
        }
        .pickerStyle(.menu)
    }

    private func format1(_ value: Double) -> String { String(format: "%.1f", value) }
    private func format2(_ value: Double) -> String { String(format: "%.2f", value) }
}
