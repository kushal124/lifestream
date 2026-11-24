import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class MachineDiaryTests: XCTestCase {
    private var root: URL!
    private let at = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("machine-diary-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testAnInstallStatesOnceThenWritesEachChangeAndNeverAskingNorARepeat() async throws {
        let store = try CaptureStore(root: root)
        let diary = MachineDiary(store: store, now: { [at] in at })
        await diary.record(["location": "limited", "motion": "not-now", "health": "asking"]).value
        await diary.record(["location": "limited", "motion": "not-now", "health": "asking"]).value
        var lines = try await events(store)
        XCTAssertEqual(lines.count, 1, "one state, and nothing for a repeat")
        XCTAssertEqual(lines.first?.kind, "machine-event")
        XCTAssertEqual(lines.first?.observedAt, CaptureTime.rfc3339(at))
        XCTAssertEqual(lines.first?.payload, Self.payload("state", ["access_location": "limited", "access_motion": "not-now"]),
                       "asking is a moment, never stated")

        await diary.record(["location": "on", "motion": "not-now", "health": "asked"]).value
        lines = try await events(store)
        XCTAssertEqual(lines.dropFirst().map(\.payload), [
            Self.payload("access", ["grant": "health", "state": "asked"]),
            Self.payload("access", ["grant": "location", "state": "on"]),
        ], "each grant that changed, once")

        let relaunched = MachineDiary(store: store, now: { [at] in at })
        await relaunched.record(["location": "on", "motion": "not-now", "health": "asked"]).value
        await relaunched.record(["location": "asking", "motion": "off", "health": "asked"]).value
        lines = try await events(store)
        XCTAssertEqual(lines.count, 4, "no second state, no repeat")
        XCTAssertEqual(lines.last?.payload, Self.payload("access", ["grant": "motion", "state": "off"]))
    }

    func testRecordsMadeAtOnceAreWrittenInTheOrderMadeAndStateOnce() async throws {
        let store = try CaptureStore(root: root)
        let diary = MachineDiary(store: store)
        diary.record(["photos": "limited"])
        diary.record(["photos": "limited"])
        diary.record(["photos": "on"])
        diary.record(["photos": "off"])
        await diary.record(["photos": "limited"]).value
        let lines = try await events(store)
        XCTAssertEqual(lines.map(\.payload), [
            Self.payload("state", ["access_photos": "limited"]),
            Self.payload("access", ["grant": "photos", "state": "on"]),
            Self.payload("access", ["grant": "photos", "state": "off"]),
            Self.payload("access", ["grant": "photos", "state": "limited"]),
        ], "one state, then each change in the order made")
    }

    func testARecordThatCouldNotWriteIsWrittenByTheNext() async throws {
        let store = try CaptureStore(root: root)
        let failing = Failing()
        let diary = MachineDiary(store: store, beforeCapture: { try await failing.pass() })
        await diary.record(["contacts": "off"]).value
        var lines = try await events(store)
        XCTAssertTrue(lines.isEmpty, "the store was not ready")
        await diary.record(["contacts": "off"]).value
        lines = try await events(store)
        XCTAssertEqual(lines.map(\.payload), [Self.payload("state", ["access_contacts": "off"])])
    }

    func testTheDiaryShipsAsTheMachineDomainByteForByte() async throws {
        let store = try CaptureStore(root: root)
        let diary = MachineDiary(store: store)
        await diary.record(["location": "not-asked"]).value
        await diary.record(["location": "on"]).value
        let sealed = try await CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports"))
            .sealEverything(appVersion: "1.0.0")
        let file = try XCTUnwrap(sealed?.manifest.files["machine.jsonl"])
        XCTAssertEqual(file.observations, 2)
        let raw = try await store.jsonl(.machine)
        XCTAssertEqual(file.bytes, UInt64(raw.count))
        XCTAssertEqual(file.sha256, SHA256Digest.tagged(raw))
        XCTAssertEqual(PhoneCustody.sources(["machine:local:unit-0001"])[.machine], "machine:local:unit-0001",
                       "the source the pass names for it begins with its product")
    }

    private func events(_ store: CaptureStore) async throws -> [CaptureEntry] {
        try await store.entries(domain: .machine)
    }

    private static func payload(_ event: String, _ detail: [String: String]) -> JSONValue {
        .object(["event": .string(event), "detail": .object(detail.mapValues(JSONValue.string))])
    }
}

private actor Failing {
    private var calls = 0

    func pass() throws {
        calls += 1
        if calls == 1 { throw CancellationError() }
    }
}
