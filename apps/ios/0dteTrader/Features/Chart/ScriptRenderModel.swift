import Foundation

// Renderer-neutral geometry shared by stateful chart scripts. Coordinates are
// candle indices and prices; projected indices may extend beyond the last bar.
enum ScriptMarkerShape: String, Equatable, Sendable {
    case diamond, triangleUp, triangleDown, labelUp, labelDown
}

enum ScriptMarkerPlacement: String, Equatable, Sendable {
    case aboveBar, belowBar
}

struct ScriptMarker: Equatable, Sendable {
    let barIndex: Int
    let placement: ScriptMarkerPlacement
    let shape: ScriptMarkerShape
    let color: String
    let sizeTiny: Bool
    var text: String? = nil
    var textColor: String? = nil
}

struct ScriptLine: Equatable, Sendable {
    let id: String
    let values: [Double?]
    let color: String
    let lineWidth: Double
}

struct ScriptAreaFill: Equatable, Sendable {
    let id: String
    let top: [Double?]
    let bottom: [Double?]
    let colors: [String?]
}

enum ScriptSegmentStyle: String, Equatable, Sendable {
    case solid, dashed, dotted
}

struct ScriptSegment: Equatable, Sendable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let color: String
    let width: Double
    let style: ScriptSegmentStyle
}

struct ScriptBand: Equatable, Sendable {
    let x1: Double
    let x2: Double
    let yTop: Double
    let yBottom: Double
    let fillColor: String
    var borderColor: String? = nil
    var borderWidth: Double = 1
    var borderStyle: ScriptSegmentStyle = .solid
}

enum ScriptLabelAlign: String, Equatable, Sendable {
    case left, center, right
}

struct ScriptLabel: Equatable, Sendable {
    let barIndex: Double
    let price: Double
    let text: String
    let textColor: String
    var bgColor: String? = nil
    let align: ScriptLabelAlign
}

struct ScriptBanner: Equatable, Sendable {
    let text: String
    let color: String
    let position: String
    let size: String
}

struct ScriptRenderModel: Equatable, Sendable {
    let candleColors: [String?]?
    let markers: [ScriptMarker]
    let lines: [ScriptLine]
    let fills: [ScriptAreaFill]
    let segments: [ScriptSegment]
    let bands: [ScriptBand]
    let labels: [ScriptLabel]
    let banner: ScriptBanner?
}

// TWC predates the shared contract. Aliases preserve its public names while
// keeping generic geometry out of that indicator's compute implementation.
typealias TwcMarkerShape = ScriptMarkerShape
typealias TwcMarkerPlacement = ScriptMarkerPlacement
typealias TwcMarker = ScriptMarker
typealias TwcLine = ScriptLine
typealias TwcAreaFill = ScriptAreaFill
typealias TwcSegmentStyle = ScriptSegmentStyle
typealias TwcSegment = ScriptSegment
typealias TwcBand = ScriptBand
typealias TwcLabelAlign = ScriptLabelAlign
typealias TwcLabel = ScriptLabel
typealias TwcBanner = ScriptBanner
typealias TwcRenderModel = ScriptRenderModel

enum ScriptColor {
    struct Components {
        let red: Double
        let green: Double
        let blue: Double
        let alpha: Double
    }

    static func parse(_ color: String) -> Components? {
        let value = color.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.range(of: #"^#[0-9a-f]{6}$"#, options: .regularExpression) != nil {
            let raw = String(value.dropFirst())
            guard let red = Int(raw.prefix(2), radix: 16),
                  let green = Int(raw.dropFirst(2).prefix(2), radix: 16),
                  let blue = Int(raw.dropFirst(4).prefix(2), radix: 16)
            else { return nil }
            return Components(red: Double(red), green: Double(green), blue: Double(blue), alpha: 1)
        }
        let expected = value.hasPrefix("rgba(") ? 4 : value.hasPrefix("rgb(") ? 3 : 0
        guard expected > 0,
              let open = value.firstIndex(of: "("),
              let close = value.lastIndex(of: ")"),
              close == value.index(before: value.endIndex)
        else { return nil }
        let rawComponents = value[value.index(after: open)..<close]
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard rawComponents.count == expected,
              rawComponents.allSatisfy({ !$0.isEmpty })
        else { return nil }
        let decimalPattern = #"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$"#
        guard rawComponents.allSatisfy({
            $0.range(of: decimalPattern, options: .regularExpression) != nil
        }) else { return nil }
        let parsed = rawComponents.map { Double($0) }
        guard parsed.allSatisfy({ $0?.isFinite == true }) else { return nil }
        let components = parsed.compactMap { $0 }
        guard components.prefix(3).allSatisfy({ $0 >= 0 && $0 <= 255 }),
              expected == 3 || (components[3] >= 0 && components[3] <= 1)
        else { return nil }
        return Components(
            red: components[0], green: components[1], blue: components[2],
            alpha: expected == 4 ? components[3] : 1
        )
    }

    static func isValid(_ color: String) -> Bool {
        parse(color) != nil
    }

    private static func cssNumber(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(value)
    }

    static func withOpacity(_ color: String, _ opacity: Double) -> String {
        guard let components = parse(color) else { return color }
        let safeOpacity = opacity.isFinite ? min(1, max(0, opacity)) : 1
        return "rgba(\(cssNumber(components.red)), \(cssNumber(components.green)), "
            + "\(cssNumber(components.blue)), \(safeOpacity))"
    }
}

extension ScriptRenderModel {
    static func merging(_ models: [ScriptRenderModel?]) -> ScriptRenderModel? {
        let active = models.compactMap { $0 }
        guard !active.isEmpty else { return nil }
        return ScriptRenderModel(
            candleColors: active.compactMap(\.candleColors).first,
            markers: active.flatMap(\.markers),
            lines: active.flatMap(\.lines),
            fills: active.flatMap(\.fills),
            segments: active.flatMap(\.segments),
            bands: active.flatMap(\.bands),
            labels: active.flatMap(\.labels),
            banner: active.compactMap(\.banner).first
        )
    }
}
