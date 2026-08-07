import Foundation
import DGCharts
import XCTest
@testable import ZeroDTETrader

final class IndicatorPresentationTests: XCTestCase {
    func testControlCatalogEnumeratesRegistryOrderAndSeparatesVolumeAndL2Availability() throws {
        let registry = try IndicatorRegistry.bundled()
        let catalog = IndicatorControlCatalog(registry: registry)

        XCTAssertEqual(catalog.overlays.map(\.id), registry.indicators.filter { $0.pane == .overlay }.map(\.id))
        XCTAssertEqual(catalog.subPanes.map(\.id), registry.indicators.filter { $0.pane == .subpane }.map(\.id))
        XCTAssertFalse(catalog.overlays.contains { $0.id == "volume" })
        XCTAssertTrue(catalog.subPanes.filter(\.requiresL2).allSatisfy { $0.availability == .noL2Data })

        let liveCatalog = IndicatorControlCatalog(registry: registry, hasL2Data: true)
        XCTAssertTrue(liveCatalog.subPanes.filter(\.requiresL2).allSatisfy { $0.availability == .available })
    }

    func testPanePresentationUsesDescriptorRenderKindsAndOscillatorGuides() throws {
        let registry = try IndicatorRegistry.bundled()
        var settings = try IndicatorSettingsState.defaults(for: registry)
        settings.indicators["macd"]?.enabled = true
        settings.indicators["rsi"]?.enabled = true
        var candles: [Candle] = []
        for index in 0..<40 {
            let close = Double(index + 1)
            candles.append(Candle(
                time: Date(timeIntervalSince1970: Double(index * 60)),
                open: close,
                high: close + 1,
                low: close - 1,
                close: close,
                volume: 100
            ))
        }
        let model = try IndicatorRenderModel.make(registry: registry, settings: settings, candles: candles)
        let rsi = try IndicatorPanePresentation(item: XCTUnwrap(model.subPanes.first { $0.indicatorId == "rsi" }))
        let macd = try IndicatorPanePresentation(item: XCTUnwrap(model.subPanes.first { $0.indicatorId == "macd" }))

        XCTAssertEqual(rsi.guideLines, [30, 70])
        XCTAssertEqual(rsi.yRange, 0...100)
        let rsiKinds: [IndicatorSeriesPresentation.Kind] = rsi.series.map(\.kind)
        let macdKinds: [IndicatorSeriesPresentation.Kind] = macd.series.map(\.kind)
        XCTAssertEqual(rsiKinds, [.line])
        XCTAssertEqual(macdKinds, [.line, .line, .histogram])
        XCTAssertNil(macd.yRange)
    }

    func testLiveRendererPlansEveryGeometryKindIncludingBandCloudAndHistogram() throws {
        let registry = try IndicatorRegistry.bundled()
        var renderedKinds = Set<IndicatorGeometryKind>()

        for kind in IndicatorGeometryKind.allCases {
            let descriptor = try XCTUnwrap(registry.indicators.first { $0.geometry.kind == kind })
            let values = Dictionary(uniqueKeysWithValues: descriptor.geometry.series.map { ($0.id, [1.0, nil, 2.0]) })
            let geometry = IndicatorGeometry(
                indicatorId: descriptor.id,
                kind: kind,
                series: kind == .priceProfile ? [:] : values,
                rows: kind == .priceProfile
                    ? [.init(low: 1, high: 2, volume: 3, inValueArea: true)]
                    : [],
                unavailableReason: descriptor.requiresL2 ? "No L2 data" : nil
            )
            let plan = try IndicatorLiveRenderer.plan(item: .init(
                indicatorId: descriptor.id,
                descriptor: descriptor,
                geometry: geometry
            ))
            renderedKinds.insert(plan.kind)

            if kind == .histogram {
                XCTAssertTrue(plan.series.allSatisfy { $0.kind == .histogram })
            }
            if kind == .priceProfile {
                XCTAssertEqual(plan.profileRows, geometry.rows)
            }
        }

        XCTAssertEqual(renderedKinds, Set(IndicatorGeometryKind.allCases))
    }

