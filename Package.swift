// swift-tools-version:5.9
import PackageDescription

// Capacitor 8 (SPM). Capacitor 7 projects use MediaQueue.podspec instead.
let package = Package(
    name: "MediaQueue",
    platforms: [.iOS(.v14)],
    products: [
        .library(name: "MediaQueue", targets: ["MediaQueue"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
    ],
    targets: [
        .target(
            name: "MediaQueue",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/MediaQueuePlugin"
        ),
    ]
)
