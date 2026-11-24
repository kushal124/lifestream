import CoreLocation
import Foundation
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

private actor SuspendedRecorderWrite {
    private var isPaused = false
    private var isReleased = false
    private var pauseWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func pause() async {
        isPaused = true
        let waiters = pauseWaiters
        pauseWaiters.removeAll(keepingCapacity: true)
        for waiter in waiters { waiter.resume() }
        guard !isReleased else { return }
        await withCheckedContinuation { releaseContinuation = $0 }
    }

    func waitUntilPaused() async {
        guard !isPaused else { return }
        await withCheckedContinuation { pauseWaiters.append($0) }
    }

    func release() {
        isReleased = true
        releaseContinuation?.resume()
        releaseContinuation = nil
    }
}

@MainActor
final class PersistenceFailureTests: XCTestCase {
    func testTrackingIntentLoadDistinguishesMissingLoadedAndFailedFiles() throws {
        let root = try temporaryDirectory()
        let missingStore = TrackingIntentStore(url: root.appendingPathComponent("missing.json"))
        guard case .missing = missingStore.loadState() else {
            return XCTFail("a missing intent must remain distinguishable")
        }

        let intent = try trackingIntent()
        let loadedStore = TrackingIntentStore(url: root.appendingPathComponent("loaded.json"))
        try loadedStore.save(intent)
        guard case .loaded(let loaded) = loadedStore.loadState() else {
            return XCTFail("a valid intent must load")
        }
        XCTAssertEqual(loaded, intent)

        let failedURL = root.appendingPathComponent("failed.json", isDirectory: true)
        try FileManager.default.createDirectory(at: failedURL, withIntermediateDirectories: false)
        let failedStore = TrackingIntentStore(url: failedURL)
        guard case .failed(let diagnostic) = failedStore.loadState() else {
            return XCTFail("an unreadable intent must not look missing")
        }
        XCTAssertTrue(diagnostic.localizedCaseInsensitiveContains("tracking intent"))
    }

    func testTrackingIntentSaveReportsVisibleBytesWhenDirectorySyncIsUnavailable() throws {
        let root = try temporaryDirectory()
        let parent = root.appendingPathComponent("intent", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        let store = TrackingIntentStore(url: parent.appendingPathComponent("tracking-intent.json"))
        let intent = try trackingIntent()
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: parent.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: parent.path
            )
        }

        let result = try store.save(intent)

