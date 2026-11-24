import CoreGraphics
import CryptoKit
import Darwin
import Evidence
import Foundation
import XCTest
@testable import Screen

@MainActor
final class RecognitionBacklogTests: XCTestCase {
    func testTheAttemptReturnsBeforeItsTextAndThePublishedFrameHasIt() async throws {
        let reader = HeldReader()
        let display = SyntheticDisplay(reader: reader, frames: [try TileReuseTests.frame()])
        let capture = ScreenCapture(adapter: display)
        hold(reader)
        guard case .recognizing(_, let finish) = try await capture.capture() else {
            return XCTFail("the attempt returned with its text")
        }
        try await until("reader.asked >= 4") { reader.asked >= 4 }
        reader.release()
        let results = await finish()
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.observation.status, "captured")
        XCTAssertNotNil(results.first?.image)
        XCTAssertEqual(results.first?.observation.ocr.count, 8, "two lines a tile")
        XCTAssertEqual(results.first?.observation.ocrStatus, "complete-full-first")
        XCTAssertEqual(results.first?.observation.ocr, try Self.full(TileReuseTests.frame()))
    }

    func testAnAttemptHoldsWhileTheBackstopsImagesWaitForTheirText() async throws {
        let capacity = TextRecognizer.capacity
        XCTAssertEqual(capacity, 16)
        let reader = HeldReader()
        let frames = try (0...capacity).map { try TileReuseTests.frame(scroll: 8 * $0) }
        let display = SyntheticDisplay(reader: reader, frames: frames)
        let capture = ScreenCapture(adapter: display)
        hold(reader)
        var finishes: [() async -> [CaptureResult]] = []
        for _ in 0..<capacity {
            guard case .recognizing(_, let finish) = try await capture.capture() else { return XCTFail("no text pending") }
            finishes.append(finish)
        }
        let next = Task { try await capture.capture() }
        try await until("display.inner.recognizer.held == 1") { display.inner.recognizer.held == 1 }
        XCTAssertEqual(display.prepared, capacity + 1, "the next attempt began")
        XCTAssertFalse(display.enrichedAll, "and holds while the backstop's images wait for their text")
        reader.release()
        for (index, finish) in finishes.enumerated() {
            let text = await finish().first?.observation.ocr
            XCTAssertEqual(text, try Self.full(frames[index]), "each frame its own text")
        }
        guard case .recognizing(_, let last) = try await next.value else { return XCTFail("no text pending") }
        let lastText = await last().first?.observation.ocr
        XCTAssertEqual(lastText, try Self.full(frames[capacity]))
    }

    func testAFrameShowingACropStillBeingReadSharesTheRead() async throws {
        let reader = HeldReader()
        let a = try TileReuseTests.frame()
        let b = try TileReuseTests.frame(scroll: 16)
        let display = SyntheticDisplay(reader: reader, frames: [a, a, b, a])
        let capture = ScreenCapture(adapter: display)
        hold(reader)
        var finishes: [() async -> [CaptureResult]] = []
        for _ in 0..<4 {
            guard case .recognizing(_, let finish) = try await capture.capture() else { return XCTFail("no text pending") }
            finishes.append(finish)
        }
        try await until("reader.asked >= 8") { reader.asked >= 8 }
        XCTAssertEqual(reader.asked, 8, "a's four crops and b's four, each read once while none has its text")
        reader.release()
        let statuses = await finishes.asyncMap { await $0().first?.observation.ocrStatus }
        XCTAssertEqual(statuses, ["complete-full-first", "reused-exact-image", "complete-full-pixels-changed",
                                  "reused-exact-image"])
        let shared = await finishes[3]().first?.observation.ocr
        XCTAssertEqual(shared, try Self.full(a))
    }

    func testAPrivacyCloseAnswersWaitingFramesAtOnceAndTheirReadsServeLaterFrames() async throws {
        let reader = HeldReader()
        let a = try TileReuseTests.frame()
        let b = try TileReuseTests.frame(scroll: 16)
        let display = SyntheticDisplay(reader: reader, frames: [a, b, a])
        let capture = ScreenCapture(adapter: display)
        hold(reader)
        guard case .recognizing(_, let first) = try await capture.capture() else { return XCTFail("no text pending") }
        guard case .recognizing(_, let second) = try await capture.capture() else { return XCTFail("no text pending") }
        capture.invalidateCaches()
        for finish in [first, second] {
            let dropped = await finish()
            XCTAssertEqual(dropped.map(\.observation.reason), [CaptureGapReason.captureGenerationInvalidated.rawValue])
            XCTAssertEqual(dropped.compactMap(\.image).count, 0)
        }
        XCTAssertTrue(reader.holding, "answered while their reads were still held")

        guard case .recognizing(_, let third) = try await capture.capture() else { return XCTFail("no text pending") }
        XCTAssertEqual(reader.asked, 8, "nothing read again")
        reader.release()
        let results = await third()
        XCTAssertEqual(results.first?.observation.status, "captured")
        XCTAssertEqual(results.first?.observation.ocrStatus, "reused-exact-image")
        XCTAssertEqual(results.first?.observation.ocr, try Self.full(a))
    }

    func testATechnicalGapOrAnOrdinarySwitchKeepsAWaitingFrameAndAPrivacyGapClosesIt() async throws {
        let reader = HeldReader()
        let a = try TileReuseTests.frame()
        let b = try TileReuseTests.frame(scroll: 16)
        let display = SyntheticDisplay(reader: reader, frames: [a, b])
        let capture = ScreenCapture(adapter: display)
        hold(reader)
        guard case .recognizing(_, let kept) = try await capture.capture() else { return XCTFail("no text pending") }
        display.rejectNext = .screenAcquisitionFailed
        guard case .done(let failed) = try await capture.capture() else { return XCTFail("a gap waits for nothing") }
        XCTAssertEqual(failed.map(\.observation.reason), [CaptureGapReason.screenAcquisitionFailed.rawValue])
        capture.invalidateContext()
        reader.release()
        let published = await kept()
        XCTAssertEqual(published.first?.observation.status, "captured")
        XCTAssertEqual(published.first?.observation.ocr, try Self.full(a))

        hold(reader)
        guard case .recognizing(_, let closed) = try await capture.capture() else { return XCTFail("no text pending") }
        display.rejectNext = .secureFieldFocused
        guard case .done(let secure) = try await capture.capture() else { return XCTFail("a gap waits for nothing") }
        XCTAssertEqual(secure.map(\.observation.reason), [CaptureGapReason.secureFieldFocused.rawValue])
        let dropped = await closed()
        XCTAssertEqual(dropped.map(\.observation.reason), [CaptureGapReason.captureGenerationInvalidated.rawValue])
        reader.release()
    }

    func testAGapInAFramesPlaceIsAtTheFramesOwnCaptureTime() async throws {
        let reader = HeldReader()
        let display = SyntheticDisplay(reader: reader, frames: [try TileReuseTests.frame()])
        let capture = ScreenCapture(adapter: display)
        hold(reader)
        guard case .recognizing(_, let closed) = try await capture.capture() else { return XCTFail("no text pending") }
        capture.invalidateCaches()
        let dropped = await closed()
        XCTAssertEqual(dropped.map(\.observation.reason), [CaptureGapReason.captureGenerationInvalidated.rawValue])
        XCTAssertEqual(dropped.first?.observation.capturedAt, display.capturedAt(1), "the frame's slot, not the close's")
        reader.release()

        hold(reader)
        guard case .recognizing(_, let refused) = try await capture.capture() else { return XCTFail("no text pending") }
        display.rejectAtPublication = .siteChangedDuringCapture
        reader.release()
        let gap = await refused()
        XCTAssertEqual(gap.map(\.observation.reason), [CaptureGapReason.siteChangedDuringCapture.rawValue])
        XCTAssertEqual(gap.first?.observation.capturedAt, display.capturedAt(2))
        XCTAssertEqual(gap.compactMap(\.image).count, 0)
    }

    static func full(_ image: CGImage) throws -> [TextObservation] {
        ImageRecognition.full(image, vision: FakeVision().read).observations
    }

    private func hold(_ reader: HeldReader) {
        reader.hold()
        addTeardownBlock { reader.release() }
    }
}

