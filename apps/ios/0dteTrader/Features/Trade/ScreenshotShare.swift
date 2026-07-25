import SwiftUI
import UIKit

/// One-tap screen capture (ROADMAP P9): renders the key window to a UIImage,
/// then hands it to the system share sheet (save to Photos/Files, copy,
/// AirDrop, …) — no photo-library permission strings required.
enum ScreenshotCapture {
    /// Renders a view's layer tree into a bitmap. Split from
    /// `captureKeyWindow` so unit tests can render a plain view without an
    /// app window.
    ///
    /// `drawHierarchy` is used instead of SwiftUI's `ImageRenderer` because
    /// the candle chart is a DGCharts `UIViewRepresentable`; drawing the
    /// layer tree captures it (and every SwiftUI overlay) exactly as seen.
    static func render(_ view: UIView) -> UIImage {
        let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
        return renderer.image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
        }
    }

    /// Captures the app's key window — the whole chart/trade view, nav bar
    /// included. Returns nil when no window is available (e.g. the scene is
    /// not yet foreground-active).
    static func captureKeyWindow() -> UIImage? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return nil }
        return render(window)
    }
}

/// `Identifiable` box so a captured image can drive `.sheet(item:)`.
struct CapturedScreenshot: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// System share sheet for the captured image. `UIActivityViewController` has
/// no SwiftUI-native equivalent for sharing a raster image produced on tap,
/// so it is wrapped here.
struct ShareSheet: UIViewControllerRepresentable {
    let image: UIImage

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [image], applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
