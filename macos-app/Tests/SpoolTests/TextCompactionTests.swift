import CryptoKit
import Foundation
import XCTest
import Evidence
@testable import Spool

class TextCompactionTests: SpoolFormCase {

    static let base: TimeInterval = 1_790_262_600
    static let window: TimeInterval = 300

    static func frame(at seconds: TimeInterval, display: UInt32 = 1, tree: Int = 0, nodes: Int = 40,
                      ocr: [String] = ["SYNTHETIC TEXT"], accessibility: Bool = true) -> CaptureObservation {
        let date = Date(timeIntervalSince1970: seconds)
        let app = CaptureApplication(bundleID: "com.example.browser", name: "Example \"Quoted\" Browser", pid: 4242)
        let bounds = CaptureRect(x: 0, y: 25, width: 640.5, height: 455)
        var observation = CaptureObservation(capturedAt: date, displayID: display, width: 64, height: 48, application: app,
            windows: [CaptureWindow(windowID: 11, title: "Synthetic / window \\ \(tree)", application: app, bounds: bounds),
                      CaptureWindow(windowID: 12, title: nil, application: app, bounds: bounds, site: "example.com")],
            ocr: ocr.enumerated().map { TextObservation(text: $1, confidence: 0.3 + Float($0) * 0.01,
                                                       bounds: CaptureRect(x: 0.125, y: 0.1, width: 0.5, height: 0.0625)) },
            reason: "foreground-pid-matched-around-image-acquisition; non-atomic-observation",
            capturedUntil: date.addingTimeInterval(0.031_25), displayBounds: CaptureRect(x: 0, y: 0, width: 640, height: 480),
            ocrStatus: "complete-full-pixels-changed")
        if accessibility {
            var tree = AccessibilitySnapshot(
                capturedAt: date.addingTimeInterval(0.040_2), status: "complete-scoped-app-reported",
                nodes: (0..<nodes).map { index in
                    AccessibilityNode(role: index == 0 ? "AXWindow" : "AXStaticText",
                                      text: "SYNTHETIC ROW \(tree)-\(index) \u{e9}t\u{e9} \u{1F600} \"q\" \n line",
                                      bounds: CaptureRect(x: 10, y: Double(60 + index) + 0.1, width: 600, height: 18),
                                      depth: index == 0 ? 0 : 1, value: index % 3 == 0 ? "VALUE \(index)" : nil,
                                      url: index == 1 ? "https://example.com/a/b?c=d" : nil)
                },
                capturedUntil: date.addingTimeInterval(0.090_7))
            tree.limitReasons = []
            tree.windowCorrelation = "unique-pid-and-window-geometry"
            observation.accessibility = tree
        }
        observation.inputIdleSeconds = 1.5 + seconds.truncatingRemainder(dividingBy: 1)
        return observation
    }

    @discardableResult
    private func append(_ store: CaptureStore, _ observation: CaptureObservation) throws -> String {
        try store.append(observation: observation, image: nil)
        return try XCTUnwrap(try paths(of: store).last)
    }

    private func paths(of store: CaptureStore) throws -> [String] {
        try store.days(since: nil).flatMap { day in
            try FileManager.default.contentsOfDirectory(atPath: day.path)
                .filter { !$0.hasPrefix(".") }.sorted().map { day.lastPathComponent + "/" + $0 }
        }
    }

    private func packet(_ path: String, in directory: URL) throws -> Data {
        try MetadataCodec.decode(kept(directory.appendingPathComponent(path).appendingPathComponent("observation.lsm")))
    }

    private func compact(_ store: CaptureStore, until seconds: TimeInterval, maximumRawBytes: Int = ScreenText.maximumRawBytes,
                         interrupt: ((TextCompaction.Stage) throws -> Void)? = nil) throws -> TextCompactionReport {
        try TextCompaction.compact(store: store, now: Date(timeIntervalSince1970: seconds),
                                   maximumRawBytes: maximumRawBytes, interrupt: interrupt)
    }

    struct Published {
        let manifest: ScreenText.Manifest
        let segment: ScreenText.Segment
        let regionBytes: Int
    }