private extension Array {
    func asyncMap<T>(_ transform: (Element) async -> T) async -> [T] {
        var mapped: [T] = []
        for element in self { mapped.append(await transform(element)) }
        return mapped
    }
}


@MainActor
final class SyntheticDisplay: CaptureAdapter {
    static let app = CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: 4242)
    let inner: ScreenCaptureKitAdapter
    private let frames: [CGImage]
    private(set) var prepared = 0
    private var enriched = 0
    var enrichedAll: Bool { enriched >= prepared }
    var rejectNext: CaptureGapReason?
    var rejectAtPublication: CaptureGapReason?

    init(reader: HeldReader, frames: [CGImage]) {
        self.frames = frames
        inner = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .exact),
            system: FakeSystemFacts(front: Self.app, focused: [:]), pages: NoBrowserPages(), reader: reader.reader)
    }

    func prepare(pipeline: CapturePipeline, ticket: CapturePipeline.Ticket) async throws -> CaptureBatch {
        if let reason = rejectNext {
            rejectNext = nil
            throw CapturePipeline.Failure.rejected(reason)
        }
        let image = frames[prepared % frames.count]
        prepared += 1
        let at = capturedAt(prepared)
        let operation = CaptureOperation(
            acquire: {
                AcquiredCapture(image: image, provenance: CaptureAcquisition(backend: "screenshot", receivedAt: at,
                    freshness: "screenshot-request-completed"), endedAt: at)
            },
            validate: { _ in nil },
            enrich: { [self] acquired in
                let result = try await inner.enrich(acquired,
                    observation: CaptureObservation(capturedAt: at, displayID: 1, width: 0, height: 0, application: Self.app),
                    accessibility: { AccessibilitySnapshot(capturedAt: at, status: "complete-scoped-app-reported", nodes: []) },
                    vision: FakeVision().read)
                enriched += 1
                return result
            })
        return CaptureBatch(requests: [CaptureRequest(displayID: 1) { operation }],
                            validate: { [self] in rejectAtPublication })
    }

    func capturedAt(_ n: Int) -> Date {
        Date(timeIntervalSince1970: 1_790_848_157.303 + Double(n) * 2)
    }
}

final class HeldReader: @unchecked Sendable {
    private let lock = NSLock()
    private var gate: DispatchSemaphore?
    private var count = 0
    private let text = FakeVision()

    var asked: Int { lock.withLock { count } }
    var holding: Bool { lock.withLock { gate != nil } }

    func hold() { lock.withLock { gate = DispatchSemaphore(value: 0) } }

    func release() {
        let released = lock.withLock { () -> DispatchSemaphore? in
            defer { gate = nil }
            return gate
        }
        for _ in 0..<64 { released?.signal() }
    }

    var reader: TextRecognizer.Reader {
        { [self] frame, tile in
            let held = lock.withLock { () -> DispatchSemaphore? in
                count += 1
                return gate
            }
            return await BlockingWork.run { [text] in
                held?.wait()
                return text.read(crop: TileCrop(frame, tile))
            }
        }
    }
}
