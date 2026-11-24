import CoreGraphics
import DeviceFiles
import CryptoKit
import Evidence
import Foundation
import XCTest
import Spool
@testable import Shipping

final class ScreenBundleFixtureTests: XCTestCase {
    private var root: URL!
    private var spool: URL { root.appendingPathComponent("Lifestream Screen", isDirectory: true) }

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("screen-bundle-fixture-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    static let source = "screen:local:synthetic-mac-0001"
    static let base = Date(timeIntervalSince1970: 1_790_262_903.603_518)
    static let fetchedAt = "2026-09-24T17:30:00.250Z"
    static let largeTreeNodes = 600

    static var fixture: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/connect/macos-app/screen/test/recorder-bundle.zip")
    }

    func testTheRealSpoolSealsABundleWhoseSegmentsAndRunShip() async throws {
        let (sealed, observations) = try await sealRealSpool()
        let zip = try StoredZipReader(sealed.file)
        let text = try XCTUnwrap(zip.text("observations.jsonl"))
        let raw = text.split(separator: "\n").map { Data($0.utf8) }
        let lines = try raw.map { try XCTUnwrap(try JSONSerialization.jsonObject(with: $0) as? [String: Any]) }
        XCTAssertEqual(lines.count, 6)
        func named(by line: [String: Any]) throws -> (name: String, bytes: Data, hex: String) {
            let reference = try XCTUnwrap((line["archive"] as? [String: Any])?["reference"] as? [String: Any])
            let path = try XCTUnwrap(reference["segment"] as? String)
            let bytes = try Data(contentsOf: spool.appendingPathComponent(path))
            return (String(path.dropFirst(".video/".count)), bytes, Self.hex(Data(SHA256.hash(data: bytes))))
        }
        let (movie, movieBytes, movieHex) = try named(by: lines[1])
        let late = try named(by: lines[5])
        XCTAssertNotEqual(late.hex, movieHex, "the late frame is in a segment of its own")
        let segment = try XCTUnwrap(try FileManager.default.contentsOfDirectory(atPath: spool.appendingPathComponent(".text").path)
            .first { $0.hasSuffix(".lstext") })
        let segmentBytes = try Data(contentsOf: spool.appendingPathComponent(".text").appendingPathComponent(segment))
        let segmentHex = Self.hex(Data(SHA256.hash(data: segmentBytes)))

        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(zip.text("manifest.json")).utf8))
            as? [String: Any])
        let facts = try XCTUnwrap(manifest["facts"] as? [String: Any])
        XCTAssertEqual(facts["observations"] as? Int, 8)
        XCTAssertEqual(facts["metadata_unreadable"] as? Int, 0)
        XCTAssertEqual(facts["frames_archived"] as? Int, 3)
        XCTAssertNil(facts["frames_pending"], "the Mac sends no pending image")
        XCTAssertEqual(facts["segments"] as? Int, 2, "two frames in one video segment, the late one in another")
        XCTAssertEqual(facts["segments_missing"] as? Int, 0, "a good segment is never missing")
        XCTAssertEqual(facts["frames_text"] as? Int, 2)
        XCTAssertEqual(facts["text_segments"] as? Int, 1)
        XCTAssertEqual(facts["text_unproven"] as? Int, 0)
        XCTAssertEqual(facts["gap_runs"] as? Int, 1)
        XCTAssertEqual(facts["blobs_carried"] as? Int, 3, "the two video segments and the text segment")

        XCTAssertEqual(zip.bytes("blobs/\(movieHex)"), movieBytes)
        XCTAssertEqual(zip.bytes("blobs/\(late.hex)"), late.bytes)
        XCTAssertEqual(zip.bytes("blobs/\(segmentHex)"), segmentBytes)
        let ledgers = Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain))
        let carried = try DomainFixtures.entry(ScreenSpoolDomain.ScreenEntry.self, of: sealed, ledgers: ledgers).blobs
        XCTAssertTrue(carried.contains(movieHex))
        XCTAssertTrue(carried.contains(segmentHex))
        XCTAssertTrue(carried.contains(late.hex))
        let run = try XCTUnwrap(lines[0]["run"] as? [String: Any])
        let attempts = try XCTUnwrap(run["attempts"] as? [[Any]])
        XCTAssertEqual(attempts.map { $0[0] as? String }, observations.prefix(3).map { Optional($0) })
        XCTAssertEqual(Set(lines[0].keys), ["bundle", "observation", "run"])
        for line in lines[1...2] {
            let archive = try XCTUnwrap(line["archive"] as? [String: Any])
            let reference = try XCTUnwrap(archive["reference"] as? [String: Any])
            XCTAssertEqual(reference["segmentSHA256"] as? String, Data(SHA256.hash(data: movieBytes)).base64EncodedString())
            XCTAssertEqual(reference["segment"] as? String, ".video/" + movie)
            XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(archive["metadataSHA256"] as? String))?.count, 32)
            let textReference = try XCTUnwrap(line["text"] as? [String: Any])
            XCTAssertEqual(textReference["segment"] as? String, segment)
            XCTAssertEqual(textReference["segmentSHA256"] as? String, Data(SHA256.hash(data: segmentBytes)).base64EncodedString())
            XCTAssertEqual(textReference["segmentBytes"] as? Int, segmentBytes.count)
            XCTAssertNil((line["observation"] as? [String: Any])?["ocr"], "the text moved to the segment")
            XCTAssertNotNil((line["observation"] as? [String: Any])?["frontWindow"], "the front window is not text: it stays")
        }
        XCTAssertLessThan(raw[2].count, 4_000, "the large tree no longer rides in the line")
        XCTAssertTrue(lines[3]["run"] is NSNull)
        XCTAssertEqual((lines[4]["observation"] as? [String: Any])?["status"] as? String, "activity_only")
        XCTAssertEqual(((lines[4]["observation"] as? [String: Any])?["frontWindow"] as? [String: Any])?["windowID"] as? Int, 12)
        XCTAssertTrue(lines[4]["text"] is NSNull)
        XCTAssertTrue(lines[5]["text"] is NSNull, "published after its window was compacted")
        XCTAssertNotNil((lines[5]["observation"] as? [String: Any])?["ocr"])
        XCTAssertTrue(lines.allSatisfy { $0["pending"] == nil || $0["pending"] is NSNull }, "no line carries a pending image")

        let body = try ScreenText.decompress(segmentBytes)
        let text0 = try ScreenText.Segment(body: body)
        var rebuilt: [Data] = []
        for (line, bytes) in Swift.zip(lines, raw) {
            let observation = try XCTUnwrap(ObservationBytes.member("observation", of: bytes))
            if let run = line["run"] as? [String: Any] {
                let first = try XCTUnwrap(GapAttempt(observation))
                for attempt in try XCTUnwrap(run["attempts"] as? [[Any]]) {
                    rebuilt.append(try XCTUnwrap(first.rebuild(attempt.dropFirst().map { $0 as? String })))
                }
            } else if let reference = line["text"] as? [String: Any] {
                rebuilt.append(try XCTUnwrap(text0.rebuild(ordinal: try XCTUnwrap(reference["ordinal"] as? Int), reduced: observation)))
            } else {
                rebuilt.append(observation)
            }
        }
        XCTAssertEqual(rebuilt, try observations.map { try MetadataCodec.decode(Data(contentsOf: spool
            .appendingPathComponent($0).appendingPathComponent("observation.lsm"))) })

        if ProcessInfo.processInfo.environment["LIFESTREAM_WRITE_FIXTURES"] == "1" {
            try FileManager.default.createDirectory(at: Self.fixture.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: Self.fixture)
            try FileManager.default.copyItem(at: sealed.file, to: Self.fixture)
        }
        let checkedIn = try StoredZipReader(Self.fixture)
        XCTAssertEqual(checkedIn.names.map(Self.shape), zip.names.map(Self.shape))
        for member in ["observations.jsonl", "manifest.json"] {
            XCTAssertEqual(Self.shape(try XCTUnwrap(checkedIn.text(member))), Self.shape(try XCTUnwrap(zip.text(member))),
                           "\(member) changed shape: rewrite the fixture and make the home read it")
        }
    }


    private func sealRealSpool() async throws -> (SealedBundle, [String]) {
        let store = try CaptureStore(directory: spool, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.65)
        for offset in [0, 2.000_3, 4.000_5] {
            try store.append(observation: Self.gap(at: Self.base.addingTimeInterval(offset), reason: "display_asleep_or_session_inactive"),
                             image: nil)
        }
        try store.append(observation: Self.frame(at: Self.base.addingTimeInterval(6.000_4), nodes: 2), image: .raw(Self.pixels(90)))
        try store.append(observation: Self.frame(at: Self.base.addingTimeInterval(8.000_7), nodes: Self.largeTreeNodes),
                         image: .raw(Self.pixels(120)))
        _ = try await store.compactPendingVideo(flush: true)
        let fetchedAt = try DomainFixtures.instant(Self.fetchedAt)
        let text = try await store.compactText(now: fetchedAt)
        XCTAssertEqual(text.segmentCount, 1)
        try store.append(observation: Self.gap(at: Self.base.addingTimeInterval(10.000_1), reason: "capture-deadline-missed"), image: nil)
        let chat = CaptureApplication(bundleID: "com.example.chat", name: "Example Chat", pid: 4343)
        var activity = CaptureObservation(capturedAt: Self.base.addingTimeInterval(12.000_1), displayID: 0,
            width: 0, height: 0, application: chat,
            windows: [CaptureWindow(windowID: 12, title: nil, application: chat, bounds: CaptureRect(x: 0, y: 25, width: 640, height: 455))],
            status: ObservationStatus.activityOnly.rawValue, reason: CaptureGapReason.foregroundAppActivityOnly.rawValue)
        activity.frontWindow = CaptureFrontWindow(windowID: 12)
        try store.append(observation: activity, image: nil)
        try store.append(observation: Self.frame(at: Self.base.addingTimeInterval(14.000_9), nodes: 3), image: .raw(Self.pixels(150)))
        _ = try await store.compactPendingVideo(flush: true)

        let domain = ScreenSpoolDomain(sourceId: Self.source, spoolRoot: spool,
                                       ledgers: Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)), clock: { fetchedAt })
        let request = SealRequest(fetchedAt: fetchedAt, workDirectory: try DomainFixtures.directory(root.appendingPathComponent("work")), scratch: try DomainFixtures.directory(root.appendingPathComponent("work")),
                                  custody: ShippingFixture.first)
        let observations = try FileManager.default.contentsOfDirectory(atPath: spool.path)
            .filter { $0.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil }.sorted()
            .flatMap { day in
                try FileManager.default.contentsOfDirectory(atPath: spool.appendingPathComponent(day).path)
                    .filter { !$0.hasPrefix(".") }.sorted().map { day + "/" + $0 }
            }
        return (try XCTUnwrap(try domain.sealOne(request)), observations)
    }

    static func gap(at date: Date, reason: String) -> CaptureObservation {
        var observation = CaptureObservation.gap(at: date, reason: reason)
        observation.capturedUntil = date.addingTimeInterval(0.012_5)
        observation.inputIdleSeconds = 604.5 + date.timeIntervalSince(base)
        return observation
    }

    static func frame(at date: Date, nodes count: Int) -> CaptureObservation {
        let app = CaptureApplication(bundleID: "com.example.browser", name: "Example Browser", pid: 4242)
        let window = CaptureRect(x: 0, y: 25, width: 640, height: 455)
        var nodes = [AccessibilityNode(role: "AXWindow", text: "Synthetic window", bounds: window, depth: 0,
                                       subrole: "AXStandardWindow", title: "Synthetic window")]
        for index in 1..<max(2, count) {
            nodes.append(AccessibilityNode(role: index % 7 == 0 ? "AXLink" : "AXStaticText",
                                           text: "SYNTHETIC ROW \(index) lorem ipsum dolor sit amet, consectetur adipiscing elit",
                                           bounds: CaptureRect(x: 10, y: Double(60 + index), width: 600, height: 18),
                                           depth: 1 + (index - 1) % 3, value: "SYNTHETIC VALUE \(index)"))
        }
        var observation = CaptureObservation(capturedAt: date, displayID: 1, width: 64, height: 48, application: app,
            windows: [CaptureWindow(windowID: 11, title: "Synthetic window", application: app, bounds: window)],
            ocr: [TextObservation(text: "SYNTHETIC TEXT", confidence: 0.5, bounds: CaptureRect(x: 0.25, y: 0.5, width: 0.25, height: 0.125))],
            accessibility: AccessibilitySnapshot(capturedAt: date.addingTimeInterval(0.040_2), status: "complete-scoped-app-reported",
                                                 nodes: nodes, capturedUntil: date.addingTimeInterval(0.090_7)),
            reason: "foreground-pid-matched-around-image-acquisition; non-atomic-observation",
            capturedUntil: date.addingTimeInterval(0.031_25), displayBounds: CaptureRect(x: 0, y: 0, width: 640, height: 480),
            ocrStatus: "complete-full-pixels-changed")
        observation.inputIdleSeconds = 1.5
        observation.frontWindow = count == largeTreeNodes ? CaptureFrontWindow(cause: .noFocusedWindow)
            : CaptureFrontWindow(windowID: 11)
        return observation
    }

    static func pixels(_ level: UInt8) -> RawFrame {
        let width = 64, height = 48
        var bytes = Data(repeating: level, count: width * height * 4)
        for index in stride(from: 3, to: bytes.count, by: 4) { bytes[index] = 255 }
        let bitmap = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        return RawFrame(layout: FrameLayout(width: width, height: height, bytesPerRow: width * 4, bitmapInfo: bitmap,
                                            renderingIntent: 0, ICCData: CGColorSpace(name: CGColorSpace.sRGB)!.copyICCData()! as Data),
                        data: bytes)
    }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    static func shape(_ text: String) -> String {
        text.replacingOccurrences(of: #"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"#, with: "<uuid>",
                                  options: .regularExpression)
            .replacingOccurrences(of: #"\b[0-9a-f]{64}\b"#, with: "<hex-sha256>", options: .regularExpression)
            .replacingOccurrences(of: #""(?:[A-Za-z0-9+/]|\\/){43}=""#, with: "\"<base64-sha256>\"", options: .regularExpression)
            .replacingOccurrences(of: #""bytes":[0-9]+\}\],"facts""#, with: "\"bytes\":<n>}],\"facts\"", options: .regularExpression)
            .replacingOccurrences(of: #""segmentBytes":[0-9]+"#, with: "\"segmentBytes\":<n>", options: .regularExpression)
    }
}
