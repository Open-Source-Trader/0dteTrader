// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CandleEncoding",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "CandleEncoding", targets: ["CandleEncoding"]),
    ],
    targets: [
        .target(
            name: "CandleEncoding",
            path: "Sources/CandleEncoding"
        ),
        .testTarget(
            name: "CandleEncodingTests",
            dependencies: ["CandleEncoding"],
            path: "Tests/CandleEncodingTests"
        ),
    ]
)
