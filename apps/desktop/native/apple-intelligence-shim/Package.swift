// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AppleIntelligenceShim",
    platforms: [.macOS(.v26)],
    targets: [
        .target(
            name: "ShimCore",
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
