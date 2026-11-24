// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PhotoLibrary",
    platforms: [.macOS("14.2"), .iOS("26.0")],
    products: [.library(name: "PhotoLibrary", targets: ["PhotoLibrary"])],
    targets: [
        .target(name: "PhotoLibrary"),
        .testTarget(name: "PhotoLibraryTests", dependencies: ["PhotoLibrary"]),
    ]
)