    func testBandAndCloudPlansProduceFillPairsAndContiguousFillRuns() throws {
        let registry = try IndicatorRegistry.bundled()
        let band = try rendererPlan(id: "bollinger", registry: registry)
        let cloud = try rendererPlan(id: "ichimoku", registry: registry)

        XCTAssertEqual(band.fills.map { [$0.upperSeriesId, $0.lowerSeriesId] }, [["upper", "lower"]])
        XCTAssertEqual(cloud.fills.map { [$0.upperSeriesId, $0.lowerSeriesId] }, [["spanA", "spanB"]])
        let runs = IndicatorFillGeometry.contiguousRuns(
            upper: [1, 2, nil, 3, 4],
            lower: [0, 1, nil, 2, 3]
        )
        XCTAssertEqual(runs.map(\.indices), [[0, 1], [3, 4]])
    }

    func testPersistedSpreadSettingReachesVisibleUnavailableMultiLinePane() throws {
        let suiteName = "IndicatorPresentationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.removePersistentDomain(forName: suiteName)
        let registry = try IndicatorRegistry.bundled()
        let store = SettingsStore(defaults: defaults)
        var settings = try store.loadIndicatorSettings(registry: registry)
        settings.indicators["spread"]?.enabled = true
        try store.updateIndicatorSettings(settings, registry: registry)

        let persisted = try store.loadIndicatorSettings(registry: registry)
        let model = try IndicatorRenderModel.make(registry: registry, settings: persisted, candles: [])
        let presentations = try model.subPanes.map(IndicatorPanePresentation.init)
        let spread = try XCTUnwrap(presentations.first { $0.id == "spread" })

        XCTAssertEqual(model.subPanes.first { $0.indicatorId == "spread" }?.geometry.kind, .multiLine)
        XCTAssertEqual(spread.unavailableReason, "No L2 data")
        XCTAssertEqual(spread.series.count, 3)
        XCTAssertTrue(spread.series.allSatisfy { $0.kind == .line && $0.values.isEmpty })
    }

    @MainActor
    func testLiveChartDrawsBandAndCloudFillPixelsBelowPriceMarks() throws {
        let registry = try IndicatorRegistry.bundled()
        let plans = try [
            rendererPlan(id: "bollinger", registry: registry),
            rendererPlan(id: "ichimoku", registry: registry),
        ]
        let container = CandleChartRepresentable.ContainerView(frame: .init(x: 0, y: 0, width: 320, height: 240))
        container.indicatorFillOverlay.plans = plans

        XCTAssertTrue(container.indicatorFillOverlay.chart === container.chart)
        XCTAssertEqual(container.indicatorFillOverlay.plans.flatMap(\.fills).count, 2)
        XCTAssertLessThan(
            try XCTUnwrap(container.subviews.firstIndex(of: container.indicatorFillOverlay)),
            try XCTUnwrap(container.subviews.firstIndex(of: container.chart))
        )

        container.layoutIfNeeded()
        container.chart.leftAxis.axisMinimum = 0
        container.chart.leftAxis.axisMaximum = 4
        container.chart.xAxis.axisMinimum = 0
        container.chart.xAxis.axisMaximum = 2
        container.chart.data = CombinedChartData()
        container.chart.notifyDataSetChanged()
        let image = UIGraphicsImageRenderer(bounds: container.indicatorFillOverlay.bounds).image { context in
            container.indicatorFillOverlay.layer.render(in: context.cgContext)
        }

        XCTAssertTrue(imageHasVisiblePixel(image), "The fill renderer produced no visible pixels.")
    }

