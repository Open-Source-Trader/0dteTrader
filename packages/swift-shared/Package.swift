// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "CandleEncoding",
    platforms: [
        .iOS(.v17),
        .macOS(.v26),
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
