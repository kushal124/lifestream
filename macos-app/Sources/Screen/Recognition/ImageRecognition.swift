import CoreGraphics
import CryptoKit
import Evidence
import Foundation

struct RecognizedImage {
    let observations: [TextObservation]
    let status: OCRStatus
    let requests: Int
    let recalled: Int
}

enum ImageRecognition {
    enum Comparison {
        case bytes(Compared)
        case unusable(OCRStatus)
    }

    struct Compared {
        enum Crop {
            case same
            case digest(SHA256.Digest)
        }

        let frame: RawFrame
        let layout: RecognitionMemory.Layout
        let tiles: [Tile]
        let crops: [Crop]
        let status: OCRStatus
        let comparable: Bool
    }

    static func full(_ image: CGImage, status: OCRStatus = .complete,
                     vision: TextRecognizer.Vision) -> RecognizedImage {
        var kept: [TextObservation] = []
        var requests = 0
        for tile in VisionRecognizer.tiles(width: image.width, height: image.height) {
            requests += 1
            guard let text = vision(image, tile) else {
                return RecognizedImage(observations: [], status: .failed, requests: requests, recalled: 0)
            }
            kept += text
        }
        return RecognizedImage(observations: VisionRecognizer.readingOrder(kept), status: status, requests: requests,
                               recalled: 0)
    }

    nonisolated static func compare(_ image: CGImage, previous: RecognitionMemory?, bytes: RawFrame?) -> Comparison {
        guard let colorSpace = image.colorSpace, colorSpace.model == .rgb, image.bitsPerComponent == 8,
              image.bitsPerPixel == 32, !image.bitmapInfo.contains(.floatComponents), image.decode == nil,
              let layout = RecognitionMemory.Layout(image) else {
            return .unusable(.completeFullUnsupportedImage)
        }
        guard let frame = bytes, frame.layout.width == image.width, frame.layout.height == image.height,
              frame.layout.bytesPerRow == image.bytesPerRow, image.bytesPerRow * image.height <= frame.data.count else {
            return .unusable(.completeFullPixelsUnavailable)
        }
        let tiles = VisionRecognizer.tiles(width: image.width, height: image.height)
        let status: OCRStatus
        if let before = previous?.layout {
            if before.bitmapInfo != layout.bitmapInfo || before.renderingIntent != layout.renderingIntent {
                status = .completeFullPixelLayoutChanged
            } else if !CFEqual(before.colorSpace, layout.colorSpace) {
                status = .completeFullColorSpaceChanged
            } else if before != layout || previous?.tiles.count != tiles.count {
                status = .completeFullIncompatibleStorage
            } else {
                status = .completeFullPixelsChanged
            }
        } else {
            status = .completeFullFirst
        }
        let comparable = status == .completeFullPixelsChanged
        let same = previous.map {
            comparable ? changedTiles(tiles, frame.data, $0.bytes, width: layout.width, height: layout.height,
                                      bytesPerRow: layout.bytesPerRow).map(!) : []
        } ?? []
        let crops = tiles.enumerated().map { index, tile -> Compared.Crop in
            index < same.count && same[index]
                ? .same : .digest(RecognitionMemory.digest(tile, frame.data, bytesPerRow: layout.bytesPerRow))
        }
        return .bytes(Compared(frame: frame, layout: layout, tiles: tiles, crops: crops, status: status,
                               comparable: comparable))
    }

    @MainActor
    static func plan(_ compared: Compared, previous: RecognitionMemory?,
                     read: (Int, Tile) -> TileText) -> (texts: [TileText], requests: Int, recalled: Int,
                                                        memory: RecognitionMemory) {
        var texts: [TileText] = []
        var remembered: [[RecognitionMemory.Version]] = []
        var requests = 0
        var recalled = 0
        for (index, tile) in compared.tiles.enumerated() {
            let earlier = compared.comparable ? previous?.tiles[index] ?? [] : []
            let digest: SHA256.Digest
            switch compared.crops[index] {
            case .same:
                guard let last = earlier.first else { preconditionFailure("an unchanged tile has a last crop") }
                guard last.text.failed else {
                    texts.append(last.text)
                    remembered.append(earlier)
                    continue
                }
                digest = last.digest
            case .digest(let crop):
                digest = crop
            }
            let version: RecognitionMemory.Version
            if let seen = earlier.first(where: { $0.digest == digest && !$0.text.failed }) {
                version = seen
                recalled += 1
            } else {
                requests += 1
                version = RecognitionMemory.Version(digest: digest, text: read(index, tile))
            }
            texts.append(version.text)
            remembered.append(RecognitionMemory.remembering(version, before: earlier))
        }
        return (texts, requests, recalled,
                RecognitionMemory(layout: compared.layout, bytes: compared.frame.data, tiles: remembered))
    }

    static func text(of texts: [TileText], status: OCRStatus, requests: Int, recalled: Int) async -> RecognizedImage {
        var kept: [TextObservation] = []
        for text in texts {
            guard let tile = await text.task.value else {
                return RecognizedImage(observations: [], status: .failed, requests: requests, recalled: recalled)
            }
            kept += tile
        }
        return RecognizedImage(observations: VisionRecognizer.readingOrder(kept),
            status: requests == 0 ? .reusedExactImage : requests < texts.count ? .completeReusedTiles : status,
            requests: requests, recalled: recalled)
    }

    static func changedTiles(_ tiles: [Tile], _ bytes: Data, _ previous: Data, width: Int, height: Int,
                             bytesPerRow: Int) -> [Bool] {
        let spans = tiles.map { (rows: Int($0.crop.minY)..<Int($0.crop.maxY), start: Int($0.crop.minX) * 4,
                                 length: Int($0.crop.width) * 4) }
        var changed = [Bool](repeating: false, count: tiles.count)
        var unchanged = tiles.count
        bytes.withUnsafeBytes { now in
            previous.withUnsafeBytes { before in
                guard let now = now.baseAddress, let before = before.baseAddress else { return }
                for y in 0..<height {
                    let row = y * bytesPerRow
                    guard memcmp(now + row, before + row, width * 4) != 0 else { continue }
                    for (index, span) in spans.enumerated() where !changed[index] && span.rows.contains(y)
                        && memcmp(now + row + span.start, before + row + span.start, span.length) != 0 {
                        changed[index] = true
                        unchanged -= 1
                    }
                    if unchanged == 0 { return }
                }
            }
        }
        return changed
    }
}
