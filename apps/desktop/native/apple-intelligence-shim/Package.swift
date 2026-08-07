// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AppleIntelligenceShim",
    platforms: [.macOS(.v26)],
    dependencies: [
        .package(path: "../../../../packages/swift-shared"),
    ],
    targets: [
        .target(
            name: "ShimCore",
            dependencies: [.product(name: "CandleEncoding", package: "swift-shared")],
            path: "Sources/ShimCore"
        ),
        .executableTarget(
            name: "AppleIntelligenceShim",
            dependencies: ["ShimCore"],
            path: "Sources/AppleIntelligenceShim"
        ),
        .testTarget(
            name: "ShimCoreTests",
            dependencies: ["ShimCore"],
            path: "Tests/ShimCoreTests"
        ),
    ]
)
