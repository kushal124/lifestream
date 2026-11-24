import CoreGraphics
import CryptoKit
import Evidence
import Foundation

struct RecognitionMemory {
    static let versions = 8

    struct Layout: Equatable {
        let width: Int
        let height: Int
        let bytesPerRow: Int
        let bitmapInfo: UInt32
        let colorSpace: CGColorSpace
        let renderingIntent: CGColorRenderingIntent

        init?(_ image: CGImage) {
            guard let colorSpace = image.colorSpace else { return nil }
            width = image.width
            height = image.height
            bytesPerRow = image.bytesPerRow
            bitmapInfo = image.bitmapInfo.rawValue
            self.colorSpace = colorSpace
            renderingIntent = image.renderingIntent
        }

        static func == (a: Layout, b: Layout) -> Bool {
            a.width == b.width && a.height == b.height && a.bytesPerRow == b.bytesPerRow
                && a.bitmapInfo == b.bitmapInfo && a.renderingIntent == b.renderingIntent
                && CFEqual(a.colorSpace, b.colorSpace)
        }
    }

    struct Version {
        let digest: SHA256.Digest
        let text: TileText
    }

    let layout: Layout
    let bytes: Data
    let tiles: [[Version]]

    static func digest(_ tile: Tile, _ bytes: Data, bytesPerRow: Int) -> SHA256.Digest {
        var hasher = SHA256()
        let start = Int(tile.crop.minX) * 4, length = Int(tile.crop.width) * 4
        bytes.withUnsafeBytes { raw in
            for y in Int(tile.crop.minY)..<Int(tile.crop.maxY) {
                let row = y * bytesPerRow + start
                hasher.update(bufferPointer: UnsafeRawBufferPointer(rebasing: raw[row..<row + length]))
            }
        }
        return hasher.finalize()
    }

    static func remembering(_ version: Version, before earlier: [Version]) -> [Version] {
        [version] + earlier.lazy.filter { $0.digest != version.digest }.prefix(versions - 1)
    }
}

@MainActor
final class TileText {
    let task: Task<[TextObservation]?, Never>
    private let outcome: Outcome

    var failed: Bool { outcome.failed }

    init(_ read: @escaping @MainActor () async -> [TextObservation]?) {
        let outcome = Outcome()
        self.outcome = outcome
        task = Task { @MainActor in
            let text = await read()
            if text == nil { outcome.failed = true }
            return text
        }
    }

    init(known: [TextObservation]) {
        outcome = Outcome()
        task = Task { known }
    }

    @MainActor private final class Outcome {
        var failed = false
    }
}
