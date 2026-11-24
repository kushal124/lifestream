// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FaceEngine",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "face-engine", targets: ["face-engine"])],
    targets: [
        .binaryTarget(
            name: "onnxruntime",
            url: "https://download.onnxruntime.ai/pod-archive-onnxruntime-c-1.29.0.zip",
            checksum: "ab89ea27b074201b83c12526d7f7206b916ecd5315174d372d6c27b659e49860"
        ),
        .target(
            name: "COnnxRuntime",
            dependencies: ["onnxruntime"],
            linkerSettings: [.linkedLibrary("c++"), .linkedFramework("CoreML"), .linkedFramework("Foundation"), .linkedFramework("Network")]
        ),
        .executableTarget(
            name: "face-engine",
            dependencies: ["COnnxRuntime"],
            swiftSettings: [.unsafeFlags(["-Xcc", "-DACCELERATE_NEW_LAPACK"])]
        ),
        .testTarget(name: "FaceEngineTests", dependencies: ["face-engine"], path: "EngineTests"),
    ]
)
