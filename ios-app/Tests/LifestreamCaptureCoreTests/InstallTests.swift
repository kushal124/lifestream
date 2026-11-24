import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class InstallTests: XCTestCase {
    func testAFreshInstallMintsOneInstallWithItsTablesThatSurvivesRelaunch() async throws {
        let root = try temporaryDirectory()
        let capture = root.appendingPathComponent("capture", isDirectory: true)
        let store = try CaptureStore(root: capture)
        let id = try XCTUnwrap(UUID(uuidString: store.install.id))
        XCTAssertEqual(store.install.id, id.uuidString)
        XCTAssertEqual(try fact("install_id", in: capture), store.install.id, "in the database before any write")
        XCTAssertNotNil(CaptureTime.date(rfc3339: store.install.createdAt))
        let relaunched = try CaptureStore(root: capture)
        XCTAssertEqual(relaunched.install, store.install)

        _ = try await relaunched.append(domain: .location, draft: draft(at: 0))
        let bundle = try await sealed(relaunched, root: root)
        let device = try rawDevice(bundle)
        XCTAssertEqual(bundle.manifest.schemaVersion, 3)
        XCTAssertEqual(device.keys.sorted(), ["enrolled_at", "install_id", "machine_model", "marketing_name", "os_version"])
        XCTAssertEqual(bundle.manifest.device.installID, store.install.id)
        XCTAssertEqual(bundle.manifest.device.enrolledAt, store.install.createdAt)

        try report("fresh_install", [
            "install_survives_relaunch": relaunched.install == store.install,
            "manifest_schema": bundle.manifest.schemaVersion, "manifest_device_members": device.keys.sorted(),
            "states_serial": device["pasted_serial"] != nil || device["daily_phone_since"] != nil,
        ])
    }


    private func draft(at second: Int) -> CaptureDraft {
        .init(kind: "lifecycle", observedAt: "2026-09-01T00:00:0\(second)Z", payload: .object(["event": .string("synthetic")]))
    }

    private func sealed(_ store: CaptureStore, root: URL) async throws -> BuiltExportBundle {
        let exporter = CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports"))
        let bundle = try await exporter.sealEverything()
        return try XCTUnwrap(bundle)
    }

    private func rawDevice(_ bundle: BuiltExportBundle) throws -> [String: Any] {
        let manifest = try JSONEncoder.lifestream().encode(try StoredZIPWriter.readManifest(from: bundle.url))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: manifest) as? [String: Any])
        return try XCTUnwrap(object["device"] as? [String: Any])
    }

    private func fact(_ key: String, in capture: URL) throws -> String? {
        let database = try SQLiteDatabase(url: capture.appendingPathComponent("capture.sqlite"))
        return try CaptureStore.fact(key, in: database)
    }

    private func report(_ name: String, _ scenario: [String: Any]) throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e/install.json")
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        all[name] = scenario
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: all, options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-install-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
