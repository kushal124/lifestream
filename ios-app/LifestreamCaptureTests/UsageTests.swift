import Foundation
import LifestreamCaptureCore
import XCTest
@testable import Lifestream

private actor SyntheticUsageSource: UsageActivitySource {
    var status: UsageAuthorization = .approvedWithDataAccess
    var calls = 0
    var concurrent = 0
    var maximumConcurrent = 0
    var revision = 0
    var failAfterSegment = false
    var catalogComplete = true
    var intervals: [DateInterval] = []
    var revokeBeforeSegment = false
    var nested: JSONValue = .array([])
    var empty = false
    var holdCatalog = false
    var catalogCalls = 0
    var catalogWaiter: CheckedContinuation<Void, Never>?
    var failBeforeContext = false

    func authorization() async -> UsageAuthorization { status }
    func requestAuthorization() async throws { status = .approvedWithDataAccess }
    func configure(status: UsageAuthorization? = nil, revision: Int? = nil,
                   failAfterSegment: Bool? = nil, catalogComplete: Bool? = nil) {
        if let status { self.status = status }
        if let revision { self.revision = revision }
        if let failAfterSegment { self.failAfterSegment = failAfterSegment }
        if let catalogComplete { self.catalogComplete = catalogComplete }
    }
    func setNested(_ value: JSONValue) { nested = value }
    func setEmpty() { empty = true }
    func failWithoutContext() { failBeforeContext = true }
    func revokeDuringFetch() { revokeBeforeSegment = true }
    func requests() -> [DateInterval] { intervals }
    func metrics() -> (Int, Int) { (calls, maximumConcurrent) }
    func fetch(interval: DateInterval, live: Bool,
               onContext: @Sendable (JSONValue) async throws -> Void,
               onSegment: @Sendable (JSONValue, Date) async throws -> Void) async throws {
        calls += 1; concurrent += 1
        intervals.append(interval)
        maximumConcurrent = max(maximumConcurrent, concurrent)
        defer { concurrent -= 1 }
        if failBeforeContext { throw CocoaError(.fileReadUnknown) }
        let context: JSONValue = .object(["lastUpdatedDate": .object([
            "epochSeconds": .number(interval.end.timeIntervalSince1970),
            "rfc3339": .string(CaptureTime.rfc3339(interval.end))])])
        try await onContext(context)
        for _ in 0..<10 { await Task.yield() }
        if empty { return }
        if revokeBeforeSegment { status = .approved }
        try await onSegment(.object([
            "dateInterval": UsageRecorder.intervalValue(interval),
            "lastUpdatedDate": .number(Double(calls)),
            "segmentInterval": .object(["kind": .string("hourly"), "during": .number(Double(calls))]),
            "totalActivityDuration": .number(Double(revision)),
            "longestActivity": .null, "firstPickup": .null,
            "totalPickupsWithoutApplicationActivity": .integer(0),
            "categories": nested
        ]), interval.start)
        if failAfterSegment { throw CocoaError(.fileReadUnknown) }
    }
    func suspendCatalog() { holdCatalog = true }
    func catalogRequestCount() -> Int { catalogCalls }
    func releaseCatalog() { holdCatalog = false; catalogWaiter?.resume(); catalogWaiter = nil }
    func catalog() async throws -> JSONValue {
        catalogCalls += 1
        if holdCatalog { await withCheckedContinuation { catalogWaiter = $0 } }
        return .object(["complete": .bool(catalogComplete), "installedApplications": .object([
            "status": .string(catalogComplete ? "successful" : "failed"),
            "values": catalogComplete ? .array([]) : .null])])
    }
}

private extension UsageRecorder {
    func waitForSyntheticCatalog() async throws {
        try await waitUntil("!(await snapshot()).catalogPending") { !(await snapshot()).catalogPending }
    }

    func refreshAndWaitForCatalog(_ reason: UsageRefreshReason) async throws -> UsageCaptureStatus {
        _ = await refresh(reason)
        try await waitForSyntheticCatalog()
        return await snapshot()
    }
}

