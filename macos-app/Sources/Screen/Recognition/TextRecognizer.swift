import CoreGraphics
import Evidence
import Foundation

@MainActor
final class TextRecognizer {
    typealias Vision = (CGImage, Tile) -> [TextObservation]?
    typealias Reader = @Sendable (RawFrame, Tile) async -> [TextObservation]?

    static let capacity = 16

    var mode: OCRMode
    private let reader: Reader
    private var committed: [UInt32: RecognitionMemory] = [:]
    private var outstanding = 0
    private var room: [CheckedContinuation<Void, Never>] = []

    var held: Int { room.count }

    init(mode: OCRMode, reader: @escaping Reader) {
        self.mode = mode
        self.reader = reader
    }

    func start(_ image: CGImage, bytes: RawFrame?, display: UInt32,
               vision: @escaping Vision) async -> Task<RecognizedImage, Never> {
        while outstanding >= Self.capacity {
            await withCheckedContinuation { room.append($0) }
        }
        outstanding += 1
        let previous = mode == .exact ? committed[display] : nil
        let comparison = await BlockingWork.run {
            ResourceMeter.shared.measure(.ocr) { ImageRecognition.compare(image, previous: previous, bytes: bytes) }
        }
        let recognition: Task<RecognizedImage, Never>
        switch comparison {
        case .unusable(let status):
            recognition = Task { await BlockingWork.run { ImageRecognition.full(image, status: status, vision: vision) } }
        case .bytes(let compared):
            let reader = self.reader
            let frame = compared.frame
            let planned = ImageRecognition.plan(compared, previous: committed[display]) { _, tile in
                TileText { await reader(frame, tile) }
            }
            if mode == .exact { committed[display] = planned.memory }
            let status = mode == .exact ? compared.status : .complete
            recognition = Task {
                await ImageRecognition.text(of: planned.texts, status: status, requests: planned.requests,
                                            recalled: planned.recalled)
            }
        }
        return Task { [self] in
            let recognized = await recognition.value
            outstanding -= 1
            if !room.isEmpty { room.removeFirst().resume() }
            ResourceMeter.shared.count(.ocrRequests, recognized.requests)
            if recognized.status == .reusedExactImage || recognized.status == .completeReusedTiles {
                let tiles = VisionRecognizer.tiles(width: image.width, height: image.height).count
                ResourceMeter.shared.count(.ocrTilesReused, tiles - recognized.requests)
                ResourceMeter.shared.count(.ocrTilesRecalled, recognized.recalled)
            }
            return recognized
        }
    }

    func retain(displays: Set<UInt32>) {
        committed = committed.filter { displays.contains($0.key) }
    }
}
