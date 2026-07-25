import XCTest
import UIKit
@testable import ZeroDTETrader

final class ScreenshotCaptureTests: XCTestCase {
    private let colorAccuracy: CGFloat = 0.05

    /// The rendered image must match the view's bounds — a zero-sized image
    /// would leave the share sheet empty.
    func testRender_producesImageWithViewBounds() {
        let view = UIView(frame: CGRect(x: 0, y: 0, width: 200, height: 100))

        let image = ScreenshotCapture.render(view)

        XCTAssertEqual(image.size, CGSize(width: 200, height: 100))
    }

    /// Exercises the real production path: the test suite runs hosted inside
    /// the live app, whose key window is genuinely composited on screen, so
    /// capturing it must produce a fully opaque, non-empty image.
    /// (`drawHierarchy` on a detached or scene-less window renders fully
    /// transparent — the blank-capture failure mode this guards against.)
    func testCaptureKeyWindow_producesOpaqueImage() throws {
        let image = try XCTUnwrap(ScreenshotCapture.captureKeyWindow())

        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertGreaterThan(image.size.height, 0)
        let color = try XCTUnwrap(averageColor(of: image))
        XCTAssertEqual(color.alpha, 1, accuracy: colorAccuracy)
    }

    private struct AverageColor {
        let red: CGFloat
        let green: CGFloat
        let blue: CGFloat
        let alpha: CGFloat
    }

    /// Downscales the image to a single pixel in a known RGBA format. Avoids
    /// bitmap-format assumptions (RGBA vs BGRA, premultiplication).
    private func averageColor(of image: UIImage) -> AverageColor? {
        guard let cgImage = image.cgImage else { return nil }
        var pixel: [UInt8] = [0, 0, 0, 0]
        guard let context = CGContext(
            data: &pixel,
            width: 1,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return AverageColor(
            red: CGFloat(pixel[0]) / 255,
            green: CGFloat(pixel[1]) / 255,
            blue: CGFloat(pixel[2]) / 255,
            alpha: CGFloat(pixel[3]) / 255
        )
    }
}