    private func published(in directory: URL) throws -> [Published] {
        let text = directory.appendingPathComponent(".text")
        guard FileManager.default.fileExists(atPath: text.path) else { return [] }
        let names = try FileManager.default.contentsOfDirectory(atPath: text.path).sorted()
        let manifests = try names.filter { $0.hasSuffix(".json") }.map { name in
            try assertInForm(text.appendingPathComponent(name))
            return try XCTUnwrap(ScreenText.Manifest.decode(try kept(text.appendingPathComponent(name))), name)
        }
        XCTAssertEqual(Set(names).subtracting(["position"]),
                       Set(manifests.flatMap { [$0.segment, String($0.segment.dropLast(7)) + ".json"] }),
                       "only published segments, their manifests and the position: no staging, no orphan")
        return try manifests.map { manifest in
            try assertInForm(text.appendingPathComponent(manifest.segment))
            let file = try kept(text.appendingPathComponent(manifest.segment))
            XCTAssertEqual(Data(SHA256.hash(data: file)), manifest.segmentSHA256)
            let body = try ScreenText.decompress(file)
            let segment = try ScreenText.Segment(body: body)
            XCTAssertEqual(segment.window, manifest.window)
            XCTAssertEqual(segment.frames.map(\.bundle), manifest.frames.map(\.bundle))
            let newline = try XCTUnwrap(body.firstIndex(of: 0x0A))
            return Published(manifest: manifest, segment: segment, regionBytes: body.count - newline - 1)
        }.sorted { $0.manifest.window.start < $1.manifest.window.start }
    }

