import Foundation

struct UsrAnalysisCandle: Sendable {
    let time: Date
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volume: Double
    let chartStart: Int
    let chartEnd: Int
    let eventChartIndex: Int
    let eventTime: Date
    let closeTime: Date
    let regularSession: Bool
    var atr: Double?
    var volumeMean: Double?
    var volumeStd: Double?
}

enum UsrZoneState: String, Sendable { case fresh, tested, mitigated }

struct UsrZone: Identifiable, Sendable {
    let id: Int
    let sourceId: Int
    let analysisBirth: Int
    let top: Double
    let bottom: Double
    let startBar: Int
    let sourceTime: Date
    let detectedTime: Date
    let activeTime: Date
    var invalidatedTime: Date? = nil
    let activationBar: Int
    var endBar = 0
    let isSupport: Bool
    var isActive = true
    let volumeRatio: Double
    var state = UsrZoneState.fresh
    var touchCount = 0
    var maxPenetration = 0.0
    let isFlipped: Bool
    let isLine: Bool
    var lastTouchAnalysisBar: Int?
    var wasInsideLastBar = false
    let originStartBar: Int
    let originZoneId: Int
    let originIsSupport: Bool
    var hasActiveFlippedChild = false
    var inPool = false
    var poolId = ""
    var bounceSignalCount = 0
    var sweepSignalCount = 0
    var lastBounceSignalBar = 0
    var lastSweepSignalBar = 0
}

struct UsrConfluence: Sendable {
    let top: Double
    let bottom: Double
    let startBar: Int
    let isMixed: Bool
    let memberIds: [Int]
    let strength: Double
}

enum UsrPoolState: String, Sendable { case anticipated, validated, swept }

struct UsrPool: Identifiable, Sendable {
    let id: String
    var top: Double
    var bottom: Double
    var strength: Double
    let startBar: Int
    let isSupport: Bool
    var state: UsrPoolState
    var memberIds: [Int]
    let analysisBirth: Int
    var bounceSignalCount = 0
    var sweepSignalCount = 0
    var lastBounceSignalAnalysisBar = 0
    var lastSweepSignalAnalysisBar = 0
}

enum UsrFvgDirection: String, Sendable { case bullish, bearish }
enum UsrFvgLifecycle: String, Sendable {
    case untouched, partial, ce, wickFilled, inverted, invalidated, expired
}

struct UsrFvg: Identifiable, Sendable {
    let id: String
    let top: Double
    let bottom: Double
    let ce: Double
    let startBar: Int
    let analysisBirth: Int
    var ifvgAnalysisBirth = 0
    var endBar = 0
    var ifvgEndBar = 0
    let direction: UsrFvgDirection
    var visualVisible = true
    var isActive = true
    var lifecycle = UsrFvgLifecycle.untouched
    var milestoneReached = false
    var ifvgActive = false
    var bounceSignalCount = 0
    var sweepSignalCount = 0
    var lastBounceSignalAnalysisBar = 0
    var lastSweepSignalAnalysisBar = 0
}

enum UsrSignalKind: String, Sendable { case bounce, sweep }
enum UsrSignalSource: String, Sendable { case zone, pool, fvg, ifvg }

struct UsrSignal: Sendable {
    let bullish: Bool
    let kind: UsrSignalKind
    let source: UsrSignalSource
    let chartBarIndex: Int
    let analysisBarId: Int
    let price: Double
    let stop: Double
    let score: Double
    let sourceKey: String
}

struct UsrComputation: Sendable {
    let renderModel: ScriptRenderModel
    let supportZones: [UsrZone]
    let resistanceZones: [UsrZone]
    let supportConfluence: [UsrConfluence]
    let resistanceConfluence: [UsrConfluence]
    let mixedConfluence: [UsrConfluence]
    let supportPools: [UsrPool]
    let resistancePools: [UsrPool]
    let bullishFvgs: [UsrFvg]
    let bearishFvgs: [UsrFvg]
    let signals: [UsrSignal]
    let warnings: [String]
}
