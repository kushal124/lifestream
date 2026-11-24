import Foundation
import HomeLink
import Synchronization
import XCTest

@testable import LifestreamCaptureCore

final class CaptureStoreTests: XCTestCase {
    func testOnAFullDiskNothingIsSavedAndEachWriteGoesOnOnceThereIsRoom() async throws {
        let root = try temporaryDirectory()
        let disk = Mutex<Int64?>(2_000_000_000)
        let clock = Mutex(Date(timeIntervalSince1970: 1_800_000_000))
        let store = try await CaptureStore.restored(root: root, waitSeconds: 60,
                                                    volume: Volume(root, read: { _ in disk.withLock { $0 } },
                                                                   clock: { clock.withLock { $0 } }))
        let minute = { clock.withLock { $0.addTimeInterval(60) } }
        let fix = CaptureDraft(kind: "fix", observedAt: "2026-08-14T10:00:00.000Z", payload: .object([:]))
        try await store.append(domain: .location, draft: fix)
        try await store.append(domain: .location, draft: fix, waiting: true)
        _ = try await store.storeBlob(Data("a low disk takes new data".utf8))

        let blob = Data(repeating: 7, count: 4_096)
        disk.withLock { $0 = 1_000_006_000 }
        _ = try await store.storeBlob(blob)
        disk.withLock { $0 = 1_000_001_904 }
        do {
            _ = try await store.storeBlob(Data(repeating: 8, count: 4_096))
            XCTFail("a second blob against the room the first took")
        } catch { XCTAssertEqual(error as? CaptureError, .full) }

        let media = root.appendingPathComponent("clip.mov")
        try Data(repeating: 1, count: 4_096).write(to: media)
        disk.withLock { $0 = 1_000_002_000 }
        minute()
        let moved = try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: media))
        XCTAssertEqual(moved.bytes, 4_096)

        disk.withLock { $0 = 999_999_999 }
        minute()
        let writes: [(String, () async throws -> Void)] = [
            ("durable", { try await store.append(domain: .location, draft: fix) }),
            ("waiting", { try await store.append(domain: .motion, draft: fix, waiting: true) }),
            ("replayed", { try await store.appendReplayBatch(domain: .health, drafts: [.init(replayKey: "k", draft: fix)]) }),
            ("blob", { _ = try await store.storeBlob(Data("full".utf8)) }),
            ("file", {
                let file = root.appendingPathComponent("note.m4a")
                try Data(repeating: 2, count: 64).write(to: file)
                _ = try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: file))
            }),
        ]
        for (name, write) in writes {
            do {
                try await write()
                XCTFail("\(name): saved on a full disk")
            } catch { XCTAssertEqual(error as? CaptureError, .full, name) }
        }
        try await store.flush()
        let through = try await store.capturedThrough()
        XCTAssertEqual(through[.location], 2, "what landed before stays; nothing after it")
        XCTAssertEqual(through[.motion], 0)
        XCTAssertEqual(through[.health], 0)

        disk.withLock { $0 = nil }
        minute()
        try await store.append(domain: .location, draft: fix)
        let after = try await store.capturedThrough()
        XCTAssertEqual(after[.location], 3, "a disk that does not read is low: new data lands")
    }

    func testBatchAppendIsOrderedAndSealsTheExactJSONLBytes() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(
            root: root, processInstanceID: UUID(uuidString: "00000000-0000-0000-0000-000000000002")!)
        let captured = WallAndMonotonicTime(wall: Date(timeIntervalSince1970: 1_700_000_000.125), elapsedSeconds: 42.5)
        let large = String(repeating: "synthetic-🟢", count: 12_000)
        let entries = try await store.appendBatch(domain: .location, drafts: [
            .init(kind: "fix", observedAt: "2026-08-14T10:00:00.000Z", captured: captured,
                payload: .object(["horizontal_accuracy": .number(-1)])),
            .init(kind: "fix", observedAt: "2026-08-14T10:00:01.000Z", captured: captured,
                payload: .object([
                    "horizontal_accuracy": .number(12.5), "signed": .integer(Int64.min),
                    "unsigned": .unsigned(UInt64.max), "nested": .array([.null, .bool(true), .string("é/🛰️")]),
                ])),
            .init(kind: "fix", observedAt: "2026-08-14T10:00:02Z", captured: captured,
                payload: .object(["large": .string(large)])),
        ])
        XCTAssertEqual(entries.map(\.sequence), [1, 2, 3])
        let encoder = JSONEncoder.lifestream()
        let reread = try await store.entries(domain: .location)
        XCTAssertEqual(try reread.map { try encoder.encode($0) }, try entries.map { try encoder.encode($0) })
        let suffix = try await store.entries(domain: .location, afterSequence: 1)
        XCTAssertEqual(suffix.map(\.sequence), [2, 3])

        func jsonl(_ entries: ArraySlice<CaptureEntry>) throws -> Data {
            try entries.reduce(into: Data()) { $0.append(try encoder.encode($1)); $0.append(0x0A) }
        }
        let whole = try await stage(store, .location, after: 0)
        XCTAssertEqual(whole.bytes, try jsonl(entries[...]))
        XCTAssertEqual(whole.slice.sha256, SHA256Digest.tagged(whole.bytes))
        XCTAssertEqual(whole.slice.observations, 3)
        XCTAssertEqual(whole.slice.firstSequence, 1)
        XCTAssertEqual(whole.slice.lastSequence, 3)
        XCTAssertEqual(whole.slice.firstObservedAt, "2026-08-14T10:00:00.000Z")
        XCTAssertEqual(whole.slice.lastObservedAt, "2026-08-14T10:00:02Z")
        let tail = try await stage(store, .location, after: 2)
        XCTAssertEqual(tail.bytes, try jsonl(entries[2...]))
        let empty = try await stage(store, .motion, after: 0)
        XCTAssertEqual(empty.bytes, Data())
        XCTAssertNil(empty.slice.firstSequence)
        let text = String(decoding: whole.bytes, as: UTF8.self)
        XCTAssertTrue(text.contains("2023-11-14T22:13:20.125000000Z"), "capture time is nine-digit UTC")
        XCTAssertTrue(text.contains("18446744073709551615"))
        XCTAssertTrue(text.contains("-9223372036854775808"))
    }

    func testASealedLineStatesItsProcessesElapsedSecondsAndNoBoot() async throws {
        final class Uptime: @unchecked Sendable { var seconds = 9_000_000.0 }
        let uptime = Uptime()
        let clock = ProcessClock(uptime: { uptime.seconds })
        uptime.seconds += 42.5
        let store = try await CaptureStore.restored(
            root: try temporaryDirectory(),
            processInstanceID: UUID(uuidString: "00000000-0000-4000-8000-0000000000C1")!)
        _ = try await store.appendBatch(domain: .checkin, drafts: [
            .init(kind: "prompt", observedAt: "2026-10-03T03:30:00.125Z",
                captured: .init(wall: Date(timeIntervalSince1970: 1_791_003_600.125), elapsedSeconds: clock.elapsedSeconds),
                payload: .object([
                    "prompt_id": .string("20000000-0000-4000-8000-000000000001"), "form": .string("moment"),
                    "trigger": .string("random"), "scheduled_for": .string("2026-10-03T03:30:00Z"),
                    "window_start": .string("2026-10-03T03:00:00Z"), "window_end": .string("2026-10-03T04:00:00Z"),
                    "event": .string("delivered"),
                ])),
        ])
        let line = String(decoding: try await stage(store, .checkin, after: 0).bytes, as: UTF8.self)
        XCTAssertEqual(line, #"{"captured":{"elapsed_seconds":42.5,"wall_rfc3339":"2026-10-03T05:00:00.125000000Z","wall_unix_seconds":1791003600.125},"domain":"checkin","kind":"prompt","observed_at":"2026-10-03T03:30:00.125Z","payload":{"event":"delivered","form":"moment","prompt_id":"20000000-0000-4000-8000-000000000001","scheduled_for":"2026-10-03T03:30:00Z","trigger":"random","window_end":"2026-10-03T04:00:00Z","window_start":"2026-10-03T03:00:00Z"},"process_instance_id":"00000000-0000-4000-8000-0000000000C1","schema_version":1,"sequence":1}"# + "\n")

        let anchored = ProcessInfo.processInfo.systemUptime - ProcessClock.shared.elapsedSeconds
        XCTAssertGreaterThan(anchored, 0, "the anchor is a moment after the boot")
        XCTAssertLessThanOrEqual(WallAndMonotonicTime().elapsedSeconds, ProcessInfo.processInfo.systemUptime - anchored)
    }

    func testALineInTheEarlierBootClockIsReadKeepsItsClockAndShipsAsSaved() async throws {
        let store = try CaptureStore(root: try temporaryDirectory())
        for index in 0..<2 {
            _ = try await store.append(domain: .photos, draft: .init(
                kind: "sweep", observedAt: "2026-10-03T04:00:00Z",
                captured: .init(wall: Date(timeIntervalSince1970: 1_791_000_000), elapsedSeconds: 7),
                payload: .object(["index": .integer(Int64(index))])))
        }
        let wall = #""wall_rfc3339":"2026-10-03T04:00:00.000000000Z","wall_unix_seconds":1791000000"#
        let earlier = Data((#"{"boot_id":"00000000-0000-4000-8000-0000000000B1","captured":{"monotonic_seconds":1000.5,"#
            + wall + #"},"domain":"photos","kind":"sweep","observed_at":"2026-10-03T04:00:00Z","payload":{"index":0},"#
            + #""process_instance_id":"00000000-0000-4000-8000-0000000000C1","schema_version":1,"sequence":1}"#).utf8)
        try SQLiteDatabase(url: store.databaseURL)
            .run(#"UPDATE "photos" SET line = ? WHERE sequence = 1"#, .blob(earlier))

        let entries = try await store.entries(domain: .photos)
        XCTAssertEqual(entries.map(\.sequence), [1, 2])
        XCTAssertEqual(entries.map(\.captured.clock), [.boot, .process])
        XCTAssertEqual(entries[0].captured.elapsedSeconds, 1000.5)
        let reencoded = try JSONSerialization.jsonObject(
            with: JSONEncoder.lifestream().encode(entries[0].captured)) as? [String: Any]
        XCTAssertEqual(Set(reencoded?.keys ?? [:].keys), ["monotonic_seconds", "wall_rfc3339", "wall_unix_seconds"],
            "a boot-clock reading never turns into a process clock")
        let sealed = try await stage(store, .photos, after: 0).bytes
        XCTAssertEqual(sealed.prefix(earlier.count + 1), earlier + Data([0x0A]), "the line ships as it was saved")

        let decoder = JSONDecoder.lifestream()
        for (captured, why) in [
            ("{" + wall + "}", "neither clock"),
            (#"{"elapsed_seconds":1,"monotonic_seconds":1,"# + wall + "}", "both clocks"),
            (#"{"monotonic_seconds":-1,"# + wall + "}", "a negative uptime"),
        ] {
            XCTAssertThrowsError(try decoder.decode(WallAndMonotonicTime.self, from: Data(captured.utf8)), why)
        }
    }

    func testCommittedAppendsSurviveACrashImageAndSequencesContinue() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        for index in 0..<20 {
            _ = try await store.appendBatch(domain: .motion, drafts: (0..<50).map { member in
                .init(kind: "activity", observedAt: "2026-08-14T10:00:00Z",
                    payload: .object(["index": .integer(Int64(index * 50 + member))]))
            })
        }
        let written = try await stage(store, .motion, after: 0).bytes
        let image = try temporaryDirectory()
        for name in ["capture.sqlite", "capture.sqlite-wal", "capture.sqlite-shm"]
        where FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path) {
            try FileManager.default.copyItem(at: root.appendingPathComponent(name), to: image.appendingPathComponent(name))
        }
        XCTAssertGreaterThan(try FileDurability.regularFileSize(at: image.appendingPathComponent("capture.sqlite-wal")), 0)

        let reopened = try CaptureStore(root: image)
        let recovered = try await stage(reopened, .motion, after: 0).bytes
        XCTAssertEqual(recovered, written)
        let next = try await reopened.append(domain: .motion, draft: .init(
            kind: "activity", observedAt: "2026-08-14T10:00:01Z", payload: .object([:])))
        XCTAssertEqual(next.sequence, 1_001)
    }

    func testFailedBatchWritesNothingAndTheStoreCarriesOn() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        _ = try await store.append(domain: .location, draft: .init(
            kind: "fix", observedAt: "2026-08-14T10:00:00Z", payload: .object([:])))
        await assertThrowsErrorAsync {
            _ = try await store.appendBatch(domain: .location, drafts: [
                .init(kind: "fix", observedAt: "2026-08-14T10:00:01Z", payload: .object([:])),
                .init(kind: "fix", observedAt: "not a time", payload: .object([:])),
            ])
        }
        let next = try await store.append(domain: .location, draft: .init(
            kind: "fix", observedAt: "2026-08-14T10:00:02Z", payload: .object([:])))
        XCTAssertEqual(next.sequence, 2)
        let sequences = try await store.entries(domain: .location).map(\.sequence)
        XCTAssertEqual(sequences, [1, 2])
    }

    func testAnAppendThatSetsAnchorsIsOneTransactionOrNone() async throws {
        let store = try CaptureStore(root: try temporaryDirectory())
        let before = await store.transactions
        let none = try await store.appendBatch(domain: .health, drafts: [], anchors: [:])
        XCTAssertEqual(none, [])
        let afterNone = await store.transactions
        XCTAssertEqual(afterNone - before, 0, "nothing to write opens no transaction")

        let sample = CaptureDraft(kind: "sample", observedAt: "2026-08-14T10:00:00Z", payload: .object([:]))
        let written = try await store.appendBatch(domain: .health, drafts: [sample, sample],
                                                  anchors: ["page": Data("after".utf8), "mark": Data([1])])
        XCTAssertEqual(written.map(\.sequence), [1, 2])
        let afterPage = await store.transactions
        XCTAssertEqual(afterPage - afterNone, 1, "entries and anchors in one transaction")
        let page = try await store.anchor("page")
        XCTAssertEqual(page, Data("after".utf8))
        let mark = try await store.anchor("mark")
        XCTAssertEqual(mark, Data([1]))

        await assertThrowsErrorAsync {
            _ = try await store.appendBatch(domain: .health, drafts: [sample, .init(kind: "sample", observedAt: "not a time", payload: .object([:]))],
                                            anchors: ["page": Data("past".utf8), "mark": nil])
        }
        let kept = try await store.anchor("page")
        XCTAssertEqual(kept, Data("after".utf8), "the failed page's anchor rolled back with its entries")
        let markKept = try await store.anchor("mark")
        XCTAssertEqual(markKept, Data([1]), "and so did its removal")
        let sequences = try await store.entries(domain: .health).map(\.sequence)
        XCTAssertEqual(sequences, [1, 2])
    }

    func testTheObserverHearsEveryAppendAtOneDepth() async throws {
        let store = try CaptureStore(root: try temporaryDirectory())
        let heard = Mutex<[(sequences: [UInt64], depth: Int)]>([])
        store.observe { _, entries in
            heard.withLock { $0.append((entries.map(\.sequence), Thread.callStackSymbols.count)) }
        }
        for _ in 0..<100 {
            try await store.append(domain: .motion, draft: .init(
                kind: "activity", observedAt: "2026-08-14T10:00:00Z", payload: .object([:])))
        }
        let calls = heard.withLock { $0 }
        XCTAssertEqual(calls.map(\.sequences), (1...100).map { [UInt64($0)] })
        XCTAssertEqual(Set(calls.map(\.depth)).count, 1, "depths \(calls.first?.depth ?? 0)...\(calls.last?.depth ?? 0)")
    }

    func testThePhotosStatedLiveCountAVersionAnAvailabilityOrAGoneAsAPhoto() async throws {
        let store = try CaptureStore(root: try temporaryDirectory())
        let digest = String(repeating: "a", count: 64)
        func key(_ id: String, _ modified: String) -> String { "photos:\(id):\(modified):sha256:\(digest)" }
        let draft = CaptureDraft(kind: "asset", observedAt: "2026-08-14T10:00:00.000000000Z", payload: .object([:]))
        let keys = [
            key("A/L0/001", "2026-08-14T10:00:00.000000000Z"),
            key("A/L0/001", "2026-08-15T10:00:00.000000000Z"),
            "photos:A/L0/001:2026-08-15T10:00:00.000000000Z:availability:sha256:\(digest):2026-08-15T10:00:01.000000000Z",
            key("B/L0/001", "null"),
            key("C/L0/001", "null"),
            key("C/L0/001", "null") + ":gone",
            "photos:D/L0/001:null:availability:sha256:\(digest):2026-08-15T10:00:01.000000000Z",
        ]
        _ = try await store.appendReplayBatch(domain: .photos, drafts: keys.map { .init(replayKey: $0, draft: draft) })
        let live = try await store.photosStatedLive()
        XCTAssertEqual(live, ["A/L0/001", "B/L0/001"])
    }

    func testHistoricalReplayIsSuppressedDurablyWithoutDeduplicatingLiveCallbacks() async throws {
        let root = try temporaryDirectory()
        let first = try CaptureStore(root: root)
        func draft(_ value: Int) -> CaptureDraft {
            .init(kind: "activity", observedAt: "2026-08-14T10:00:00.000000000Z",
                payload: .object(["value": .integer(Int64(value))]))
        }
        let initial = try await first.appendReplayBatch(domain: .motion, drafts: [
            .init(replayKey: "source-a:occurrence:0", draft: draft(1)),
            .init(replayKey: "source-a:occurrence:1", draft: draft(1)),
        ])
        XCTAssertEqual(initial.count, 2, "identical source members in one query remain distinct")
        let overlap = try await first.appendReplayBatch(domain: .motion, drafts: [
            .init(replayKey: "source-a:occurrence:0", draft: draft(1)),
            .init(replayKey: "source-a:occurrence:1", draft: draft(1)),
            .init(replayKey: "source-b:occurrence:0", draft: draft(2)),
            .init(replayKey: "source-b:occurrence:0", draft: draft(2)),
        ])
        XCTAssertEqual(overlap.map(\.sequence), [3])
        XCTAssertEqual(overlap.first?.captureReplayKey, "source-b:occurrence:0")

        let relaunched = try CaptureStore(root: root)
        let replayed = try await relaunched.appendReplayBatch(domain: .motion, drafts: [
            .init(replayKey: "source-a:occurrence:0", draft: draft(1)),
            .init(replayKey: "source-b:occurrence:0", draft: draft(2)),
        ])
        XCTAssertTrue(replayed.isEmpty)
        let health = try await relaunched.appendReplayBatch(domain: .health, drafts: [
            .init(replayKey: "source-a:occurrence:0", draft: draft(1)),
        ])
        XCTAssertEqual(health.count, 1)

        _ = try await relaunched.append(domain: .motion, draft: draft(9))
        _ = try await relaunched.append(domain: .motion, draft: draft(9))
        let all = try await relaunched.entries(domain: .motion)
        XCTAssertEqual(all.count, 5)
        XCTAssertNil(all[3].captureReplayKey)
        XCTAssertNil(all[4].captureReplayKey)
    }

    func testConcurrentReplayBatchesAdmitANewMemberOnce() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let history = (0..<4_096).map { index in
            ReplayCaptureDraft(replayKey: "history:\(index)", draft: .init(
                kind: "activity", observedAt: "2026-08-14T10:00:00Z",
                payload: .object(["value": .integer(Int64(index))])))
        }
        _ = try await store.appendReplayBatch(domain: .motion, drafts: history)
        let candidate = ReplayCaptureDraft(replayKey: "new-source-member", draft: .init(
            kind: "activity", observedAt: "2026-08-14T10:00:00Z", payload: .object([:])))
        async let left = store.appendReplayBatch(domain: .motion, drafts: history + [candidate])
        async let right = store.appendReplayBatch(domain: .motion, drafts: [candidate])
        let admitted = try await left + right
        XCTAssertEqual(admitted.count, 1)
        let persisted = try await store.entries(domain: .motion).count
        XCTAssertEqual(persisted, 4_097)
    }

    func testStatusIsAQueryOverTodayAndTheLastDay() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let now = Date()
        let dayStart = CaptureStore.localCalendar.startOfDay(for: now)
        func at(_ date: Date) -> WallAndMonotonicTime { .init(wall: date, elapsedSeconds: 42) }
        let yesterday = dayStart.addingTimeInterval(-60)
        let early = dayStart.addingTimeInterval(1)
        let newest = now.addingTimeInterval(-10)
        let older = now.addingTimeInterval(-20)
        _ = try await store.appendBatch(domain: .location, drafts: [
            .init(kind: "fix", observedAt: CaptureTime.rfc3339(yesterday), captured: at(yesterday), payload: .object([:])),
            .init(kind: "recorder_event", observedAt: CaptureTime.rfc3339(now.addingTimeInterval(-90_000)),
                captured: at(now.addingTimeInterval(-90_000)), payload: .object(["event": .string("engine_b_state")])),
            .init(kind: "fix", observedAt: CaptureTime.rfc3339(early), captured: at(early), payload: .object([:])),
            .init(kind: "fix", observedAt: CaptureTime.rfc3339(newest), captured: at(now), payload: .object([:])),
            .init(kind: "fix", observedAt: CaptureTime.rfc3339(older), captured: at(now), payload: .object([:])),
            .init(kind: "recorder_event", observedAt: CaptureTime.rfc3339(now), captured: at(now),
                payload: .object(["event": .string("engine_b_state")])),
            .init(kind: "recorder_event", observedAt: CaptureTime.rfc3339(now), captured: at(now),
                payload: .object(["event": .string("experiment_marker")])),
        ])
        _ = try await store.append(domain: .motion, draft: .init(
            kind: "activity", observedAt: CaptureTime.rfc3339(now), captured: at(now), payload: .object([:])))
        _ = try await store.append(domain: .health, draft: .init(
            kind: "sample", observedAt: CaptureTime.rfc3339(yesterday), captured: at(yesterday), payload: .object([:])))
        _ = try await store.append(domain: .voice, draft: .init(
            kind: "voice_note", observedAt: CaptureTime.rfc3339(now), captured: at(now), payload: .object([:])))
        _ = try await store.appendBatch(domain: .photos, drafts: [
            .init(kind: "asset", observedAt: CaptureTime.rfc3339(early), captured: at(early), payload: .object([:])),
            .init(kind: "resource_availability", observedAt: CaptureTime.rfc3339(older), captured: at(older), payload: .object([:])),
            .init(kind: "sweep", observedAt: CaptureTime.rfc3339(now), captured: at(now), payload: .object([:])),
            .init(kind: "sweep", observedAt: CaptureTime.rfc3339(now), captured: at(now), payload: .object([:])),
        ])

        let summary = try await CaptureStore(root: root).statusSummary(now: now)
        XCTAssertEqual(summary.week[.photos]?.last, 1)
        XCTAssertEqual(summary.last[.photos], early)
        XCTAssertEqual(summary.localDay, CaptureStore.localDay(for: now))
        XCTAssertEqual(summary.locationFixesToday, 3)
        XCTAssertEqual(summary.locationEventsToday, 2)
        XCTAssertEqual(summary.motionEntriesToday, 1)
        XCTAssertEqual(summary.healthEntriesToday, 0)
        XCTAssertEqual(summary.voiceEntriesToday, 1)
        XCTAssertEqual(summary.cameraEntriesToday, 0)
        XCTAssertEqual(summary.lastFixObservedAt, CaptureTime.rfc3339(newest))
        XCTAssertEqual(summary.recorderHealthEventWallTimes, [now.timeIntervalSince1970])
        let through = try await store.capturedThrough()
        XCTAssertEqual(through, [.location: 7, .motion: 1, .health: 1, .camera: 0, .photos: 4, .voice: 1,
            .usage: 0, .contacts: 0, .checkin: 0, .notes: 0, .energy: 0, .upload: 0, .machine: 0])
    }

    func testLatestEntryIsTheNewestRow() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let none = try await store.latestEntry(domain: .camera)
        XCTAssertNil(none)
        let written = try await store.appendBatch(domain: .camera, drafts: (0..<3).map { index in
            .init(kind: "photo", observedAt: "2026-08-14T10:00:0\(index)Z", payload: .object(["index": .integer(Int64(index))]))
        })
        let latest = try await CaptureStore(root: root).latestEntry(domain: .camera)
        XCTAssertEqual(latest, written.last)
    }

    func testBlobStorageIsContentAddressedAndDeduplicated() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let bytes = Data("route bytes\n".utf8)
        let first = try await store.storeBlob(bytes)
        let second = try await store.storeBlob(bytes)
        XCTAssertEqual(first, SHA256Digest.tagged(bytes))
        XCTAssertEqual(second, first)
        let files = try await store.validatedBlobInventory().map(\.url)
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(try Data(contentsOf: files[0]), bytes)
        try Data("corrupt".utf8).write(to: files[0])
        await assertThrowsErrorAsync { _ = try await store.storeBlob(bytes) }
    }

    func testBlobPublicationRetryResynchronizesAnExistingCorrectHashPath() async throws {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root)
        let blobs = root.appendingPathComponent("blobs")
        try FileManager.default.setAttributes([.posixPermissions: 0o300], ofItemAtPath: blobs.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: blobs.path) }
        let bytes = Data("route bytes\n".utf8)
        await assertThrowsErrorAsync { _ = try await store.storeBlob(bytes) }
        await assertThrowsErrorAsync { _ = try await store.storeBlob(bytes) }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: blobs.path)
        let stored = try await store.storeBlob(bytes)
        XCTAssertEqual(stored, SHA256Digest.tagged(bytes))
    }

    #if canImport(Darwin)
        func testDatabaseFilesCarryTheCaptureProtectionClass() async throws {
            let root = try temporaryDirectory()
            let store = try CaptureStore(root: root)
            _ = try await store.append(domain: .location, draft: .init(
                kind: "fix", observedAt: "2026-08-14T10:00:00Z", payload: .object([:])))
            for name in ["capture.sqlite", "capture.sqlite-wal", "capture.sqlite-shm"] {
                let attributes = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(name).path)
                XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType,
                    .completeUntilFirstUserAuthentication, name)
            }
        }
    #endif


    private func stage(_ store: CaptureStore, _ domain: CaptureDomain, after: UInt64) async throws
        -> (slice: StagedCaptureLogSlice, bytes: Data)
    {
        let directory = try temporaryDirectory()
        let staged = try await store.stageExportSlices([(domain, after)], in: directory)
        let slice = try XCTUnwrap(staged[domain]).get()
        return (slice, try Data(contentsOf: directory.appendingPathComponent(domain.filename)))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func assertThrowsErrorAsync(
        _ expression: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line
    ) async {
        do {
            try await expression()
            XCTFail("Expected expression to throw", file: file, line: line)
        } catch {}
    }
}