        guard case .visibleButDurabilityUnconfirmed(let diagnostic) = result else {
            return XCTFail("the published intent must expose its directory-sync ambiguity")
        }
        XCTAssertFalse(diagnostic.isEmpty)
        XCTAssertEqual(try store.load(), intent)
    }

    func testCorruptTrackingIntentDoesNotBecomeAuthorizationBlocked() throws {
        let root = try temporaryDirectory()
        let intentURL = root.appendingPathComponent("tracking-intent.json")
        try Data("not-json".utf8).write(to: intentURL)
        let coordinator = try locationCoordinator(root: root, intentURL: intentURL)

        coordinator.bootstrap()

        XCTAssertNil(coordinator.serviceRequested)
        XCTAssertEqual(coordinator.coverageState, .unknown)
        XCTAssertEqual(coordinator.operationalState, "not_started")
        XCTAssertNotNil(coordinator.persistenceDiagnostic)
    }

    func testSemanticallyInvalidTrackingIntentDoesNotStartOrRewriteCapture() throws {
        let root = try temporaryDirectory()
        let intentURL = root.appendingPathComponent("tracking-intent.json")
        let corrupt = Data(
            #"{"armed":true,"coverage_state":"not-a-coverage-state","boot_id":"00000000-0000-0000-0000-000000000001"}"#
                .utf8
        )
        try corrupt.write(to: intentURL)
        let coordinator = try locationCoordinator(root: root, intentURL: intentURL)

        coordinator.bootstrap()

        XCTAssertNil(coordinator.serviceRequested)
        XCTAssertEqual(coordinator.coverageState, .unknown)
        XCTAssertEqual(coordinator.operationalState, "not_started")
        XCTAssertNotNil(coordinator.persistenceDiagnostic)
        XCTAssertEqual(try Data(contentsOf: intentURL), corrupt)
    }

    func testAuthorizationCallbackBeforeStartWritesNoCaptureHistory() async throws {
        let root = try temporaryDirectory()
        let coordinator = try locationCoordinator(
            root: root,
            intentURL: root.appendingPathComponent("tracking-intent.json")
        )

        coordinator.locationManagerDidChangeAuthorization(CLLocationManager())
        await coordinator.awaitBootstrapBarrier()
        try await coordinator.store.flush()

        let entries = try await coordinator.store.entries(domain: .location)
        XCTAssertTrue(entries.isEmpty)
    }

    func testDisabledPlatformServicesNeverOpenTheCatchGeofenceMonitor() async throws {
        let root = try temporaryDirectory()
        let coordinator = try locationCoordinator(
            root: root,
            intentURL: root.appendingPathComponent("tracking-intent.json")
        )
        coordinator.startCatchGeofenceMonitor(replacingAt: nil)
        await coordinator.awaitBootstrapBarrier()
        try await coordinator.store.flush()

        let entries = try await coordinator.store.entries(domain: .location)
        XCTAssertTrue(entries.isEmpty)
    }

    func testInitialCaptureDoesNotStartWhenIntentCannotBePersisted() throws {
        let root = try temporaryDirectory()
        let blockedParent = root.appendingPathComponent("regular-file")
        try Data("not-a-directory".utf8).write(to: blockedParent)
        let coordinator = try locationCoordinator(
            root: root,
            intentURL: blockedParent.appendingPathComponent("tracking-intent.json")
        )

        XCTAssertThrowsError(try coordinator.armAndRequestAuthorization())
        XCTAssertNil(coordinator.serviceRequested)
        XCTAssertEqual(coordinator.operationalState, "not_started")
        XCTAssertNotNil(coordinator.persistenceDiagnostic)
    }

    func testInitialCaptureAndRetryRequireDurableIntent() throws {
        let root = try temporaryDirectory()
        let parent = root.appendingPathComponent("intent", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        let intentURL = parent.appendingPathComponent("tracking-intent.json")
        let coordinator = try locationCoordinator(root: root, intentURL: intentURL)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: parent.path
        )
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: parent.path
            )
        }

        XCTAssertThrowsError(try coordinator.armAndRequestAuthorization())
        XCTAssertNotEqual(coordinator.serviceRequested, true)
        XCTAssertEqual(coordinator.operationalState, "not_started")
        XCTAssertNotNil(coordinator.persistenceDiagnostic)

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: parent.path
        )
        let relaunched = try locationCoordinator(root: root, intentURL: intentURL)
        relaunched.bootstrap()
        XCTAssertEqual(relaunched.serviceRequested, true)
        XCTAssertNil(relaunched.persistenceDiagnostic)

        XCTAssertNoThrow(try coordinator.armAndRequestAuthorization())
        XCTAssertEqual(coordinator.serviceRequested, true)
        XCTAssertNil(coordinator.persistenceDiagnostic)

        try FileManager.default.setAttributes(
            [.posixPermissions: 0o300],
            ofItemAtPath: parent.path
        )
        XCTAssertThrowsError(try coordinator.armAndRequestAuthorization())
        XCTAssertNotNil(coordinator.persistenceDiagnostic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: parent.path
        )
        XCTAssertNoThrow(try coordinator.armAndRequestAuthorization())
        XCTAssertNil(coordinator.persistenceDiagnostic)
    }

    func testARelaunchStartsItsGapAtTheStoresNewestFix() async throws {
        let root = try temporaryDirectory()
        let intentURL = root.appendingPathComponent("tracking-intent.json")
        let first = try locationCoordinator(root: root, intentURL: intentURL)
        try first.armAndRequestAuthorization()
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let configuration = RequestedLocationConfiguration(
            desiredAccuracy: 10, distanceFilter: 0, activityType: .other, pausesAutomatically: false)
        first.handleLegacyBatch([fix(at: start), fix(at: start.addingTimeInterval(60))],
            acquisitionPath: "synthetic", configuration: configuration)
        first.handleLegacyBatch([fix(at: start.addingTimeInterval(-30))],
            acquisitionPath: "synthetic", configuration: configuration)
        await first.awaitBootstrapBarrier()
        try await first.store.flush()
        let fixes = try await first.store.entries(domain: .location).filter { $0.kind == "fix" }
        XCTAssertEqual(fixes.count, 3)
        let newest = fixes[1]
        let intent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: intentURL)) as? [String: Any])
        XCTAssertEqual(Set(intent.keys), ["armed", "coverage_state", "boot_id"])

        let relaunched = LocationRecorderCoordinator(store: first.store, intentStore: TrackingIntentStore(url: intentURL),
            bootID: UUID(), platformServicesEnabled: false)
        relaunched.bootstrap()
        let back = start.addingTimeInterval(600)
        relaunched.handleLegacyBatch([fix(at: back)], acquisitionPath: "synthetic", configuration: configuration)
        await relaunched.awaitBootstrapBarrier()
        try await first.store.flush()
        let gaps = try await first.store.entries(domain: .location).filter { $0.kind == "gap" }
        XCTAssertEqual(gaps.count, 1)
        guard case .object(let gap) = try XCTUnwrap(gaps.first).payload else { return XCTFail("a gap is an object") }
        XCTAssertEqual(gap["start"], .string(newest.observedAt))
        XCTAssertEqual(gap["bounding_previous_fix_sequence"], .integer(Int64(newest.sequence)))
        XCTAssertEqual(gap["end"], .string(CaptureTime.rfc3339(back)))
        XCTAssertEqual(gap["reason"], .string("reboot_or_preunlock_absence"))
    }

    func testARelaunchIsARebootOnlyWhenBothBootSessionsAreKnownAndDiffer() async throws {
        let session = UUID()
        let cases: [(UUID?, UUID?, String)] = [
            (session, UUID(), "reboot_or_preunlock_absence"),
            (session, session, "unknown_process_absence"),
            (session, nil, "unknown_process_absence"),
            (nil, session, "unknown_process_absence"),
        ]
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let configuration = RequestedLocationConfiguration(
            desiredAccuracy: 10, distanceFilter: 0, activityType: .other, pausesAutomatically: false)
        for (before, after, reason) in cases {
            let root = try temporaryDirectory()
            let intentURL = root.appendingPathComponent("tracking-intent.json")
            let first = try locationCoordinator(root: root, intentURL: intentURL, bootID: before)
            try first.armAndRequestAuthorization()
            first.handleLegacyBatch([fix(at: start)], acquisitionPath: "synthetic", configuration: configuration)
            await first.awaitBootstrapBarrier()
            try await first.store.flush()
            let relaunched = LocationRecorderCoordinator(store: first.store, intentStore: TrackingIntentStore(url: intentURL),
                bootID: after, platformServicesEnabled: false)
            relaunched.bootstrap()
            relaunched.handleLegacyBatch([fix(at: start.addingTimeInterval(600))], acquisitionPath: "synthetic", configuration: configuration)
            await relaunched.awaitBootstrapBarrier()
            try await first.store.flush()
            let gaps = try await first.store.entries(domain: .location).filter { $0.kind == "gap" }
            guard case .object(let gap) = try XCTUnwrap(gaps.first).payload else { return XCTFail("a gap is an object") }
            XCTAssertEqual(gaps.count, 1)
            XCTAssertEqual(gap["reason"], .string(reason), "\(String(describing: before)) then \(String(describing: after))")
        }
    }

    private func fix(at date: Date) -> CLLocation {
        CLLocation(coordinate: .init(latitude: 10, longitude: 20), altitude: 0, horizontalAccuracy: 10,
            verticalAccuracy: 10, course: -1, speed: -1, timestamp: date)
    }

    func testStartingAgainPreservesPersistedCoverage() throws {
        let root = try temporaryDirectory()
        let intentURL = root.appendingPathComponent("tracking-intent.json")
        let persisted = try trackingIntent(coverageState: .stationaryAutoPaused)
        try TrackingIntentStore(url: intentURL).save(persisted)
        let coordinator = try locationCoordinator(root: root, intentURL: intentURL)

        try coordinator.restoreOrArm()

        XCTAssertEqual(coordinator.coverageState, .stationaryAutoPaused)
        XCTAssertEqual(coordinator.serviceRequested, true)
        XCTAssertNil(coordinator.persistenceDiagnostic)
    }

    func testDeliberateCrashWaitsForDurableMarkerBehindQueuedWrites() async throws {
        let root = try temporaryDirectory()
        let intentURL = root.appendingPathComponent("tracking-intent.json")
        try TrackingIntentStore(url: intentURL).save(trackingIntent())
        let writeQueue = MainActorTaskQueue()
        let coordinator = try locationCoordinator(
            root: root,
            intentURL: intentURL,
            writeQueue: writeQueue
        )
        let suspendedWrite = SuspendedRecorderWrite()
        writeQueue.enqueue {
            await suspendedWrite.pause()
        }
        await suspendedWrite.waitUntilPaused()

        var requestStarted = false
        var crashScheduled = false
        let request = Task { @MainActor in
            requestStarted = true
            try await DeliberateCrashRequest.persistMarkerThenSchedule(
                persistMarker: {
                    try await coordinator.recordExperimentMarker(
                        "e2_deliberate_crash_requested",
                        observedAt: "2026-08-27T12:34:56.000000000Z"
                    )
                },
                scheduleCrash: {
                    crashScheduled = true
                }
            )
        }
        while !requestStarted {
            await Task.yield()
        }

        XCTAssertFalse(crashScheduled)
        let entriesWhileBlocked = try await coordinator.store.entries(domain: .location)
        XCTAssertTrue(entriesWhileBlocked.isEmpty)

        await suspendedWrite.release()
        try await request.value

        XCTAssertTrue(crashScheduled)
        let entries = try await coordinator.store.entries(domain: .location)
        XCTAssertEqual(entries.count, 1)
        guard case .object(let payload) = entries[0].payload,
            case .object(let detail)? = payload["detail"]
        else {
            return XCTFail("deliberate-crash marker payload shape changed")
        }
        XCTAssertEqual(payload["event"], .string("experiment_marker"))
        XCTAssertEqual(
            detail["marker"],
            .string("e2_deliberate_crash_requested")
        )
    }

    private func trackingIntent(
        armed: Bool = true,
        coverageState: CoverageState = .stationaryAutoPaused
    ) throws -> TrackingIntent {
        TrackingIntent(armed: armed, coverageState: coverageState, bootID: UUID())
    }

    private func locationCoordinator(
        root: URL,
        intentURL: URL,
        bootID: UUID? = UUID(),
        writeQueue: MainActorTaskQueue? = nil
    ) throws
        -> LocationRecorderCoordinator
    {
        let store = try CaptureStore(
            root: root.appendingPathComponent("capture", isDirectory: true)
        )
        return LocationRecorderCoordinator(
            store: store,
            intentStore: TrackingIntentStore(url: intentURL),
            bootID: bootID,
            platformServicesEnabled: false,
            writeQueue: writeQueue
        )
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "lifestream-persistence-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