    func testUnavailableL2ToggleCanOnlyChangeFromEnabledToDisabled() {
        XCTAssertTrue(IndicatorTogglePolicy.canChange(availability: .noL2Data, isEnabled: true))
        XCTAssertFalse(IndicatorTogglePolicy.canChange(availability: .noL2Data, isEnabled: false))
        XCTAssertTrue(IndicatorTogglePolicy.canChange(availability: .available, isEnabled: false))
    }

    @MainActor
    func testRenderSnapshotCachesPerRevisionAndPreservesLastValidRenderOnFailure() async throws {
        let viewModel = makeChartViewModel()
        let initialCount = viewModel.indicatorRenderComputationCount
        _ = viewModel.indicatorRenderModel
        _ = viewModel.priceOverlays
        _ = viewModel.overlayRenderPlans
        _ = viewModel.priceProfileRows
        _ = viewModel.subPanePresentations
        XCTAssertEqual(viewModel.indicatorRenderComputationCount, initialCount)

        IndicatorCandlesURLProtocol.responses = [Data(Self.validCandlesJSON.utf8)]
        await viewModel.loadCandles()
        let validSnapshot = viewModel.indicatorRenderSnapshot
        XCTAssertEqual(viewModel.indicatorRenderComputationCount, initialCount + 1)
        XCTAssertNil(viewModel.indicatorErrorMessage)

        IndicatorCandlesURLProtocol.responses = [Data(Self.invalidCandlesJSON.utf8)]
        await viewModel.loadCandles()

        XCTAssertEqual(viewModel.indicatorRenderComputationCount, initialCount + 2)
        XCTAssertEqual(viewModel.indicatorRenderSnapshot, validSnapshot)
        XCTAssertNotNil(viewModel.indicatorErrorMessage)
        viewModel.setVolumeEnabled(false)
        XCTAssertNotNil(viewModel.indicatorErrorMessage)
        _ = viewModel.indicatorRenderModel
        _ = viewModel.overlayRenderPlans
        XCTAssertEqual(viewModel.indicatorRenderComputationCount, initialCount + 2)
    }

    @MainActor
    func testIndicatorMutationRejectsNonfiniteGeometryBeforeMemoryOrPersistenceChanges() async throws {
        let suite = "IndicatorPresentationTests.Mutation.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = SettingsStore(defaults: defaults)
        let viewModel = makeChartViewModel(settingsStore: store)

        IndicatorCandlesURLProtocol.responses = [Data(Self.validCandlesJSON.utf8)]
        await viewModel.loadCandles()
        let validSettings = viewModel.indicatorSettings
        let validSnapshot = viewModel.indicatorRenderSnapshot
        let validPersistedData = defaults.data(forKey: "settings.indicatorSettings.v1")

        IndicatorCandlesURLProtocol.responses = [Data(Self.nonfiniteGeometryCandlesJSON.utf8)]
        await viewModel.loadCandles()
        XCTAssertNotNil(viewModel.indicatorErrorMessage)

        viewModel.setIndicatorEnabled(id: "sma", enabled: true)

        XCTAssertEqual(viewModel.indicatorSettings, validSettings)
        XCTAssertEqual(viewModel.indicatorRenderSnapshot, validSnapshot)
        XCTAssertEqual(defaults.data(forKey: "settings.indicatorSettings.v1"), validPersistedData)
        XCTAssertEqual(try store.loadIndicatorSettings(registry: viewModel.indicatorRegistry), validSettings)
        XCTAssertNotNil(viewModel.indicatorErrorMessage)
    }

    @MainActor
    func testCorruptSettingsLoadErrorSurvivesInitialDefaultRender() throws {
        let suite = "IndicatorPresentationTests.CorruptSettings.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("not-json".utf8), forKey: "settings.indicatorSettings.v1")

        let viewModel = makeChartViewModel(settingsStore: SettingsStore(defaults: defaults))

        XCTAssertEqual(viewModel.indicatorSettings, viewModel.defaultIndicatorSettings)
        XCTAssertNotNil(viewModel.indicatorErrorMessage)
    }

