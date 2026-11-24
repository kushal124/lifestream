import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class WaitingReadingsTests: XCTestCase {
    func testADurableSaveWritesWhatWaitsFirstSoTheDatabaseHoldsNoGap() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let waited = try await store.appendBatch(domain: .location, drafts: fixes(3), waiting: true)
        XCTAssertEqual(waited.map(\.sequence), [1, 2, 3])
        XCTAssertEqual(try rawSequences(root, .location), [], "nothing is saved while it waits")

        let before = await store.transactions
        let durable = try await store.append(domain: .location, draft: fix(9))
        XCTAssertEqual(durable.sequence, 4)
        let after = await store.transactions
        XCTAssertEqual(after - before, 1, "the waiting readings ride the durable save's transaction")
        XCTAssertEqual(try rawSequences(root, .location), [1, 2, 3, 4])
        let staged = try await store.stageExportSlices([(.location, 0)], in: try temporaryDirectory())
        XCTAssertEqual(try XCTUnwrap(staged[.location]).get().lastSequence, 4)
    }

    func testSequencesInterleaveInCallOrderAndNeverRepeat() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let first = try await store.append(domain: .motion, draft: fix(1), waiting: true)
        let second = try await store.append(domain: .motion, draft: fix(2))
        let third = try await store.append(domain: .motion, draft: fix(3), waiting: true)
        let other = try await store.append(domain: .location, draft: fix(4), waiting: true)
        XCTAssertEqual([first, second, third].map(\.sequence), [1, 2, 3])
        XCTAssertEqual(other.sequence, 1, "each domain numbers its own")
        try await store.flush()
        XCTAssertEqual(try rawSequences(root, .motion), [1, 2, 3])
        XCTAssertEqual(try rawSequences(root, .location), [1])
        let lines = try await store.entries(domain: .motion).map { $0.payload }
        XCTAssertEqual(lines, [fix(1).payload, fix(2).payload, fix(3).payload])
    }

    func testReadingsLostWithTheProcessLeaveNoNumberBehind() async throws {
        let root = try temporaryDirectory()
        do {
            let store = try CaptureStore(root: root)
            _ = try await store.appendBatch(domain: .location, drafts: fixes(2))
            _ = try await store.appendBatch(domain: .location, drafts: fixes(5), waiting: true)
        }
        let reopened = try CaptureStore(root: root)
        let next = try await reopened.append(domain: .location, draft: fix(1))
        XCTAssertEqual(next.sequence, 3)
        XCTAssertEqual(try rawSequences(root, .location), [1, 2, 3])
    }

    func testAFailedSaveKeepsTheWaitingReadingsAndWritesThemOnce() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        _ = try await store.appendBatch(domain: .location, drafts: fixes(2), waiting: true)
        do {
            _ = try await store.append(domain: .location, draft: .init(
                kind: "fix", observedAt: "not a time", payload: .object([:])))
            XCTFail("a fix with no time is refused")
        } catch {}
        XCTAssertEqual(try rawSequences(root, .location), [], "the failed save rolled back what waited")
        let next = try await store.append(domain: .location, draft: fix(3))
        XCTAssertEqual(next.sequence, 3)
        XCTAssertEqual(try rawSequences(root, .location), [1, 2, 3])
        try await store.flush()
        XCTAssertEqual(try rawSequences(root, .location), [1, 2, 3])
    }

    func testTheTimerSavesWithNoFurtherCall() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root, waitSeconds: 0.05)
        let before = await store.transactions
        _ = try await store.appendBatch(domain: .motion, drafts: fixes(4), waiting: true)
        try await until("try rawSequences(root, .motion).count >= 4") { try rawSequences(root, .motion).count >= 4 }
        XCTAssertEqual(try rawSequences(root, .motion), [1, 2, 3, 4])
        let after = await store.transactions
        XCTAssertEqual(after - before, 1, "one transaction for everything that waited")
    }

    func testTheByteCapSavesAtOnce() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let large = JSONValue.object(["blob": .string(String(repeating: "x", count: 900_000))])
        for index in 0..<5 {
            _ = try await store.append(domain: .location, draft: .init(
                kind: "fix", observedAt: "2026-10-14T10:00:0\(index)Z", payload: large), waiting: true)
        }
        XCTAssertEqual(try rawSequences(root, .location), [1, 2, 3, 4],
            "the fifth crosses 4 MB: the four before it are saved")
    }

    func testAWaitingReadingIsTheSameLineADurableSaveWrites() async throws {
        let process = UUID()
        let waitedRoot = try temporaryDirectory()
        let durableRoot = try temporaryDirectory()
        let waitedStore = try CaptureStore(root: waitedRoot, processInstanceID: process)
        let durableStore = try CaptureStore(root: durableRoot, processInstanceID: process)
        let drafts = fixes(3)
        _ = try await waitedStore.appendBatch(domain: .location, drafts: drafts, waiting: true)
        try await waitedStore.flush()
        _ = try await durableStore.appendBatch(domain: .location, drafts: drafts)
        XCTAssertEqual(try rawLines(waitedRoot, .location), try rawLines(durableRoot, .location))
    }

    func testStatusCountsWhatWaits() async throws {
        let store = try CaptureStore(root: try temporaryDirectory())
        _ = try await store.appendBatch(domain: .location, drafts: [.init(
            kind: "fix", observedAt: CaptureTime.rfc3339(Date()), payload: .object([:]))], waiting: true)
        let summary = try await store.statusSummary()
        XCTAssertEqual(summary.locationFixesToday, 1)
    }


    private func fix(_ index: Int) -> CaptureDraft {
        .init(kind: "fix", observedAt: "2026-10-14T10:00:00Z",
            captured: WallAndMonotonicTime(wall: Date(timeIntervalSince1970: 1_791_000_000 + Double(index)), elapsedSeconds: Double(index)),
            payload: .object(["index": .integer(Int64(index))]))
    }

    private func fixes(_ count: Int) -> [CaptureDraft] { (1...count).map(fix) }

    private func rawSequences(_ root: URL, _ domain: CaptureDomain) throws -> [Int64] {
        let database = try SQLiteDatabase(url: root.appendingPathComponent("capture.sqlite"))
        var sequences: [Int64] = []
        try database.query("SELECT sequence FROM \(domain.table) ORDER BY sequence") { sequences.append($0.integer(0)) }
        return sequences
    }

    private func rawLines(_ root: URL, _ domain: CaptureDomain) throws -> [Data] {
        let database = try SQLiteDatabase(url: root.appendingPathComponent("capture.sqlite"))
        var lines: [Data] = []
        try database.query("SELECT line FROM \(domain.table) ORDER BY sequence") { lines.append($0.blob(0)) }
        return lines
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-waiting-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
