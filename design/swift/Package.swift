// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Cockpit",
    platforms: [.iOS("26.0"), .macOS(.v14)],
    products: [.library(name: "Cockpit", targets: ["Cockpit"])],
    targets: [
        .target(name: "Cockpit"),
        .executableTarget(name: "cockpit-gallery", dependencies: ["Cockpit"]),
        .testTarget(name: "CockpitTests", dependencies: ["Cockpit"]),
    ]
)