    func testTypedRenderSnapshotRejectsDescriptorOutputMismatch() throws {
        let registry = try IndicatorRegistry.bundled()
        let descriptor = try XCTUnwrap(registry.descriptor(id: "bollinger"))
        let malformed = IndicatorRenderModel(overlays: [IndicatorRenderItem(
            indicatorId: descriptor.id,
            descriptor: descriptor,
            geometry: IndicatorGeometry(
                indicatorId: descriptor.id,
                kind: .line,
                series: [:],
                rows: [],
                unavailableReason: nil
            )
        )], subPanes: [])

        XCTAssertThrowsError(try IndicatorRenderSnapshot.make(renderModel: malformed))
    }

    private func rendererPlan(id: String, registry: IndicatorRegistry) throws -> IndicatorLiveRenderPlan {
        let descriptor = try XCTUnwrap(registry.descriptor(id: id))
        let seriesCount = descriptor.geometry.series.count
        let series = Dictionary(uniqueKeysWithValues: descriptor.geometry.series.enumerated().map { index, descriptor in
            let offset = Double(seriesCount - index)
            return (descriptor.id, [1 + offset, 2 + offset, 3 + offset] as [Double?])
        })
        return try IndicatorLiveRenderer.plan(item: .init(
            indicatorId: id,
            descriptor: descriptor,
            geometry: .init(
                indicatorId: id,
                kind: descriptor.geometry.kind,
                series: series,
                rows: [],
                unavailableReason: nil
            )
        ))
    }

    @MainActor
    private func makeChartViewModel(settingsStore: SettingsStore? = nil) -> ChartViewModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [IndicatorCandlesURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let baseURL = URL(string: "https://indicator-render.test")!
        let suite = "IndicatorPresentationTests.ChartViewModel.\(UUID().uuidString)"
        let sessionStore = SessionStore(
            keychainStore: KeychainStore(service: suite),
            baseURL: baseURL,
            urlSession: session
        )
        return ChartViewModel(
            apiClient: APIClient(baseURL: baseURL, sessionStore: sessionStore, urlSession: session),
            socket: QuoteSocketClient(streamURL: URL(string: "wss://indicator-render.test")!) { "token" },
            settingsStore: settingsStore ?? SettingsStore(defaults: UserDefaults(suiteName: suite)!)
        )
    }

    private func imageHasVisiblePixel(_ image: UIImage) -> Bool {
        guard let image = image.cgImage,
              let data = image.dataProvider?.data,
              let bytes = CFDataGetBytePtr(data)
        else { return false }
        let alphaIndex = image.bitmapInfo.contains(.byteOrder32Little) ? 3 : 0
        for offset in stride(from: alphaIndex, to: CFDataGetLength(data), by: 4) where bytes[offset] > 0 {
            return true
        }
        return false
    }

    private static let validCandlesJSON = """
    [
      {"time":"2026-08-05T14:30:00Z","open":100,"high":102,"low":99,"close":101,"volume":100},
      {"time":"2026-08-05T14:31:00Z","open":101,"high":103,"low":100,"close":102,"volume":200}
    ]
    """

    private static let invalidCandlesJSON = """
    [
      {"time":"2026-08-05T14:30:00Z","open":100,"high":102,"low":99,"close":101,"volume":100},
      {"time":"2026-08-05T14:31:00Z","open":104,"high":103,"low":100,"close":102,"volume":200}
    ]
    """

    private static let nonfiniteGeometryCandlesJSON = """
    [
      {"time":"2026-08-05T14:30:00Z","open":1e308,"high":1.1e308,"low":9e307,"close":1e308,"volume":100},
      {"time":"2026-08-05T14:31:00Z","open":1e308,"high":1.1e308,"low":9e307,"close":1e308,"volume":200}
    ]
    """
}

private class IndicatorCandlesURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var responses: [Data] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let client, !Self.responses.isEmpty else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let data = Self.responses.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: data)
        client.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
