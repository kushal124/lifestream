// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HomeLink",
    platforms: [.macOS("14.2"), .iOS("26.0")],
    products: [.library(name: "HomeLink", targets: ["HomeLink"])],
    dependencies: [.package(path: "../devicefiles")],
    targets: [
        .target(name: "HomeLink", dependencies: [.product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "HomeLinkTests", dependencies: ["HomeLink", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "HomeLinkE2ETests", dependencies: ["HomeLink"]),
    ],
    swiftLanguageModes: [.v5]
)
