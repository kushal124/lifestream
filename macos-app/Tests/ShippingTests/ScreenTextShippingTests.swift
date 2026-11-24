import CryptoKit
import DeviceFiles
import Evidence
import Foundation
import XCTest
import Spool
@testable import Shipping

final class ScreenTextShippingTests: XCTestCase {
    private var root: URL!
    private var spool: URL { root.appendingPathComponent("Lifestream Screen", isDirectory: true) }
    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }
    private var received = 0

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("screen-text-shipping-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    static let source = "screen:local:synthetic-mac-0001"
    static let base: TimeInterval = 1_790_262_600


    private func store(_ directory: URL? = nil) throws -> CaptureStore {
        try CaptureStore(directory: directory ?? spool, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.65)
    }

    @discardableResult
    private func frame(_ store: CaptureStore, _ offset: TimeInterval, display: UInt32 = 1, tree: Int = 0, nodes: Int = 30,
                       ocr: [String] = ["SYNTHETIC TEXT"], image: UInt8? = nil) throws -> String {
        var observation = TextCompactionShapes.frame(at: Self.base + offset, display: display, tree: tree, nodes: nodes, ocr: ocr)
        if image != nil {
            observation.width = 64
            observation.height = 48
        }
        return try appended(store) {
            try store.append(observation: observation, image: image.map { .raw(ScreenBundleFixtureTests.pixels($0)) })
        }
    }

    @discardableResult
    private func gap(_ store: CaptureStore, _ offset: TimeInterval, reason: String = "display_asleep_or_session_inactive",
                     status: ObservationStatus = .gap, until: Bool = true) throws -> String {
        var observation = CaptureObservation.gap(at: Date(timeIntervalSince1970: Self.base + offset), reason: reason, status: status)
        if until { observation.capturedUntil = Date(timeIntervalSince1970: Self.base + offset + 0.012_345_6) }
        observation.inputIdleSeconds = 600.25 + offset / 7
        return try appended(store) { try store.append(observation: observation, image: nil) }
    }

    @discardableResult
    private func activity(_ store: CaptureStore, _ offset: TimeInterval) throws -> String {
        let app = CaptureApplication(bundleID: "com.example.chat", name: "Example Chat", pid: 4343)
        let observation = CaptureObservation(capturedAt: Date(timeIntervalSince1970: Self.base + offset), displayID: 0,
            width: 0, height: 0, application: app,
            windows: [CaptureWindow(windowID: 12, title: nil, application: app, bounds: CaptureRect(x: 0, y: 25, width: 640, height: 455))],
            status: ObservationStatus.activityOnly.rawValue, reason: CaptureGapReason.foregroundAppActivityOnly.rawValue)
        return try appended(store) { try store.append(observation: observation, image: nil) }
    }

    private func appended(_ store: CaptureStore, _ append: () throws -> Void) throws -> String {
        let before = Set(try paths(in: store.directory))
        try append()
        let added = try paths(in: store.directory).filter { !before.contains($0) }
        XCTAssertEqual(added.count, 1)
        return try XCTUnwrap(added.first)
    }

    private func paths(in directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil }.sorted().flatMap { day in
            try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent(day).path)
                .filter { !$0.hasPrefix(".") }.sorted().map { day + "/" + $0 }
        }
    }

    private func packet(_ path: String, in directory: URL? = nil) throws -> Data {
        try MetadataCodec.decode(Data(contentsOf: (directory ?? spool).appendingPathComponent(path).appendingPathComponent("observation.lsm")))
    }

    private func compactVideo(_ store: CaptureStore) async throws {
        while try await store.compactPendingVideo(flush: true).pendingImageCount > 0 {}
    }

    @discardableResult
    private func compactText(_ store: CaptureStore, until offset: TimeInterval) async throws -> TextCompactionReport {
        try await store.compactText(now: Date(timeIntervalSince1970: Self.base + offset))
    }


    private func domain(at offset: TimeInterval, limit: Int = ScreenSpoolDomain.maximumObservations,
                        directory: URL? = nil) -> ScreenSpoolDomain {
        let now = Date(timeIntervalSince1970: Self.base + offset)
        return ScreenSpoolDomain(sourceId: Self.source, spoolRoot: directory ?? spool, ledgers: ledgers,
                                 maximumObservations: limit, clock: { now })
    }

    private func seal(at offset: TimeInterval, after: Int? = nil, limit: Int = ScreenSpoolDomain.maximumObservations,
                      directory: URL? = nil) throws -> SealedBundle? {
        let request = SealRequest(fetchedAt: Date(timeIntervalSince1970: Self.base + offset),
                                  workDirectory: try DomainFixtures.directory(root.appendingPathComponent("work")), scratch: try DomainFixtures.directory(root.appendingPathComponent("work")),
                                  custody: SealCustody(pass: ShippingFixture.pass, received: after ?? received, imported: 0))
        let sealed = try domain(at: offset, limit: limit, directory: directory).sealOne(request)
        if let seal = sealed?.sidecar.seal { received = seal }
        return sealed
    }

    private func sealAll(at offset: TimeInterval, limit: Int = ScreenSpoolDomain.maximumObservations,
                         directory: URL? = nil) throws -> [SealedBundle] {
        var bundles: [SealedBundle] = []
        for read in 0... {
            let request = SealRequest(fetchedAt: Date(timeIntervalSince1970: Self.base + offset + Double(read) * 0.01),
                                      workDirectory: try DomainFixtures.directory(root.appendingPathComponent("work")), scratch: try DomainFixtures.directory(root.appendingPathComponent("work")),
                                      custody: SealCustody(pass: ShippingFixture.pass, received: received, imported: received))
            let sealed = try domain(at: offset, limit: limit, directory: directory).seal(request)
            guard let last = sealed.last?.sidecar.seal else { return bundles }
            bundles += sealed
            received = last
        }
        return bundles
    }

    private func entry(_ sealed: SealedBundle?) throws -> ScreenSpoolDomain.ScreenEntry {
        try DomainFixtures.entry(ScreenSpoolDomain.ScreenEntry.self, of: try XCTUnwrap(sealed), ledgers: ledgers)
    }

    enum Shape: Equatable {
        case reference(segment: String)
        case inline
        case gap
        case run(Int)
    }

    struct Line {
        let bundle: String
        let shape: Shape
        let observations: [(path: String, json: Data)]
    }

    private func read(_ bundles: [SealedBundle]) throws -> [Line] {
        var blobs: [String: Data] = [:]
        var lines: [Line] = []
        for sealed in bundles {
            let zip = try StoredZipReader(sealed.file)
            for name in zip.names where name.hasPrefix("blobs/") {
                let bytes = try XCTUnwrap(zip.bytes(name))
                XCTAssertEqual(ScreenText.hex(SHA256.hash(data: bytes)), String(name.dropFirst(6)), "a blob is named by its hex")
                blobs[String(name.dropFirst(6))] = bytes
            }
            for raw in try XCTUnwrap(zip.bytes("observations.jsonl")).split(separator: 0x0A) {
                lines.append(try readLine(Data(raw), blobs: blobs))
            }
        }
        return lines
    }

    private func readLine(_ line: Data, blobs: [String: Data]) throws -> Line {
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        let bundle = try XCTUnwrap(object["bundle"] as? String)
        let observation = try XCTUnwrap(ObservationBytes.member("observation", of: line))
        let head = Data("{\"bundle\":\(JSONText.string(bundle).text),\"observation\":".utf8)
        XCTAssertEqual(line.prefix(head.count), head)
        let tail = String(decoding: line.dropFirst(head.count + observation.count), as: UTF8.self)
        if object.keys.contains("run") {
            XCTAssertEqual(Set(object.keys), ["bundle", "observation", "run"])
            XCTAssertTrue(tail.hasPrefix(",\"run\":"), "members in order")
            guard let run = object["run"] as? [String: Any] else {
                XCTAssertEqual(tail, ",\"run\":null}")
                return Line(bundle: bundle, shape: .gap, observations: [(bundle, observation)])
            }
            let attempts = try XCTUnwrap(run["attempts"] as? [[Any]])
            let first = try XCTUnwrap(GapAttempt(observation))
            var rebuilt: [(String, Data)] = []
            for attempt in attempts {
                XCTAssertEqual(attempt.count, 4)
                let path = try XCTUnwrap(attempt[0] as? String)
                let tokens = attempt.dropFirst().map { $0 as? String }
                rebuilt.append((path, try XCTUnwrap(first.rebuild(Array(tokens)))))
            }
            XCTAssertEqual(rebuilt.first?.0, bundle)
            XCTAssertEqual(rebuilt.first?.1, observation, "the first attempt is the line's observation")
            XCTAssertGreaterThan(attempts.count, 1, "a single gap states run null")
            return Line(bundle: bundle, shape: .run(attempts.count), observations: rebuilt)
        }
        XCTAssertEqual(Set(object.keys), ["bundle", "observation", "archive", "pending", "text"])
        XCTAssertNotNil(tail.range(of: #"^,"archive":.*,"pending":.*,"text":.*\}$"#, options: .regularExpression), "members in order")
        guard let text = object["text"] as? [String: Any] else {
            XCTAssertTrue(tail.hasSuffix(",\"text\":null}"))
            return Line(bundle: bundle, shape: .inline, observations: [(bundle, observation)])
        }
        XCTAssertEqual(text.count, 5)
        XCTAssertTrue(tail.contains(#","text":{"segment":"#), "reference members in order")
        let name = try XCTUnwrap(text["segment"] as? String)
        let hash = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(text["segmentSHA256"] as? String)))
        let file = try XCTUnwrap(blobs[ScreenText.hex(hash)], "the segment's blob travelled")
        XCTAssertEqual(text["segmentBytes"] as? Int, file.count)
        let segment = try ScreenText.Segment(body: ScreenText.decompress(file))
        let ordinal = try XCTUnwrap(text["ordinal"] as? Int)
        let digest = try XCTUnwrap(text["observationSHA256"] as? String)
        XCTAssertEqual(segment.frames[ordinal].bundle, bundle)
        XCTAssertTrue(segment.proves(ordinal: ordinal, reduced: observation, observationSHA256: digest))
        let rebuilt = try XCTUnwrap(segment.rebuild(ordinal: ordinal, reduced: observation))
        XCTAssertEqual(ScreenText.hex(SHA256.hash(data: rebuilt)), digest)
        return Line(bundle: bundle, shape: .reference(segment: name), observations: [(bundle, rebuilt)])
    }

    private func assertTheLinesRebuildTheSpool(_ lines: [Line], excluding left: Set<String> = [], directory: URL? = nil,
                                               file: StaticString = #filePath, line: UInt = #line) throws {
        let rebuilt = lines.flatMap(\.observations)
        let all = try paths(in: directory ?? spool)
        XCTAssertEqual(rebuilt.map(\.path).sorted(), all.filter { !left.contains($0) }, "no loss, no duplicate",
                       file: file, line: line)
        for (path, json) in rebuilt {
            XCTAssertEqual(json, try packet(path, in: directory), "\(path) rebuilds byte for byte", file: file, line: line)
        }
    }

    private func positionWritten(at offset: TimeInterval, in directory: URL? = nil) throws {
        let file = (directory ?? spool).appendingPathComponent(".text/position")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Self.base + offset)],
                                              ofItemAtPath: file.path)
    }

    private func facts(_ sealed: SealedBundle) throws -> [String: Any] {
        let manifest = try XCTUnwrap(try StoredZipReader(sealed.file).text("manifest.json"))
        return try XCTUnwrap((try JSONSerialization.jsonObject(with: Data(manifest.utf8)) as? [String: Any])?["facts"] as? [String: Any])
    }


    func testEveryFrameAndGapRebuildsByteForByteFromTheBundles() async throws {
        let store = try store()
        let tree = 600
        var expected: [String: Shape] = [:]
        let f1 = try frame(store, 0.000_1, display: 1, tree: 1, nodes: tree, ocr: (0..<80).map { "SYNTHETIC LINE \($0)" }, image: 90)
        let g1 = try gap(store, 1), g2 = try gap(store, 3), g3 = try gap(store, 5)
        let f2 = try frame(store, 6, display: 2, tree: 2, image: 120)
        let g4 = try gap(store, 7)
        let unreadable = try gap(store, 8)
        let g5 = try gap(store, 9), g6 = try gap(store, 11)
        let g7 = try gap(store, 11.5, until: false)
        let a1 = try activity(store, 12)
        let f3 = try frame(store, 299.999_9, display: 1, tree: 1, nodes: tree, image: 150)
        let f4 = try frame(store, 300.000_1, display: 2, tree: 4)
        let f5 = try frame(store, 302, display: 1, tree: 5)
        let f6 = try frame(store, 304, display: 2, tree: 6)
        let h1 = try gap(store, 2_996), h2 = try gap(store, 2_998), h3 = try gap(store, 3_000), h4 = try gap(store, 3_002)
        let f8 = try frame(store, 3_004, tree: 8)
        let e1 = try gap(store, 3_006, reason: CaptureGapReason.foregroundAppExcluded.rawValue, status: .excluded)
        let e2 = try gap(store, 3_008, reason: CaptureGapReason.foregroundAppExcluded.rawValue, status: .excluded)
        let g9 = try gap(store, 3_010, reason: "capture-deadline-missed")

        try await compactVideo(store)
        let report = try await compactText(store, until: 3_331)
        XCTAssertEqual(report.segmentCount, 3, "the first window, the second, the 16:00 window")
        let f7 = try frame(store, 306, display: 1, tree: 7)
        let damaged = spool.appendingPathComponent(unreadable).appendingPathComponent("observation.lsm")
        var bytes = try Data(contentsOf: damaged)
        bytes[20] ^= 0xFF
        try bytes.write(to: damaged)

        let bundles = try sealAll(at: 7_200, limit: 7)
        XCTAssertGreaterThan(bundles.count, 2)
        let lines = try read(bundles)
        try assertTheLinesRebuildTheSpool(lines, excluding: [unreadable])

        let shapes = Dictionary(uniqueKeysWithValues: lines.map { ($0.bundle, $0.shape) })
        let segment = { (path: String) -> String? in
            if case .reference(let name) = shapes[path] { return name }
            return nil
        }
        for path in [f1, f2, f3, f4, f5, f6, f8] { XCTAssertNotNil(segment(path), "\(path) ships by reference") }
        XCTAssertEqual(segment(f1), segment(f2), "one segment for both displays")
        XCTAssertEqual(segment(f2), segment(f3))
        XCTAssertEqual(segment(f4), segment(f5))
        XCTAssertEqual(segment(f5), segment(f6))
        XCTAssertNotEqual(segment(f3), segment(f4), "the window boundary")
        expected = [g1: .run(3), g4: .gap, g5: .run(2), g7: .gap, a1: .inline, f7: .inline,
                    h1: .run(2), h3: .run(2), e1: .run(2), g9: .gap]
        for (path, shape) in expected { XCTAssertEqual(shapes[path], shape, path) }
        XCTAssertNil(shapes[g2] ?? shapes[g3] ?? shapes[g6] ?? shapes[h2] ?? shapes[h4] ?? shapes[e2], "attempts are not lines")

        let all = try bundles.map(facts)
        let sum = { (name: String) in all.map { $0[name] as? Int ?? 0 }.reduce(0, +) }
        XCTAssertEqual(sum("frames_text"), 7)
        XCTAssertEqual(sum("text_unproven"), 0)
        XCTAssertEqual(sum("gap_runs"), 5)
        XCTAssertEqual(sum("metadata_unreadable"), 1)
        XCTAssertEqual(sum("observations"), try paths(in: spool).count - 1)
        XCTAssertEqual(sum("frames_archived"), 3)
        let carried = try bundles.flatMap { try entry($0).blobs }
        XCTAssertEqual(carried.count, Set(carried).count)
    }

    func testSealingTheSameSliceTwiceGivesTheSameLines() async throws {
        let store = try store()
        try frame(store, 1, tree: 1, image: 90)
        try gap(store, 2)
        try gap(store, 4)
        try frame(store, 5, tree: 2)
        try gap(store, 6)
        try await compactVideo(store)
        try await compactText(store, until: 331)
        let first = try XCTUnwrap(try seal(at: 3_700))
        let second = try XCTUnwrap(try seal(at: 3_701, after: 0))
        XCTAssertEqual(try StoredZipReader(first.file).bytes("observations.jsonl"),
                       try StoredZipReader(second.file).bytes("observations.jsonl"))
        try assertTheLinesRebuildTheSpool(try read([second]))
    }


    func testAFrameWaitsForItsWindowsCompactionOrAnHourAndNeverShipsBothWays() async throws {
        let store = try store()
        let gap = try gap(store, 5)
        let waiting = try frame(store, 10)
        let early = try XCTUnwrap(try seal(at: 400))
        XCTAssertEqual(try read([early]).map(\.bundle), [gap])
        XCTAssertEqual(try entry(early).through, gap)
        try await compactText(store, until: 400)
        let next = try XCTUnwrap(try seal(at: 401))
        XCTAssertEqual(try read([next]).map(\.shape).first.map { if case .reference = $0 { return true }; return false }, true)
        XCTAssertEqual(try entry(next).through, waiting)

        let orphan = try frame(store, 3_700)
        try positionWritten(at: 3_700)
        XCTAssertNil(try seal(at: 3_700 + 3_599))
        let late = try XCTUnwrap(try seal(at: 3_700 + 3_601))
        XCTAssertEqual(try read([late]).map(\.shape), [.inline])
        XCTAssertEqual(try entry(late).through, orphan)
        try assertTheLinesRebuildTheSpool(try read([early, next, late]))
    }

    func testASegmentThatDoesNotProveShipsItsFramesInlineAndOneTheHomeHoldsIsNotCarriedAgain() async throws {
        let store = try store()
        let one = try frame(store, 1, tree: 1), two = try frame(store, 3, tree: 2)
        try await compactText(store, until: 331)
        let text = spool.appendingPathComponent(".text")
        let name = try XCTUnwrap(try FileManager.default.contentsOfDirectory(atPath: text.path).first { $0.hasSuffix(".lstext") })
        let hex = ScreenText.hex(SHA256.hash(data: try Data(contentsOf: text.appendingPathComponent(name))))

        try ledgers.ledger(ScreenSpoolDomain.ScreenEntry.self, pass: ShippingFixture.pass, source: Self.source)
            .record(ScreenSpoolDomain.ScreenEntry(through: "", days: [:], segments: [:], blobs: [hex]), at: 1)
        received = 1
        let held = try XCTUnwrap(try seal(at: 400))
        XCTAssertEqual(try entry(held).blobs, [])
        XCTAssertEqual(try facts(held)["frames_text"] as? Int, 2)

        try Data("not a segment".utf8).write(to: text.appendingPathComponent(name))
        let sealed = try XCTUnwrap(try seal(at: 401, after: 1))
        let lines = try read([sealed])
        XCTAssertEqual(lines.map(\.shape), [.inline, .inline])
        XCTAssertEqual(lines.map(\.bundle), [one, two])
        XCTAssertEqual(try facts(sealed)["text_unproven"] as? Int, 2)
        XCTAssertEqual(try entry(sealed).blobs, [])
        try assertTheLinesRebuildTheSpool(lines)
    }


    func testARunShipsOnlyOnceSomethingEndsItOrItsHourIsOver() throws {
        let store = try store()
        let a = try gap(store, 2_940)
        try gap(store, 2_942)
        XCTAssertNil(try seal(at: 2_990), "the next gap may still continue it")
        XCTAssertNil(try seal(at: 3_029), "its hour is over, the grace is not")
        let hour = try XCTUnwrap(try seal(at: 3_031))
        XCTAssertEqual(try read([hour]).map(\.shape), [.run(2)])
        XCTAssertEqual(try entry(hour).through, try paths(in: spool).last)

        let b = try gap(store, 6_580)
        try gap(store, 6_582)
        let staged = try XCTUnwrap(b.split(separator: "/").first) + "/.pending-"
            + String(format: "%020.0f", (Self.base + 6_590) * 1_000_000) + "-" + UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(at: spool.appendingPathComponent(staged), withIntermediateDirectories: false)
        XCTAssertNil(try seal(at: 6_631))
        try FileManager.default.removeItem(at: spool.appendingPathComponent(staged))
        let held = try XCTUnwrap(try seal(at: 6_632))
        XCTAssertEqual(try read([held]).map(\.shape), [.run(2)])

        try gap(store, 7_300)
        try gap(store, 7_302)
        try frame(store, 7_304)
        let ended = try XCTUnwrap(try seal(at: 7_400))
        XCTAssertEqual(try read([ended]).map(\.shape), [.run(2)])
        XCTAssertNotEqual(a, b)
    }

    func testTheCapsEndABundleBeforeARunAndNeverInsideIt() throws {
        let store = try store()
        try gap(store, 1, reason: "capture-deadline-missed")
        for second in stride(from: 3.0, through: 9.0, by: 2) { try gap(store, second) }
        try gap(store, 10, reason: "capture-deadline-missed")
        let bundles = try sealAll(at: 3_700, limit: 3)
        XCTAssertEqual(try bundles.map { try read([$0]).map(\.shape) }, [[.gap], [.run(4)], [.gap]],
                       "the run of four passes the cap of three: it ships alone, whole")
        try assertTheLinesRebuildTheSpool(try read(bundles))
    }


    private func shapes(_ bundles: [SealedBundle]) throws -> [Shape] {
        try read(bundles).map(\.shape)
    }

    private func isReference(_ shape: Shape) -> Bool {
        if case .reference = shape { return true }
        return false
    }

    private func backlog(_ store: CaptureStore) throws -> [String] {
        try (0..<3).flatMap { day in
            try (0..<10).map { index in
                try frame(store, Double(day) * 86_400 + Double(index) * 600 + 1, tree: day * 10 + index)
            }
        }
    }

    func testABacklogShipsByReferenceAsFarAsTheCompactorHasComeAndNeverInline() async throws {
        let store = try store()
        let frames = try backlog(store)
        let later: TimeInterval = 4 * 86_400
        try await compactText(store, until: later)
        try positionWritten(at: later - 60)
        let first = try sealAll(at: later)
        let shapes = try shapes(first)
        XCTAssertEqual(shapes.count, 12)
        XCTAssertTrue(shapes.allSatisfy(isReference), "days-old frames wait for text; none ships inline")
        XCTAssertEqual(try entry(first.last).through, frames[11], "the slice stops at the first frame not compacted")

        try await compactText(store, until: later + 1)
        try await compactText(store, until: later + 2)
        try positionWritten(at: later + 2)
        let rest = try sealAll(at: later + 3)
        XCTAssertEqual(try self.shapes(rest).count, 18)
        XCTAssertTrue(try self.shapes(rest).allSatisfy(isReference))
        try assertTheLinesRebuildTheSpool(try read(first + rest))
    }

    func testAStoppedCompactorShipsOnlyItsHourOldFramesInline() async throws {
        let store = try store()
        let frames = try backlog(store)
        let later: TimeInterval = 4 * 86_400
        try await compactText(store, until: later)
        let young = try frame(store, later - 600)
        try positionWritten(at: later - 7_200)
        let bundles = try sealAll(at: later)
        let shapes = try shapes(bundles)
        XCTAssertEqual(shapes.count, 30)
        XCTAssertTrue(shapes.prefix(12).allSatisfy(isReference))
        XCTAssertEqual(Array(shapes.suffix(18)), Array(repeating: .inline, count: 18), "the stuck compactor's frames ship inline")
        XCTAssertEqual(try entry(bundles.last).through, frames.last, "the young frame still waits")
        XCTAssertNotEqual(young, frames.last)
        try assertTheLinesRebuildTheSpool(try read(bundles), excluding: [young])
    }

    func testWithNoPositionTheTextDirectorysAgeDecides() throws {
        let store = try store()
        let old = try frame(store, 1)
        let text = spool.appendingPathComponent(".text")
        try FileManager.default.setAttributes([.creationDate: Date(timeIntervalSince1970: Self.base + 7_000)], ofItemAtPath: text.path)
        XCTAssertNil(try seal(at: 7_000 + 3_599), "made under an hour ago: the compactor may still come")
        let sealed = try XCTUnwrap(try seal(at: 7_000 + 3_601))
        XCTAssertEqual(try shapes([sealed]), [.inline])
        XCTAssertEqual(try entry(sealed).through, old)
    }

    func testAWindowFinishedWithoutASegmentIsNotRebuiltAfterARestartAndShipsInline() async throws {
        let failed: String
        let later: String
        do {
            let store = try store()
            failed = try frame(store, 1, tree: 1)
            later = try frame(store, 301, tree: 2)
            try Data(String(Int(Self.base + 300) * 1_000_000).utf8).write(to: spool.appendingPathComponent(".text/position"))
        }
        try await compactText(try store(), until: 3_600)
        let text = spool.appendingPathComponent(".text")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: text.path).filter { $0.hasSuffix(".lstext") }.count, 1,
                       "only the later window: no orphan")
        try positionWritten(at: 3_600)
        let lines = try read(try sealAll(at: 3_601))
        XCTAssertEqual(lines.map(\.bundle), [failed, later])
        XCTAssertEqual(lines.first?.shape, .inline)
        XCTAssertTrue(isReference(try XCTUnwrap(lines.last?.shape)))
        try assertTheLinesRebuildTheSpool(lines)
    }


    func testAWindowCutAt64MiBShipsEachFrameByReferenceToItsOwnSegment() async throws {
        let store = try store()
        let line = String(repeating: "SYNTHETIC OCR WORDS ", count: 5_000)
        var frames: [String] = []
        for index in 0..<5 {
            frames.append(try frame(store, 10 + Double(index) * 2, tree: index, nodes: 2,
                                    ocr: (0..<150).map { "\(index)-\($0) " + line }))
        }
        let gap = try gap(store, 30)
        let report = try await compactText(store, until: 331)
        XCTAssertEqual(report.segmentCount, 2)
        let bundles = try sealAll(at: 3_700)
        let lines = try read(bundles)
        try assertTheLinesRebuildTheSpool(lines)
        let segments = lines.compactMap { line -> String? in
            if case .reference(let name) = line.shape { return name }
            return nil
        }
        XCTAssertEqual(segments.count, 5)
        XCTAssertEqual(Set(segments.prefix(4)).count, 1)
        XCTAssertNotEqual(segments[3], segments[4], "the window closes before the frame that would pass 64 MiB")
        XCTAssertEqual(lines.last?.bundle, gap)
        XCTAssertEqual(Set(try bundles.flatMap { try entry($0).blobs }).count, 2, "each segment travels once")
    }


    func testATextSegmentLeavesWithItsLastDayOnceEveryFrameWasCarriedAndTakesItsManifest() async throws {
        let store = try store()
        try frame(store, 1, tree: 1)
        try frame(store, 3, tree: 2)
        try await compactText(store, until: 331)
        let text = spool.appendingPathComponent(".text")
        let files = { try FileManager.default.contentsOfDirectory(atPath: text.path).filter { !$0.hasPrefix(".") && $0 != "position" }.sorted() }
        XCTAssertEqual(try files().count, 2)

        _ = try XCTUnwrap(try seal(at: 400, limit: 1))
        domain(at: 9 * 86_400).applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try files().count, 2)

        let rest = try XCTUnwrap(try seal(at: 401))
        XCTAssertEqual(rest.sidecar.seal, 2)
        domain(at: 9 * 86_400).applied(try await DomainFixtures.fresh(Self.source, received: 2, imported: 2, folder: root))
        XCTAssertEqual(try files(), [])
        XCTAssertTrue(try paths(in: spool).isEmpty)
    }
}

