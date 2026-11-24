import CoreGraphics
import CryptoKit
import Evidence
import Foundation
import Spool
import XCTest
@testable import Screen

final class TileReuseTests: XCTestCase {
    static let width = 2217
    static let height = 1440
    static let editor = CaptureApplication(bundleID: "com.example.editor", name: "Example Editor", pid: 4242)
    static let terminal = CaptureApplication(bundleID: "com.example.terminal", name: "Example Terminal", pid: 4343)

    enum Quarter: Int { case topLeft, topRight, bottomLeft, bottomRight }

    @MainActor
    func testOnlyChangedTilesAreReadAndTheTextEqualsAFullRecognition() async throws {
        let vision = FakeVision()
        let live = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .exact),
            system: FakeSystemFacts(front: Self.editor, focused: [:]), pages: NoBrowserPages(), reader: vision.reader)
        let full = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .always),
            system: FakeSystemFacts(front: Self.editor, focused: [:]), pages: NoBrowserPages(), reader: vision.reader)
        XCTAssertEqual(VisionRecognizer.tiles(width: Self.width, height: Self.height).map(\.core), [
            CGRect(x: 0, y: 0, width: 1108, height: 720), CGRect(x: 1108, y: 0, width: 1109, height: 720),
            CGRect(x: 0, y: 720, width: 1108, height: 720), CGRect(x: 1108, y: 720, width: 1109, height: 720)])

        let clock = CGRect(x: 2080, y: 4, width: 96, height: 16)
        let lastLine = CGRect(x: 30, y: 1410, width: 560, height: 16)
        let seam = CGRect(x: 1120, y: 100, width: 10, height: 10)
        let steps: [(name: String, image: CGImage, app: CaptureApplication, status: String, read: Set<Quarter>)] = [
            ("first", try Self.frame(), Self.editor, "complete-full-first", [.topLeft, .topRight, .bottomLeft, .bottomRight]),
            ("clock", try Self.frame([(clock, 0.9)]), Self.editor, "complete-reused-tiles", [.topRight]),
            ("last line", try Self.frame([(clock, 0.9), (lastLine, 0.8)]), Self.editor, "complete-reused-tiles", [.bottomLeft]),
            ("margin", try Self.frame([(clock, 0.9), (lastLine, 0.8), (seam, 0.7)]), Self.editor, "complete-reused-tiles",
             [.topLeft, .topRight]),
            ("unchanged", try Self.frame([(clock, 0.9), (lastLine, 0.8), (seam, 0.7)]), Self.editor, "reused-exact-image", []),
            ("changed back", try Self.frame([(clock, 0.9), (lastLine, 0.8)]), Self.editor, "reused-exact-image", []),
            ("unchanged after changing back", try Self.frame([(clock, 0.9), (lastLine, 0.8)]), Self.editor,
             "reused-exact-image", []),
            ("clock blinks off", try Self.frame([(lastLine, 0.8)]), Self.editor, "reused-exact-image", []),
            ("clock blinks on", try Self.frame([(clock, 0.9), (lastLine, 0.8)]), Self.editor, "reused-exact-image", []),
            ("scroll", try Self.frame([(clock, 0.9), (lastLine, 0.8)], scroll: 16), Self.editor, "complete-full-pixels-changed",
             [.topLeft, .topRight, .bottomLeft, .bottomRight]),
            ("another app, same pixels", try Self.frame([(clock, 0.9), (lastLine, 0.8)], scroll: 16), Self.terminal,
             "reused-exact-image", []),
            ("another app, its own text", try Self.frame([(lastLine, 0.6)], scroll: 40), Self.terminal,
             "complete-full-pixels-changed", [.topLeft, .topRight, .bottomLeft, .bottomRight]),
            ("back to the first", try Self.frame(), Self.editor, "reused-exact-image", []),
        ]
        for step in steps {
            let expected = try await Self.enrich(full, step.image, app: step.app, vision: vision)
            XCTAssertEqual(vision.take().count, 4, step.name)
            XCTAssertEqual(expected.observation.ocrStatus, "complete")

            let enriched = try await Self.enrich(live, step.image, app: step.app, vision: vision)
            XCTAssertEqual(Set(vision.take().map(Self.tile)), step.read, "\(step.name): only changed tiles are read")
            XCTAssertEqual(enriched.observation.ocr, expected.observation.ocr, "\(step.name): the text of a full recognition")
            XCTAssertEqual(enriched.observation.ocr.count, 8, step.name)
            let json = try FrontWindowTests.published(enriched.observation, image: enriched.image)
            XCTAssertTrue(json.contains(#""ocrStatus":"\#(step.status)""#), step.name)
            XCTAssertTrue(json.contains(#""ocrTiles":\#(step.read.count)"#), step.name)
        }

        vision.failing = true
        let unread = try Self.frame(scroll: 64)
        let failed = try await Self.enrich(live, unread, app: Self.terminal, vision: vision)
        XCTAssertEqual(failed.observation.ocrStatus, "failed")
        XCTAssertEqual(failed.observation.ocr, [])
        XCTAssertEqual(failed.observation.timings?.ocrTiles, 4, "every new crop was asked for")
        await vision.answered(4)
        _ = vision.take()
        vision.failing = false
        let known = try Self.frame([(clock, 0.9), (lastLine, 0.8)], scroll: 16)
        let expected = try await Self.enrich(full, known, app: Self.terminal, vision: vision)
        _ = vision.take()
        let again = try await Self.enrich(live, known, app: Self.terminal, vision: vision)
        XCTAssertEqual(again.observation.ocrStatus, "reused-exact-image")
        XCTAssertEqual(vision.take().count, 0)
        XCTAssertEqual(again.observation.ocr, expected.observation.ocr)
        let fullUnread = try await Self.enrich(full, unread, app: Self.terminal, vision: vision)
        _ = vision.take()
        let reread = try await Self.enrich(live, unread, app: Self.terminal, vision: vision)
        XCTAssertEqual(vision.take().count, 4, "a failed crop is read again")
        XCTAssertEqual(reread.observation.ocrStatus, "complete-full-pixels-changed")
        XCTAssertEqual(reread.observation.ocr, fullUnread.observation.ocr)
    }

    @MainActor
    func testEachTileRemembersItsMostRecentlyShownCrops() async throws {
        XCTAssertEqual(RecognitionMemory.versions, 8)
        let vision = FakeVision()
        let live = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .exact),
            system: FakeSystemFacts(front: Self.editor, focused: [:]), pages: NoBrowserPages(), reader: vision.reader)
        let full = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .always),
            system: FakeSystemFacts(front: Self.editor, focused: [:]), pages: NoBrowserPages(), reader: vision.reader)
        func clock(_ state: Int) throws -> CGImage {
            try Self.frame([(CGRect(x: 2080, y: 4, width: 96, height: 16), 0.5 + CGFloat(state) / 40)])
        }
        func show(_ state: Int, reads: Int, _ name: String) async throws {
            let image = try clock(state)
            let expected = try await Self.enrich(full, image, app: Self.editor, vision: vision)
            _ = vision.take()
            let enriched = try await Self.enrich(live, image, app: Self.editor, vision: vision)
            let read = vision.take()
            XCTAssertEqual(read.count, reads, name)
            XCTAssertTrue(reads == 4 || read.allSatisfy { Self.tile($0) == .topRight }, name)
            XCTAssertEqual(enriched.observation.ocr, expected.observation.ocr, name)
        }
        try await show(0, reads: 4, "first")
        for state in 1...8 { try await show(state, reads: 1, "new state \(state)") }
        try await show(0, reads: 1, "the ninth state ago is forgotten")
        try await show(2, reads: 0, "the oldest remembered is recalled")
        try await show(9, reads: 1, "a new state forgets the least recently shown, 3")
        try await show(2, reads: 0, "recalled, not forgotten")
        try await show(3, reads: 1, "forgotten; this forgets 4")
        for state in [5, 6, 7, 8, 0, 9, 2, 3] { try await show(state, reads: 0, "remembered \(state)") }
    }

    @MainActor
    func testACropIsRecalledOnlyInTheLayoutItWasReadIn() async throws {
        let vision = FakeVision()
        let live = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .exact),
            system: FakeSystemFacts(front: Self.editor, focused: [:]), pages: NoBrowserPages(), reader: vision.reader)
        let full = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .always),
            system: FakeSystemFacts(front: Self.editor, focused: [:]), pages: NoBrowserPages(), reader: vision.reader)
        let srgb = try Self.frame()
        let p3 = try XCTUnwrap(srgb.copy(colorSpace: try XCTUnwrap(CGColorSpace(name: CGColorSpace.displayP3))))
        func redrawn(width: Int, bitmapInfo: UInt32) throws -> CGImage {
            let context = try XCTUnwrap(CGContext(data: nil, width: width, height: Self.height, bitsPerComponent: 8,
                bytesPerRow: 0, space: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)), bitmapInfo: bitmapInfo))
            context.draw(srgb, in: CGRect(x: 0, y: 0, width: Self.width, height: Self.height))
            return try XCTUnwrap(context.makeImage())
        }
        let narrower = try redrawn(width: Self.width - 8, bitmapInfo: srgb.bitmapInfo.rawValue)
        let rgba = try redrawn(width: Self.width, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        let steps: [(String, CGImage, String, Int)] = [
            ("first", srgb, "complete-full-first", 4),
            ("colour space", p3, "complete-full-color-space-changed", 4),
            ("back to sRGB", srgb, "complete-full-color-space-changed", 4),
            ("pixel layout", rgba, "complete-full-pixel-layout-changed", 4),
            ("back to BGRA", srgb, "complete-full-pixel-layout-changed", 4),
            ("size", narrower, "complete-full-incompatible-storage", 4),
            ("back to the size", srgb, "complete-full-incompatible-storage", 4),
            ("same layout again", srgb, "reused-exact-image", 0),
        ]
        for (name, image, status, reads) in steps {
            let expected = try await Self.enrich(full, image, app: Self.editor, vision: vision)
            _ = vision.take()
            let enriched = try await Self.enrich(live, image, app: Self.editor, vision: vision)
            XCTAssertEqual(vision.take().count, reads, name)
            XCTAssertEqual(enriched.observation.ocrStatus, status, name)
            XCTAssertEqual(enriched.observation.ocr, expected.observation.ocr, name)
        }
    }

    @MainActor
    func testSwitchesAndInvalidationKeepMemory() async throws {
        let vision = FakeVision()
        let live = ScreenCaptureKitAdapter(configuration: ScreenCapture.Configuration(ocr: .exact),
            system: FakeSystemFacts(front: Self.editor, focused: [:]), pages: NoBrowserPages(), reader: vision.reader)
        let screen = ScreenCapture(adapter: live)
        let image = try Self.frame()
        let first = try await Self.enrich(live, image, app: Self.editor, vision: vision)
        _ = vision.take()
        screen.invalidateContext()
        screen.invalidateCaches()
        screen.setModes(RecordingModes())
        let again = try await Self.enrich(live, image, app: Self.terminal, vision: vision)
        XCTAssertEqual(vision.take().count, 0)
        XCTAssertEqual(again.observation.ocrStatus, "reused-exact-image")
        XCTAssertEqual(again.observation.ocr, first.observation.ocr)
    }


    @MainActor
    static func enrich(_ adapter: ScreenCaptureKitAdapter, _ image: CGImage, app: CaptureApplication,
                       vision: FakeVision) async throws -> (observation: CaptureObservation, image: CaptureImage) {
        let at = Date(timeIntervalSince1970: 1_790_848_157.303)
        let timing = StepTiming()
        var enriched = try await adapter.enrich(
            AcquiredCapture(image: image, provenance: CaptureAcquisition(backend: "screenshot", receivedAt: at,
                freshness: "screenshot-request-completed"), endedAt: at),
            observation: CaptureObservation(capturedAt: at, displayID: 1, width: 0, height: 0, application: app),
            accessibility: { AccessibilitySnapshot(capturedAt: at, status: "complete-scoped-app-reported", nodes: []) },
            vision: vision.read, timing: timing)
        enriched.observation.timings = timing.timings
        return (await enriched.recognized(), enriched.image)
    }

    static func tile(_ core: CGRect) -> Quarter {
        Quarter(rawValue: (core.minY > 0 ? 2 : 0) + (core.minX > 0 ? 1 : 0))!
    }

    static func frame(_ edits: [(CGRect, CGFloat)] = [], scroll: Int = 0) throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)),
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue))
        context.setFillColor(gray: 0.1, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        var seed: UInt64 = 0x5EED
        func next(_ bound: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(bound))
        }
        for _ in 0..<400 {
            let block = CGRect(x: next(width), y: next(height + 64) - scroll, width: 8 + next(120), height: 6 + next(14))
            context.setFillColor(gray: CGFloat(30 + next(70)) / 100, alpha: 1)
            context.fill(CGRect(x: block.minX, y: CGFloat(height) - block.maxY, width: block.width, height: block.height))
        }
        for (rect, grey) in edits {
            context.setFillColor(gray: grey, alpha: 1)
            context.fill(CGRect(x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height))
        }
        return try XCTUnwrap(context.makeImage())
    }
}

