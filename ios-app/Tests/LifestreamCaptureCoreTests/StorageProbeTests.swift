import Foundation
import HomeLink
import Synchronization
import XCTest

@testable import LifestreamCaptureCore

final class StorageProbeTests: XCTestCase {
    private let night = Date(timeIntervalSince1970: 1_800_000_000)

    func testOnlyARefusalOfTheStoresClassEndsTheLaunch() throws {
        let cases: [(Int32, StorageProbe.Launch)] = [(EPERM, .locked), (EACCES, .locked), (ENOENT, .goOn), (EIO, .goOn)]
        for (code, expected) in cases {
            let root = try temporaryDirectory()
            var asked: [String] = []
            let launch = StorageProbe.launch(root: root, now: night) { path in
                asked.append(path)
                return code
            }
            XCTAssertEqual(launch, expected, "errno \(code)")
            XCTAssertEqual(asked, [root.appendingPathComponent("capture/capture.sqlite").path])
            XCTAssertEqual(try StorageProbe.marker(root: root)?.count, expected == .locked ? 1 : nil, "errno \(code)")
        }

        let root = try temporaryDirectory()
        let capture = root.appendingPathComponent("capture", isDirectory: true)
        try FileManager.default.createDirectory(at: capture, withIntermediateDirectories: true)
        try Data("a store".utf8).write(to: capture.appendingPathComponent("capture.sqlite"))
        XCTAssertEqual(StorageProbe.launch(root: root, now: night), .goOn)
        XCTAssertNil(try StorageProbe.marker(root: root))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(StorageProbe.markerName).path))
    }

    func testTwoLockedLaunchesAreStatedOnceThenForgotten() async throws {
        let root = try temporaryDirectory()
        XCTAssertEqual(StorageProbe.launch(root: root, now: night) { _ in EPERM }, .locked)
        XCTAssertEqual(StorageProbe.launch(root: root, now: night.addingTimeInterval(60)) { _ in EACCES }, .locked)
        let times = [night, night.addingTimeInterval(60)].map(CaptureTime.rfc3339)
        XCTAssertEqual(try StorageProbe.marker(root: root), StorageProbe.Marker(count: 2, at: times))

        let store = try await store(root)
        try await StorageProbe.stateLockedLaunches(root: root, into: store, now: night.addingTimeInterval(3_600))
        let stated = try await lifecycle(store)
        XCTAssertEqual(stated, [statement(count: 2, at: times)])
        XCTAssertNil(try StorageProbe.marker(root: root))

        try await StorageProbe.stateLockedLaunches(root: root, into: store, now: night.addingTimeInterval(7_200))
        let again = try await lifecycle(store)
        XCTAssertEqual(again.count, 1, "a launch with no marker writes nothing")
    }

    func testFortyLockedLaunchesKeepTheirCountAndTheNewest32Times() async throws {
        let root = try temporaryDirectory()
        let launches = (0..<40).map { night.addingTimeInterval(Double($0) * 60) }
        for at in launches { XCTAssertEqual(StorageProbe.launch(root: root, now: at) { _ in EPERM }, .locked) }
        let newest = launches.suffix(32).map(CaptureTime.rfc3339)
        XCTAssertEqual(try StorageProbe.marker(root: root), StorageProbe.Marker(count: 40, at: newest))

        let store = try await store(root)
        try await StorageProbe.stateLockedLaunches(root: root, into: store, now: night.addingTimeInterval(86_400))
        let stated = try await lifecycle(store)
        XCTAssertEqual(stated, [statement(count: 40, at: newest)])
    }

    func testAMarkerThatCannotBeWrittenStillEndsTheLaunch() throws {
        let root = try temporaryDirectory()
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root.path)
        addTeardownBlock { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path) }
        XCTAssertEqual(StorageProbe.launch(root: root, now: night) { _ in EPERM }, .locked)
        XCTAssertNil(try StorageProbe.marker(root: root))
    }

    func testARefusedAppendKeepsTheMarkerForALaunchWithRoom() async throws {
        let root = try temporaryDirectory()
        XCTAssertEqual(StorageProbe.launch(root: root, now: night) { _ in EPERM }, .locked)
        let free = Mutex<Int64?>(999_999_999)
        let store = try await CaptureStore.restored(
            root: root.appendingPathComponent("capture", isDirectory: true),
            volume: Volume(root, every: 0, read: { _ in free.withLock { $0 } }))
        do {
            try await StorageProbe.stateLockedLaunches(root: root, into: store, now: night.addingTimeInterval(3_600))
            XCTFail("a statement saved on a full disk")
        } catch { XCTAssertEqual(error as? CaptureError, .full) }
        let refused = try await lifecycle(store)
        XCTAssertEqual(refused, [])
        XCTAssertEqual(try StorageProbe.marker(root: root)?.count, 1, "the marker waits for a launch with room")

        free.withLock { $0 = nil }
        try await StorageProbe.stateLockedLaunches(root: root, into: store, now: night.addingTimeInterval(7_200))
        let stated = try await lifecycle(store)
        XCTAssertEqual(stated, [statement(count: 1, at: [CaptureTime.rfc3339(night)])])
        XCTAssertNil(try StorageProbe.marker(root: root))
    }

    func testAKillBeforeTheAppendLeavesTheMarker() async throws {
        let root = try temporaryDirectory()
        XCTAssertEqual(StorageProbe.launch(root: root, now: night) { _ in EPERM }, .locked)
        XCTAssertEqual(try StorageProbe.marker(root: root)?.count, 1)
        XCTAssertEqual(try StorageProbe.marker(root: root)?.count, 1)

        XCTAssertEqual(StorageProbe.launch(root: root, now: night.addingTimeInterval(60)) { _ in EPERM }, .locked)
        let store = try await store(root)
        try await StorageProbe.stateLockedLaunches(root: root, into: store, now: night.addingTimeInterval(3_600))
        let stated = try await lifecycle(store)
        XCTAssertEqual(stated, [statement(count: 2, at: [night, night.addingTimeInterval(60)].map(CaptureTime.rfc3339))])
    }

    func testAMarkerThatDoesNotReadIsRemovedAndStatesNothing() async throws {
        let root = try temporaryDirectory()
        let marker = root.appendingPathComponent(StorageProbe.markerName)
        try Data("not a marker".utf8).write(to: marker)
        let store = try await store(root)
        try await StorageProbe.stateLockedLaunches(root: root, into: store, now: night)
        let stated = try await lifecycle(store)
        XCTAssertEqual(stated, [], "its launches are lost, never stated as made up")
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path), "never a stuck file")
    }

    func testTheMarkerIsWrittenWithNoProtection() throws {
        let root = try temporaryDirectory()
        XCTAssertEqual(StorageProbe.launch(root: root, now: night) { _ in EPERM }, .locked)
        XCTAssertTrue(StorageProbe.markerWriting.contains(.noFileProtection))
        XCTAssertNotNil(try StorageProbe.marker(root: root))
        #if os(iOS)
            let marker = root.appendingPathComponent(StorageProbe.markerName)
            let attributes = try FileManager.default.attributesOfItem(atPath: marker.path)
            XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, FileProtectionType.none)
        #endif
    }


    private func store(_ root: URL) async throws -> CaptureStore {
        try await CaptureStore.restored(root: root.appendingPathComponent("capture", isDirectory: true))
    }

    private func lifecycle(_ store: CaptureStore) async throws -> [JSONValue] {
        try await store.entries(domain: .location).filter { $0.kind == "lifecycle" }.map(\.payload)
    }

    private func statement(count: Int, at: [String]) -> JSONValue {
        .object([
            "event": .string("launched_before_first_unlock"),
            "detail": .object(["count": .integer(Int64(count)), "at": .array(at.map(JSONValue.string))]),
        ])
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-probe-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
