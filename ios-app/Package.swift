// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LifestreamCapture",
    platforms: [
        .iOS("26.0"),
        .macOS(.v15),
    ],
    products: [
        .library(name: "LifestreamCaptureCore", targets: ["LifestreamCaptureCore"]),
    ],
    dependencies: [.package(path: "../homelink")],
    targets: [
        .target(name: "LifestreamCaptureCore", dependencies: [.product(name: "HomeLink", package: "homelink")]),
        .testTarget(
            name: "LifestreamCaptureCoreTests",
            dependencies: ["LifestreamCaptureCore", .product(name: "HomeLink", package: "homelink")]
        ),
    ]
)