final class UsageTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_780_000_000)

    private func fixture() throws -> (URL, CaptureStore) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try CaptureStore(root: root.appendingPathComponent("capture"), processInstanceID: UUID())
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return (root, store)
    }

    private func recorder(root: URL, store: CaptureStore, source: SyntheticUsageSource,
                          inbox: UsageInbox? = nil, start: Date? = nil,
                          admit: @escaping @Sendable () async throws -> Void = {}) -> UsageRecorder {
        let now = now
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return UsageRecorder(store: store, source: source,
            cursorURL: root.appendingPathComponent("cursor.json"), inbox: inbox,
            calendar: calendar, now: { now }, start: { start }, admit: admit)
    }

    func testUnresponsiveCatalogDoesNotBlockActivityRefreshOrMultiplyRequests() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        await source.suspendCatalog()
        let recorder = recorder(root: root, store: store, source: source)
        let finished = Happened()
        let first = Task {
            let status = await recorder.refresh(.manual)
            XCTAssertNotNil(status.lastCompleted)
            XCTAssertFalse(status.isRefreshing)
            finished.note()
        }
        do {
            try await until("finished.value") { finished.value }
        } catch {
            await source.releaseCatalog()
            await first.value
            throw error
        }
        if await source.catalogRequestCount() == 0 {
            await source.releaseCatalog()
            await first.value
            return XCTFail("Inventory was never started")
        }
        let repeated = Happened()
        let second = Task { _ = await recorder.refresh(.manual); repeated.note() }
        do {
            try await until("repeated.value") { repeated.value }
        } catch {
            await source.releaseCatalog()
            await first.value
            await second.value
            throw error
        }
        let calls = await source.catalogRequestCount()
        XCTAssertEqual(calls, 1)
        await source.releaseCatalog()
        await first.value
        await second.value
        try await recorder.waitForSyntheticCatalog()
        let entries = try await store.entries(domain: .usage)
        let catalogAttempts = entries.filter {
            guard $0.kind == "usage_acquisition", case .object(let payload) = $0.payload else { return false }
            return payload["family"] == .string("catalog")
        }
        XCTAssertEqual(catalogAttempts.count, 1)
        guard case .object(let payload) = try XCTUnwrap(catalogAttempts.first).payload else {
            return XCTFail("missing inventory acquisition")
        }
        XCTAssertEqual(payload["returned_snapshots"], .integer(1))
        XCTAssertEqual(payload["returned_contexts"], .array([]))
        XCTAssertEqual(payload["last_source_update"], .null)
    }

    func testOrdinaryApprovalNeverFetchesOrManufacturesEmptyActivity() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        await source.configure(status: .approved)
        let recorder = recorder(root: root, store: store, source: source)
        let status = try await recorder.refreshAndWaitForCatalog(.manual)
        XCTAssertEqual(status.authorization, .approved)
        let metrics = await source.metrics()
        XCTAssertEqual(metrics.0, 0)
        let entries = try await store.entries(domain: .usage)
        XCTAssertTrue(entries.isEmpty)
    }

    func testThrottleManualBypassAndSnapshotReplayAcrossRelaunch() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let recorder = recorder(root: root, store: store, source: source)
        let first = try await recorder.refreshAndWaitForCatalog(.foreground)
        XCTAssertNotNil(first.lastCompleted)
        _ = try await recorder.refreshAndWaitForCatalog(.foreground)
        let throttled = await source.metrics()
        XCTAssertEqual(throttled.0, 9)
        let relaunched = self.recorder(root: root, store: store, source: source)
        _ = try await relaunched.refreshAndWaitForCatalog(.manual)
        let entries = try await store.entries(domain: .usage)
        XCTAssertEqual(entries.filter { $0.kind == "activity_segment" }.count, 10)
        XCTAssertEqual(entries.filter { $0.kind == "activity_catalog" }.count, 1)
        await source.configure(revision: 1)
        _ = try await relaunched.refreshAndWaitForCatalog(.manual)
        let changed = try await store.entries(domain: .usage)
        XCTAssertEqual(changed.filter { $0.kind == "activity_segment" }.count, 19)
    }

    func testPartialFetchDoesNotCompleteRecentCursorAndRetainsRawZeroAndNull() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        await source.configure(failAfterSegment: true)
        let recorder = recorder(root: root, store: store, source: source)
        let status = try await recorder.refreshAndWaitForCatalog(.manual)
        XCTAssertNil(status.lastCompleted)
        XCTAssertNotNil(status.error)
        let entries = try await store.entries(domain: .usage)
        let segment = try XCTUnwrap(entries.first { $0.kind == "activity_segment" })
        guard case .object(let payload) = segment.payload,
              case .object(let data)? = payload["data"] else { return XCTFail("missing raw fields") }
        XCTAssertEqual(data["firstPickup"], .null)
        XCTAssertEqual(data["totalPickupsWithoutApplicationActivity"], .integer(0))
        let attempts = entries.filter { $0.kind == "usage_acquisition" }
        XCTAssertTrue(attempts.contains {
            guard case .object(let payload) = $0.payload else { return false }
            return payload["outcome"] == .string("partial")
        })
    }

    func testConcurrentRequestsHaveOneSourceFlight() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let recorder = recorder(root: root, store: store, source: source)
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<20 { group.addTask { _ = try? await recorder.refreshAndWaitForCatalog(.foreground) } }
        }
        let metrics = await source.metrics()
        XCTAssertEqual(metrics.1, 1)
        XCTAssertEqual(metrics.0, 9)
    }

    func testMarkersPreserveDistinctDeliveriesAtEqualTimeAndRejectBadInputs() async throws {
        let (root, store) = try fixture()
        let recorder = recorder(root: root, store: store, source: SyntheticUsageSource())
        try await recorder.recordMarker(label: "Example App", event: "opened", createdAt: now)
        try await recorder.recordMarker(label: "Example App", event: "closed", createdAt: now)
        do {
            try await recorder.recordMarker(label: " ", event: "opened", createdAt: now)
            XCTFail("empty labels must fail")
        } catch {}
        let entries = try await store.entries(domain: .usage)
        XCTAssertEqual(entries.count, 2)
        XCTAssertNotEqual(entries[0].payload, entries[1].payload)
    }

    func testAdmissionFailureWritesNothing() async throws {
        let (root, store) = try fixture()
        let recorder = recorder(root: root, store: store, source: SyntheticUsageSource(), admit: {
            throw CaptureError.corruptState("fixture capture not launched")
        })
        do {
            try await recorder.recordMarker(label: "Example App", event: "opened", createdAt: now)
            XCTFail("admission should fail")
        } catch {}
        let entries = try await store.entries(domain: .usage)
        XCTAssertTrue(entries.isEmpty)
    }

    func testInboxDrainAcknowledgesOnlyAfterCaptureAndReplaysCrash() async throws {
        let (root, store) = try fixture()
        let inbox = UsageInbox(directory: root.appendingPathComponent("inbox"))
        let id = UUID()
        let payload: JSONValue = .object(["observed_at": .string(CaptureTime.rfc3339(now)),
                                          "callback": .string("intervalDidStart")])
        try inbox.publish(payload, deliveryID: id)
        let source = SyntheticUsageSource()
        await source.configure(status: .approved)
        let recorder = recorder(root: root, store: store, source: source, inbox: inbox)
        _ = try await recorder.refreshAndWaitForCatalog(.foreground)
        XCTAssertTrue(try inbox.pending().isEmpty)
        try inbox.publish(payload, deliveryID: id)
        _ = try await recorder.refreshAndWaitForCatalog(.foreground)
        let entries = try await store.entries(domain: .usage)
        XCTAssertEqual(entries.count, 1)
        XCTAssertTrue(try inbox.pending().isEmpty)
    }

    func testBackfillUsesDedicatedBoundedBatchAndResumes() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let recorder = recorder(root: root, store: store, source: source)
        let start = now.addingTimeInterval(-60 * 86400)
        try await recorder.beginBackfill(from: start, through: start.addingTimeInterval(5 * 86400))
        let state = try await recorder.refreshAndWaitForCatalog(.backfill)
        XCTAssertNotNil(state.backfillNext)
        let metrics = await source.metrics()
        XCTAssertEqual(metrics.0, 3)
        let cursor = try UsageCursor.load(root.appendingPathComponent("cursor.json"))
        XCTAssertGreaterThan(try XCTUnwrap(cursor.backfillNext), start)
    }
    func testScreenTimeReadsNoDayBeforeTheStart() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let today = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / 86400).rounded(.down) * 86400)
        let start = today.addingTimeInterval(-10 * 86400)
        let recorder = recorder(root: root, store: store, source: source, start: start)
        let status = await recorder.snapshot()
        XCTAssertEqual(status.earliest, start, "the picker's earliest day is the start")

        _ = try await recorder.refreshAndWaitForCatalog(.manual)
        let read = await source.requests()
        XCTAssertFalse(read.isEmpty)
        XCTAssertTrue(read.allSatisfy { $0.start >= start }, "the recent days and the audit keep to the start")

        try await recorder.beginBackfill(from: today.addingTimeInterval(-60 * 86400), through: today.addingTimeInterval(-5 * 86400))
        let cursor = try UsageCursor.load(root.appendingPathComponent("cursor.json"))
        XCTAssertEqual(cursor.backfillNext, start, "a backfill from before the start begins at it")

        do {
            try await recorder.beginBackfill(from: today.addingTimeInterval(-60 * 86400), through: today.addingTimeInterval(-30 * 86400))
            XCTFail("a range wholly before the start was taken")
        } catch { XCTAssertEqual(error as? CaptureError, .invalidEntry("Choose days on or after the start")) }
    }

    func testABackfillUnderWayStopsAtAStartMovedLater() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let today = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / 86400).rounded(.down) * 86400)
        let first = recorder(root: root, store: store, source: source)
        try await first.beginBackfill(from: today.addingTimeInterval(-60 * 86400), through: today.addingTimeInterval(-50 * 86400))
        let start = today.addingTimeInterval(-52 * 86400)
        let later = recorder(root: root, store: store, source: source, start: start)
        _ = try await later.refreshAndWaitForCatalog(.backfill)
        let read = await source.requests()
        XCTAssertEqual(read.map(\.start), [start, start.addingTimeInterval(86400), start.addingTimeInterval(2 * 86400)],
                       "the days before the moved start are skipped")
    }

    func testCancellationIsExplicitAndDoesNotAdvanceCursor() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let recorder = recorder(root: root, store: store, source: source)
        let running = Task { try await recorder.refreshAndWaitForCatalog(.manual) }
        while await source.metrics().0 == 0 { await Task.yield() }
        await recorder.cancelRefresh()
        let status = try await running.value
        XCTAssertNil(status.lastCompleted)
        let entries = try await store.entries(domain: .usage)
        XCTAssertTrue(entries.contains {
            guard case .object(let payload) = $0.payload else { return false }
            return payload["outcome"] == .string("cancelled")
        })
    }

    func testRevocationBeforeDeliveryDoesNotPersistSensitiveSegment() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        await source.revokeDuringFetch()
        let recorder = recorder(root: root, store: store, source: source)
        _ = try await recorder.refreshAndWaitForCatalog(.manual)
        let entries = try await store.entries(domain: .usage)
        XCTAssertFalse(entries.contains { $0.kind == "activity_segment" })
    }

    func testNestedRawFieldsAreRetainedWithoutSummingOrTranslation() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let nested: JSONValue = .array([.object([
            "category": .object(["name": .string("Example category"), "token": .string("opaque-category")]),
            "totalActivityDuration": .number(12.25),
            "applications": .array([.object([
                "application": .object(["bundleIdentifier": .string("com.example.synthetic"), "token": .null]),
                "totalActivityDuration": .number(8.125), "numberOfPickups": .integer(0),
                "numberOfNotifications": .integer(3)])]),
            "webDomains": .array([.object(["webDomain": .object(["domain": .string("example.com")]),
                                           "totalActivityDuration": .number(4.125)])])])])
        await source.setNested(nested)
        let recorder = recorder(root: root, store: store, source: source)
        _ = try await recorder.refreshAndWaitForCatalog(.manual)
        let entries = try await store.entries(domain: .usage)
        guard case .object(let envelope) = try XCTUnwrap(entries.first { $0.kind == "activity_segment" }).payload,
              case .object(let raw)? = envelope["data"] else { return XCTFail("missing snapshot") }
        XCTAssertEqual(raw["categories"], nested)
    }

    func testEmptySegmentsStillPreserveReportingContext() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        await source.setEmpty()
        let recorder = recorder(root: root, store: store, source: source)
        let status = try await recorder.refreshAndWaitForCatalog(.manual)
        XCTAssertNotNil(status.lastSourceUpdate)
        let entries = try await store.entries(domain: .usage)
        XCTAssertFalse(entries.contains { $0.kind == "activity_segment" })
        XCTAssertTrue(entries.contains {
            guard case .object(let payload) = $0.payload, case .array(let contexts)? = payload["returned_contexts"] else { return false }
            return !contexts.isEmpty
        })
    }

    func testAuditAdvancesAcrossSuccessiveCivilDays() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        let first = recorder(root: root, store: store, source: source)
        _ = try await first.refreshAndWaitForCatalog(.manual)
        let firstRequests = await source.requests()
        let nextDay = now.addingTimeInterval(86400)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let second = UsageRecorder(store: store, source: source, cursorURL: root.appendingPathComponent("cursor.json"),
                                   calendar: calendar, now: { nextDay }, start: { nil }, admit: {})
        _ = try await second.refreshAndWaitForCatalog(.manual)
        let allRequests = await source.requests()
        XCTAssertEqual(allRequests[17].start.timeIntervalSince(firstRequests[8].start), 86400)
    }

    func testBackfillHonorsDSTDayBoundaries() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let fixedNow = now
        let recorder = UsageRecorder(store: store, source: source, cursorURL: root.appendingPathComponent("cursor.json"),
                                     calendar: calendar, now: { fixedNow }, start: { nil }, admit: {})
        let start = calendar.date(from: DateComponents(year: 2026, month: 3, day: 7))!
        let end = calendar.date(from: DateComponents(year: 2026, month: 3, day: 9))!
        try await recorder.beginBackfill(from: start, through: end)
        _ = try await recorder.refreshAndWaitForCatalog(.backfill)
        let requests = await source.requests()
        XCTAssertEqual(requests.map(\.duration), [86400, 82800, 86400])
    }

    func testFailureBeforeSourceContextStillRetainsRequestProvenance() async throws {
        let (root, store) = try fixture()
        let source = SyntheticUsageSource()
        await source.failWithoutContext()
        let recorder = recorder(root: root, store: store, source: source)
        _ = try await recorder.refreshAndWaitForCatalog(.manual)
        let entries = try await store.entries(domain: .usage)
        guard case .object(let payload) = try XCTUnwrap(entries.first { $0.kind == "usage_acquisition" }).payload,
              case .object(let context)? = payload["request_context"],
              case .object(let scope)? = context["scope"] else { return XCTFail("missing request provenance") }
        XCTAssertEqual(scope["device"], .string("current"))
        XCTAssertEqual(scope["segment"], .string("hourly"))
        XCTAssertNotNil(context["osVersion"])
        XCTAssertNotNil(context["sdk"])
        XCTAssertEqual(payload["returned_contexts"], .array([]))
    }
}