final class FakeVision: @unchecked Sendable {
    private let lock = NSLock()
    private var requested: [CGRect] = []
    private var answered = 0
    private var waiting: [(count: Int, resume: CheckedContinuation<Void, Never>)] = []
    private var fails = false

    var failing: Bool {
        get { lock.withLock { fails } }
        set { lock.withLock { fails = newValue } }
    }

    var reader: TextRecognizer.Reader {
        { [self] frame, tile in read(crop: TileCrop(frame, tile)) }
    }

    func read(_ image: CGImage, _ tile: Tile) -> [TextObservation]? {
        guard let data = image.dataProvider?.data as Data? else { return nil }
        let length = Int(tile.crop.width) * 4
        var rows = Data(capacity: length * Int(tile.crop.height))
        for y in Int(tile.crop.minY)..<Int(tile.crop.maxY) {
            let start = y * image.bytesPerRow + Int(tile.crop.minX) * 4
            rows += data[start..<start + length]
        }
        return read(crop: TileCrop(tile: tile, width: Int(tile.crop.width), height: Int(tile.crop.height),
                                   bitmapInfo: image.bitmapInfo.rawValue, renderingIntent: image.renderingIntent.rawValue,
                                   profile: Data(), pixels: rows))
    }

    func read(crop: TileCrop) -> [TextObservation]? {
        let tile = crop.tile
        let fails = lock.withLock {
            requested.append(tile.core)
            return self.fails
        }
        defer { answer() }
        guard !fails else { return nil }
        let text = SHA256.hash(data: crop.pixels).prefix(6).map { String(format: "%02x", $0) }.joined()
        let width = tile.width, height = tile.height
        return [CGFloat(0.25), 0.75].map { fraction in
            let y = tile.core.minY + tile.core.height * fraction
            return TextObservation(text: "SYNTHETIC \(text) \(fraction)", confidence: 0.5,
                bounds: CaptureRect(CGRect(x: tile.core.minX / width + 0.01, y: 1 - (y + 8) / height,
                                           width: tile.core.width / width / 2, height: 16 / height)))
        }
    }

    func answered(_ count: Int) async {
        await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
            let ready = lock.withLock {
                guard answered < count else { return true }
                waiting.append((count, resume))
                return false
            }
            if ready { resume.resume() }
        }
    }

    private func answer() {
        let ready = lock.withLock {
            answered += 1
            defer { waiting.removeAll { $0.count <= answered } }
            return waiting.filter { $0.count <= answered }.map(\.resume)
        }
        for resume in ready { resume.resume() }
    }

    func take() -> [CGRect] {
        lock.withLock {
            defer {
                requested = []
                answered = 0
            }
            return requested
        }
    }
}