    @discardableResult
    private func assertEveryFrameRebuilds(in directory: URL, _ segments: [Published]) throws -> [String] {
        var held: [String] = []
        for published in segments {
            for (ordinal, frame) in published.segment.frames.enumerated() {
                let json = try packet(frame.bundle, in: directory)
                XCTAssertEqual(frame.observationSHA256, ScreenText.hex(SHA256.hash(data: json)))
                XCTAssertEqual(published.manifest.frames[ordinal].observationSHA256, frame.observationSHA256)
                var reduced = Data()
                var cursor = 0
                var inserted = 0
                for splice in frame.splices.reversed() {
                    let piece = splice.before + (try XCTUnwrap(published.segment.array(splice.array))) + splice.after
                    let start = splice.at + inserted
                    XCTAssertEqual(json[start..<(start + piece.count)], piece, "the span is where the header says")
                    reduced.append(json[cursor..<start])
                    cursor = start + piece.count
                    inserted += piece.count
                }
                reduced.append(json[cursor...])
                XCTAssertEqual(reduced, ScreenText.reduce(json)?.reduced)
                let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: reduced) as? [String: Any])
                XCTAssertNil(object["ocr"])
                XCTAssertNil(object["windows"])
                if let accessibility = object["accessibility"] as? [String: Any] {
                    XCTAssertNil(accessibility["nodes"])
                    XCTAssertNotNil(accessibility["capturedAt"], "the snapshot keeps its own members")
                }
                XCTAssertEqual(published.segment.rebuild(ordinal: ordinal, reduced: reduced), json, "byte for byte")
                XCTAssertTrue(published.segment.proves(ordinal: ordinal, reduced: reduced,
                                                       observationSHA256: frame.observationSHA256))
                held.append(frame.bundle)
            }
        }
        XCTAssertEqual(held.count, Set(held).count, "no frame is in two segments")
        return held
    }


    func testEveryCapturedFrameOfEachWindowRebuildsByteForByteAcrossDisplays() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let start = Self.base
        var frames: [String] = []
        frames.append(try append(store, Self.frame(at: start + 0.000_1, display: 1, tree: 1, nodes: 3_000,
                                                   ocr: (0..<200).map { "SYNTHETIC LINE \($0)" })))
        frames.append(try append(store, Self.frame(at: start + 0.000_2, display: 2, tree: 2)))
        try append(store, .gap(at: Date(timeIntervalSince1970: start + 2), reason: "display_asleep_or_session_inactive"))
        frames.append(try append(store, Self.frame(at: start + 2.5, display: 1, tree: 1, nodes: 3_000,
                                                   ocr: (0..<200).map { "SYNTHETIC LINE \($0)" })))
        frames.append(try append(store, Self.frame(at: start + 4.25, display: 2, tree: 3, accessibility: false)))
        var activity = CaptureObservation(capturedAt: Date(timeIntervalSince1970: start + 6), displayID: 0, width: 0, height: 0,
            windows: [CaptureWindow(windowID: 9, title: nil, application: nil, bounds: CaptureRect(x: 0, y: 0, width: 10, height: 10))],
            status: ObservationStatus.activityOnly.rawValue, reason: CaptureGapReason.foregroundAppActivityOnly.rawValue)
        activity.inputIdleSeconds = 3
        try append(store, activity)
        frames.append(try append(store, Self.frame(at: start + Self.window - 0.01, display: 1, tree: 4)))
        let next = try append(store, Self.frame(at: start + Self.window + 0.000_1, display: 2, tree: 4))

        XCTAssertEqual(try compact(store, until: start + 2 * Self.window + 31).segmentCount, 2)
        let segments = try published(in: root)
        XCTAssertEqual(segments.map(\.manifest.window), [
            ScreenText.Window(start: Int(start) * 1_000_000, end: Int(start + Self.window) * 1_000_000),
            ScreenText.Window(start: Int(start + Self.window) * 1_000_000, end: Int(start + 2 * Self.window) * 1_000_000),
        ])
        XCTAssertEqual(segments[0].manifest.frames.map(\.bundle), frames, "both displays, folder order, no gap, no activity")
        XCTAssertEqual(segments[1].manifest.frames.map(\.bundle), [next])
        try assertEveryFrameRebuilds(in: root, segments)
        let first = segments[0].segment.frames
        XCTAssertEqual(first[0].splices.map(\.array), first[2].splices.map(\.array))
        XCTAssertNotEqual(first[0].splices.map(\.array), first[1].splices.map(\.array))
        XCTAssertEqual(first[3].splices.count, 2, "a frame with no tree moves its OCR and windows")
        XCTAssertEqual(first[0].splices.map(\.before), [Data(#","windows":"#.utf8), Data(#","ocr":"#.utf8), Data(#","nodes":"#.utf8)])
        XCTAssertEqual(first[0].splices.map(\.after), [Data(), Data(), Data()])
    }

    func testAWindowIsCompactedOnlyOnceItEndedAndTheGracePassed() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        try append(store, Self.frame(at: Self.base + 10))
        XCTAssertEqual(try compact(store, until: Self.base + Self.window + 29).windowCount, 0)
        XCTAssertTrue(try published(in: root).isEmpty)
        XCTAssertEqual(try compact(store, until: Self.base + Self.window + 31).segmentCount, 1)
    }

    func testAFramePublishedAfterItsWindowWasCompactedIsNeverAddedAndARestartCompactsNothingAgain() throws {
        var store: CaptureStore? = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let early = try append(store!, Self.frame(at: Self.base + 10))
        XCTAssertEqual(try compact(store!, until: Self.base + Self.window + 31).segmentCount, 1)
        let late = try append(store!, Self.frame(at: Self.base + 20, tree: 9))
        XCTAssertEqual(try compact(store!, until: Self.base + Self.window + 60).segmentCount, 0)
        store = nil
        let reopened = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        XCTAssertEqual(try compact(reopened, until: Self.base + 3 * Self.window).segmentCount, 0,
                       "the published window is the cursor: nothing before it is compacted again")
        let segments = try published(in: root)
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(try assertEveryFrameRebuilds(in: root, segments), [early])
        XCTAssertFalse(segments[0].manifest.frames.map(\.bundle).contains(late), "it ships inline")
        let later = try append(reopened, Self.frame(at: Self.base + 2 * Self.window + 1))
        XCTAssertEqual(try compact(reopened, until: Self.base + 3 * Self.window + 31).segmentCount, 1)
        XCTAssertEqual(try assertEveryFrameRebuilds(in: root, try published(in: root)), [early, later])
    }

    func testAnUnreadablePacketIsLeftOutAndTheWindowGoesOn() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let kept = try append(store, Self.frame(at: Self.base + 1))
        let corrupt = try append(store, Self.frame(at: Self.base + 3, tree: 1))
        let notJSON = try append(store, Self.frame(at: Self.base + 5, tree: 2))
        let last = try append(store, Self.frame(at: Self.base + 7, tree: 3))
        let corruptFile = root.appendingPathComponent(corrupt).appendingPathComponent("observation.lsm")
        var bytes = try Data(contentsOf: corruptFile)
        bytes[bytes.count / 2] ^= 0xFF
        try bytes.write(to: corruptFile)
        let notJSONFile = root.appendingPathComponent(notJSON).appendingPathComponent("observation.lsm")
        try FileManager.default.removeItem(at: notJSONFile)
        try keep(MetadataCodec.encode(Data(#"{"status":"captured","ocr":[1,2"#.utf8)), at: notJSONFile)
        XCTAssertEqual(try compact(store, until: Self.base + Self.window + 31).segmentCount, 1)
        XCTAssertEqual(try assertEveryFrameRebuilds(in: root, try published(in: root)), [kept, last])
    }

    func testAWindowWhoseArraysWouldPass64MiBClosesAtTheFrameBefore() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let line = String(repeating: "SYNTHETIC OCR WORDS ", count: 5_000)
        var frames: [String] = []
        for index in 0..<5 {
            let ocr = (0..<150).map { "\(index)-\($0) " + line }
            frames.append(try append(store, Self.frame(at: Self.base + 10 + Double(index) * 2, tree: index, nodes: 2, ocr: ocr)))
        }
        frames.append(try append(store, Self.frame(at: Self.base + 30, tree: 4, nodes: 2,
                                                   ocr: (0..<150).map { "4-\($0) " + line })))
        let report = try compact(store, until: Self.base + Self.window + 31)
        XCTAssertEqual(report.segmentCount, 2)
        let segments = try published(in: root)
        XCTAssertEqual(segments.map { $0.manifest.frames.map(\.bundle) }, [Array(frames.prefix(4)), Array(frames.suffix(2))])
        for segment in segments { XCTAssertLessThanOrEqual(segment.regionBytes, ScreenText.maximumRawBytes) }
        XCTAssertGreaterThan(segments[0].regionBytes, 48 * 1024 * 1024)
        let cut = try XCTUnwrap(SpoolLayout.indexedMicroseconds(ofBundle: String(frames[4].split(separator: "/")[1])))
        XCTAssertEqual(segments.map(\.manifest.window), [
            ScreenText.Window(start: Int(Self.base) * 1_000_000, end: cut),
            ScreenText.Window(start: cut, end: Int(Self.base + Self.window) * 1_000_000),
        ], "the two segments' windows meet at the cut and cover the window")
        try assertEveryFrameRebuilds(in: root, segments)
    }

    func testACutWindowInterruptedBetweenItsSegmentsResumesAtTheCut() throws {
        enum SimulatedDeath: Error { case interrupted }
        var frames: [String] = []
        do {
            let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
            for index in 0..<5 {
                frames.append(try append(store, Self.frame(at: Self.base + 10 + Double(index), tree: index, nodes: 200)))
            }
            let one = try XCTUnwrap(try ScreenText.reduce(packet(frames[0], in: root))).moved.map(\.array.count).reduce(0, +)
            var prepared = 0
            XCTAssertThrowsError(try compact(store, until: Self.base + Self.window + 31, maximumRawBytes: one * 2 + one / 2,
                                             interrupt: { stage in
                if stage == .prepared { prepared += 1 }
                if stage == .prepared, prepared == 2 { throw SimulatedDeath.interrupted }
            }))
        }
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let one = try XCTUnwrap(try ScreenText.reduce(packet(frames[0], in: root))).moved.map(\.array.count).reduce(0, +)
        _ = try compact(store, until: Self.base + Self.window + 31, maximumRawBytes: one * 2 + one / 2)
        let segments = try published(in: root)
        XCTAssertEqual(segments.map { $0.manifest.frames.map(\.bundle) }, [Array(frames[0..<2]), Array(frames[2..<4]), [frames[4]]])
        try assertEveryFrameRebuilds(in: root, segments)
    }


    private func position(in directory: URL? = nil) throws -> Int? {
        try TextCompaction.readPosition(in: (directory ?? root).appendingPathComponent(".text"), files: files)
    }

    private static func micros(_ seconds: TimeInterval) -> Int {
        Int(seconds) * 1_000_000
    }

    func testThePositionIsTheEndOfTheLastWindowFinishedPublishedEmptyOrFailedAndOnlyMovesForward() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        XCTAssertNil(try position(), "the writer makes .text/; nothing is finished yet")
        try append(store, Self.frame(at: Self.base + 1))
        try append(store, .gap(at: Date(timeIntervalSince1970: Self.base + Self.window + 1), reason: "display_asleep_or_session_inactive"))
        try append(store, Self.frame(at: Self.base + 2 * Self.window + 1, tree: 2))
        var windows = 0
        let report = try TextCompaction.compact(store: store, now: Date(timeIntervalSince1970: Self.base + 3 * Self.window + 31),
                                                prove: { file, window, frames in
            windows += 1
            return windows == 1 && TextCompaction.prove(file, window, frames)
        })
        XCTAssertEqual(report.windowCount, 3)
        XCTAssertEqual(report.segmentCount, 1)
        XCTAssertEqual(report.unprovenSegmentCount, 1)
        XCTAssertEqual(try position(), Self.micros(Self.base + 3 * Self.window), "past the failed window too")
        let text = root.appendingPathComponent(".text")
        try TextCompaction.advancePosition(to: Self.micros(Self.base), in: text, files: files)
        XCTAssertEqual(try position(), Self.micros(Self.base + 3 * Self.window))
        try Data("123".utf8).write(to: text.appendingPathComponent("position.tmp"))
        try TextCompaction.advancePosition(to: Self.micros(Self.base + 4 * Self.window), in: text, files: files)
        try assertInForm(text.appendingPathComponent("position"))
        XCTAssertEqual(try position(), Self.micros(Self.base + 4 * Self.window))
        XCTAssertFalse(FileManager.default.fileExists(atPath: text.appendingPathComponent("position.tmp").path))
    }

    func testAWindowWhoseProofFailedIsNeverCompactedAgainAfterARestart() throws {
        let failed: String
        do {
            let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
            failed = try append(store, Self.frame(at: Self.base + 1))
            let report = try TextCompaction.compact(store: store, now: Date(timeIntervalSince1970: Self.base + Self.window + 31),
                                                    prove: { _, _, _ in false })
            XCTAssertEqual(report.unprovenSegmentCount, 1)
        }
        let reopened = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let later = try append(reopened, Self.frame(at: Self.base + Self.window + 1, tree: 1))
        XCTAssertEqual(try compact(reopened, until: Self.base + 3 * Self.window).segmentCount, 1)
        let segments = try published(in: root)
        XCTAssertEqual(try assertEveryFrameRebuilds(in: root, segments), [later], "the failed window is not rebuilt: no orphan")
        XCTAssertFalse(segments.flatMap { $0.manifest.frames.map(\.bundle) }.contains(failed))
    }

    func testARestartResumesFromTheCutWhenTheNewestManifestReachesPastThePosition() throws {
        try testACutWindowInterruptedBetweenItsSegmentsResumesAtTheCut()
        XCTAssertEqual(try position(), Self.micros(Self.base + Self.window))
    }


    func testACrashAtEveryPublicationStepRecoversWithNoDuplicateAndNoLoss() throws {
        enum SimulatedDeath: Error { case interrupted }
        for (index, stage) in TextCompaction.Stage.allCases.enumerated() {
            let directory = root.appendingPathComponent("stage-\(index)")
            var frames: [String] = []
            do {
                let store = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
                for second in [1.0, 3.0, 5.0] {
                    try store.append(observation: Self.frame(at: Self.base + second, tree: Int(second)), image: nil)
                }
                frames = try paths(of: store)
                XCTAssertThrowsError(try compact(store, until: Self.base + Self.window + 31, interrupt: { reached in
                    if reached == stage { throw SimulatedDeath.interrupted }
                }))
            }
            let reopened = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            _ = try compact(reopened, until: Self.base + Self.window + 31)
            let segments = try published(in: directory)
            XCTAssertEqual(segments.count, 1, "\(stage)")
            XCTAssertEqual(try assertEveryFrameRebuilds(in: directory, segments), frames, "\(stage)")
            XCTAssertEqual(try compact(reopened, until: Self.base + 4 * Self.window).segmentCount, 0)
            XCTAssertEqual(try published(in: directory).count, 1)
        }
    }

    func testTheSameWriterRecoversAfterAFailedPublication() throws {
        enum SimulatedFailure: Error { case interrupted }
        for stage in TextCompaction.Stage.allCases {
            let directory = root.appendingPathComponent("same-\(stage)")
            let store = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            try store.append(observation: Self.frame(at: Self.base + 1), image: nil)
            XCTAssertThrowsError(try compact(store, until: Self.base + Self.window + 31, interrupt: { reached in
                if reached == stage { throw SimulatedFailure.interrupted }
            }))
            _ = try compact(store, until: Self.base + Self.window + 31)
            XCTAssertEqual(try assertEveryFrameRebuilds(in: directory, try published(in: directory)).count, 1, "\(stage)")
        }
    }

    func testAStagingWithoutAJournalOrWithOneThatNoLongerVerifiesIsDiscardedAndTheWindowCompactedAgain() throws {
        enum SimulatedDeath: Error { case interrupted }
        let frame: String
        do {
            let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
            frame = try append(store, Self.frame(at: Self.base + 1))
            XCTAssertThrowsError(try compact(store, until: Self.base + Self.window + 31, interrupt: { reached in
                if reached == .segmentPublished { throw SimulatedDeath.interrupted }
            }))
        }
        let text = root.appendingPathComponent(".text")
        let staging = try XCTUnwrap(try FileManager.default.contentsOfDirectory(atPath: text.path).first { $0.hasPrefix(".pending-") })
        let journalURL = text.appendingPathComponent(staging).appendingPathComponent("journal.json")
        var journal = try JSONSerialization.jsonObject(with: kept(journalURL)) as! [String: Any]
        journal["segmentSHA256"] = Data(repeating: 7, count: 32).base64EncodedString()
        try keep(JSONSerialization.data(withJSONObject: journal), at: journalURL)
        try FileManager.default.createDirectory(at: text.appendingPathComponent(".pending-" + UUID().uuidString.lowercased()),
                                                withIntermediateDirectories: false)
        let reopened = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        XCTAssertEqual(try compact(reopened, until: Self.base + Self.window + 31).segmentCount, 1)
        XCTAssertEqual(try assertEveryFrameRebuilds(in: root, try published(in: root)), [frame])
    }

    func testPublicationNeverHoldsTheAppendLock() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        try append(store, Self.frame(at: Self.base + 1))
        var appended = 0
        _ = try compact(store, until: Self.base + Self.window + 31, interrupt: { _ in
            try store.append(observation: Self.frame(at: Self.base + 2 * Self.window + Double(appended)), image: nil)
            appended += 1
        })
        XCTAssertEqual(appended, TextCompaction.Stage.allCases.count)
    }

    func testAReadOnlyStoreNeverCompactsAndOnePassRunsAtATime() async throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        try append(store, Self.frame(at: Self.base + 1))
        let reader = try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true)
        XCTAssertThrowsError(try compact(reader, until: Self.base + Self.window + 31))
        XCTAssertThrowsError(try TextCompactionPermit.withPermit { try TextCompactionPermit.withPermit { 0 } }) { error in
            guard case TextCompactionError.busy = error else { return XCTFail("\(error)") }
        }
        let report = try await store.compactText()
        XCTAssertEqual(report.segmentCount, 1)
    }
}

final class TextCompactionKeyedTests: TextCompactionTests {
    override class var keyed: Bool { true }
}
