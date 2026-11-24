// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DeviceFiles",
    platforms: [.macOS("14.2"), .iOS("26.0")],
    products: [.library(name: "DeviceFiles", targets: ["DeviceFiles"])],
    targets: [
        .target(name: "DeviceFiles"),
        .testTarget(name: "DeviceFilesTests", dependencies: ["DeviceFiles"]),
    ]
)