enum TextCompactionShapes {
    static func frame(at seconds: TimeInterval, display: UInt32, tree: Int, nodes: Int, ocr: [String]) -> CaptureObservation {
        let date = Date(timeIntervalSince1970: seconds)
        let app = CaptureApplication(bundleID: "com.example.browser", name: "Example \"Quoted\" Browser", pid: 4242)
        let bounds = CaptureRect(x: 0, y: 25, width: 640.5, height: 455)
        var observation = CaptureObservation(capturedAt: date, displayID: display, width: 0, height: 0, application: app,
            windows: [CaptureWindow(windowID: 11, title: "Synthetic / window \\ \(tree)", application: app, bounds: bounds),
                      CaptureWindow(windowID: 12, title: nil, application: app, bounds: bounds, site: "example.com")],
            ocr: ocr.enumerated().map { TextObservation(text: $1, confidence: 0.3 + Float($0 % 50) * 0.01,
                                                       bounds: CaptureRect(x: 0.125, y: 0.1, width: 0.5, height: 0.0625)) },
            reason: "foreground-pid-matched-around-image-acquisition; non-atomic-observation",
            capturedUntil: date.addingTimeInterval(0.031_25), displayBounds: CaptureRect(x: 0, y: 0, width: 640, height: 480),
            ocrStatus: "complete-full-pixels-changed")
        var snapshot = AccessibilitySnapshot(
            capturedAt: date.addingTimeInterval(0.040_2), status: "complete-scoped-app-reported",
            nodes: (0..<nodes).map { index in
                AccessibilityNode(role: index == 0 ? "AXWindow" : "AXStaticText",
                                  text: "SYNTHETIC ROW \(tree)-\(index) \u{e9}t\u{e9} \u{1F600} \"q\" \n line",
                                  bounds: CaptureRect(x: 10, y: Double(60 + index) + 0.1, width: 600, height: 18),
                                  depth: index == 0 ? 0 : 1, value: index % 3 == 0 ? "VALUE \(index)" : nil)
            },
            capturedUntil: date.addingTimeInterval(0.090_7))
        snapshot.limitReasons = []
        snapshot.windowCorrelation = "unique-pid-and-window-geometry"
        observation.accessibility = snapshot
        observation.inputIdleSeconds = 1.5
        return observation
    }
}
