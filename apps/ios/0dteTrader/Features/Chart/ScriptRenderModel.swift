import Foundation

enum ScriptColor {
    static func isValid(_ color: String) -> Bool {
        let value = color.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil { return true }
        guard value.hasPrefix("rgb"),
              let open = value.firstIndex(of: "("),
              let close = value.lastIndex(of: ")"),
              close == value.index(before: value.endIndex)
        else { return false }
        let components = value[value.index(after: open)..<close]
            .split(separator: ",", omittingEmptySubsequences: false)
            .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        let expected = value.hasPrefix("rgba(") ? 4 : value.hasPrefix("rgb(") ? 3 : 0
        guard components.count == expected,
              components.prefix(3).allSatisfy({ $0 >= 0 && $0 <= 255 })
        else { return false }
        return expected == 3 || (components[3] >= 0 && components[3] <= 1)
    }

    static func withOpacity(_ color: String, _ opacity: Double) -> String {
        let value = color.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("#"), value.count >= 7 {
            let raw = String(value.dropFirst())
            guard let red = Int(raw.prefix(2), radix: 16),
                  let green = Int(raw.dropFirst(2).prefix(2), radix: 16),
                  let blue = Int(raw.dropFirst(4).prefix(2), radix: 16)
            else { return color }
            return "rgba(\(red), \(green), \(blue), \(opacity))"
        }
        guard value.hasPrefix("rgb"),
              let open = value.firstIndex(of: "("),
              let close = value.lastIndex(of: ")")
        else { return color }
        let components = value[value.index(after: open)..<close]
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard components.count >= 3 else { return color }
        return "rgba(\(components[0]), \(components[1]), \(components[2]), \(opacity))"
    }
}

extension TwcRenderModel {
    static func merging(_ models: [TwcRenderModel?]) -> TwcRenderModel? {
        let active = models.compactMap { $0 }
        guard !active.isEmpty else { return nil }
        return TwcRenderModel(
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
