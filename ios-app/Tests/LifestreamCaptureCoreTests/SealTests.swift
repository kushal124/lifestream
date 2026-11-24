import Foundation
import HomeLink
import Synchronization
import XCTest

@testable import LifestreamCaptureCore

final class SealTests: XCTestCase {
    func testSealCarriesEachSourceAfterItsPositionAndTheBlobsItsEntriesReference() async throws {
        let (store, exporter) = try rig()
        let shared = try await store.storeBlob(Data("shared".utf8))
        let photo = try await store.storeBlob(Data("photo".utf8))
        for second in 0..<3 { try await append(store, .location, at: second) }
        try await append(store, .camera, at: 3, blob: shared)
        try await append(store, .photos, at: 4, blob: photo)

        let first = try await sealed(exporter)
        XCTAssertEqual(first.manifest.schemaVersion, 3)
        XCTAssertEqual(first.manifest.device.installID, store.install.id)
        XCTAssertEqual(range(first, .location), [1, 3])
        XCTAssertEqual(range(first, .camera), [1, 1])
        XCTAssertNil(first.manifest.files["motion.jsonl"], "a domain with nothing new is not carried")
        XCTAssertEqual(blobs(first), [shared, photo])
        XCTAssertEqual(first.manifest.custody, ["location:local:unit-0001": SourceCustody(seal: 1),
                                                "camera:local:unit-0001": SourceCustody(seal: 1),
                                                "apple-photos:local:unit-0001": SourceCustody(seal: 1)],
                       "one seal per source carried, none for a source with nothing")
        XCTAssertEqual(first.url.lastPathComponent, CaptureExporter.filename(for: first.manifest.bundleID))
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(
            with: JSONEncoder.lifestream().encode(first.manifest)) as? [String: Any])
        XCTAssertNil(manifest["export_sequence"])
        XCTAssertNil(manifest["previous_bundle_id"])
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: first.url), first.manifest)
        var identity = manifest
        identity["bundle_id"] = nil
        let canonical = try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys, .withoutEscapingSlashes])
        XCTAssertEqual(SHA256Digest.tagged(canonical), first.manifest.bundleID)

        let again = try await sealed(exporter, now: Date(timeIntervalSince1970: 1_900_000_000))
        XCTAssertEqual(range(again, .location), [1, 3])

        let carried: [CaptureDomain: UInt64] = [.location: 3, .camera: 1, .photos: 1]
        let nothing = try await exporter.seal(plan(after: carried, seal: 2), hardware: .synthetic, appVersion: "1").bundles.first
        XCTAssertNil(nothing)

        try await append(store, .location, at: 5)
        try await append(store, .camera, at: 6, blob: shared)
        let next = try await sealed(exporter, after: carried, seal: 2)
        XCTAssertEqual(range(next, .location), [4, 4])
        XCTAssertEqual(range(next, .camera), [2, 2])
        XCTAssertNil(next.manifest.files["photos.jsonl"])
        XCTAssertEqual(blobs(next), [shared])
        XCTAssertEqual(next.manifest.custody["location:local:unit-0001"], SourceCustody(seal: 2))
    }

    func testImportedPhotoClearingKeepsNewerAndSharedBytesAndASealBelowTheFloorStatesTheCopiesLost() async throws {
        let (store, exporter) = try rig()
        let old = try await store.storeBlob(Data([1]))
        let shared = try await store.storeBlob(Data([2]))
        try await append(store, .photos, at: 0, blob: old)
        try await append(store, .photos, at: 1, blob: shared)
        try await append(store, .camera, at: 1, blob: shared)
        let newer = try await store.storeBlob(Data([3]))
        try await append(store, .photos, at: 2, blob: newer)
        let log = try await store.jsonl(.photos)

        try await store.clearImportedPhotos(through: 2)
        let remaining = try await store.validatedBlobInventory().map(\.hash)
        XCTAssertEqual(Set(remaining), [shared, newer])
        let kept = try await store.jsonl(.photos)
        XCTAssertEqual(kept, log, "The store keeps every entry")
        let floor = try await store.photoExportFloor()
        XCTAssertEqual(floor, 2)

        let reshipped = try await sealed(exporter)
        XCTAssertEqual(range(reshipped, .photos), [1, 3])
        XCTAssertEqual(blobs(reshipped), [shared, newer])
        XCTAssertEqual(reshipped.manifest.custody["apple-photos:local:unit-0001"]?.lost,
                       [Lost(items: 1, what: CaptureExporter.clearedPhotoCopies)])
        let above = try await sealed(exporter, after: [.photos: 2], seal: 2)
        XCTAssertEqual(range(above, .photos), [3, 3])
        XCTAssertNil(above.manifest.custody["apple-photos:local:unit-0001"]?.lost)
    }

    func testNoCaptureEntryIsEverDeleted() async throws {
        let (store, _) = try rig()
        try await append(store, .location, at: 0)
        try await append(store, .location, at: 1)
        let database = try SQLiteDatabase(url: store.databaseURL)
        XCTAssertThrowsError(try database.run("DELETE FROM location WHERE sequence = 2"))
        let captured = try await store.capturedThrough()
        XCTAssertEqual(captured[.location], 2, "the newest sequence is never given out again")
    }

    func testTheCaptureFolderIsLeftOutOfBackups() async throws {
        let (store, _) = try rig()
        let values = try await store.root.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true, "a restored backup starts a new install")
    }

    func testMixedRFC3339ShapesProduceChronologicalBounds() async throws {
        let (store, exporter) = try rig()
        let halfSecond = "2026-08-27T12:00:00.500000000Z", wholeSecond = "2026-08-27T12:00:00Z"
        _ = try await store.append(domain: .location, draft: .init(kind: "fix", observedAt: halfSecond, payload: .object([:])))
        _ = try await store.append(domain: .health, draft: .init(kind: "sample", observedAt: wholeSecond, payload: .object([:])))
        let bundle = try await sealed(exporter)
        XCTAssertEqual(bundle.manifest.timeRangeCovered.start, wholeSecond)
        XCTAssertEqual(bundle.manifest.timeRangeCovered.end, halfSecond)
    }

    func testACorruptBlobSitsItsSourceOutAndAMissingOneIsStatedLost() async throws {
        for mutation in ["corrupt", "missing"] {
            let (store, exporter) = try rig()
            let hash = try await store.storeBlob(Data("route bytes".utf8))
            try await append(store, .health, at: 0, blob: hash)
            try await append(store, .location, at: 1)
            let inventory = try await store.validatedBlobInventory()
            let original = try XCTUnwrap(inventory.first).url
            if mutation == "corrupt" {
                try Data("different bytes".utf8).write(to: original)
            } else {
                try FileManager.default.moveItem(at: original, to: original.deletingLastPathComponent()
                    .appendingPathComponent(String(repeating: "0", count: 64)))
            }
            let made = try await exporter.seal(plan(), hardware: .synthetic, appVersion: "1")
            let bundle = try XCTUnwrap(made.bundles.first, mutation)
            XCTAssertEqual(range(bundle, .location), [1, 1], "every other source seals: \(mutation)")
            XCTAssertTrue(blobs(bundle).isEmpty, mutation)
            if mutation == "corrupt" {
                XCTAssertEqual(Array(made.satOut.keys), ["apple-health:local:unit-0001"])
                XCTAssertEqual(bundle.manifest.satOut, ["apple-health:local:unit-0001"])
                XCTAssertNil(bundle.manifest.files["health.jsonl"])
                XCTAssertNil(bundle.manifest.custody["apple-health:local:unit-0001"], "no seal spent")
            } else {
                XCTAssertEqual(made.satOut, [:])
                XCTAssertNil(bundle.manifest.satOut)
                XCTAssertEqual(range(bundle, .health), [1, 1], "the entry ships")
                XCTAssertEqual(bundle.manifest.custody["apple-health:local:unit-0001"]?.lost,
                               [Lost(items: 1, what: CaptureExporter.missingFiles)])
            }
        }
    }

    func testAFileTheHomeHoldsIsNamedNotCarriedAndNeverStatedLost() async throws {
        let (store, exporter) = try rig()
        let homes = try await store.storeBlob(Data("a photo the home holds".utf8))
        let lacked = try await store.storeBlob(Data("a photo the home lacks".utf8))
        try await append(store, .photos, at: 0, blob: homes)
        try await append(store, .photos, at: 1, blob: lacked)
        let asked = try await store.namedBlobs(plan().map { ($0.domain, $0.after) })
        XCTAssertEqual(asked, [homes, lacked], "the door is asked of every file the entries name")
        let held = asked.intersection([homes])
        let firstMade = try await exporter.seal(plan(), held: held, hardware: .synthetic, appVersion: "1")
        let first = try XCTUnwrap(firstMade.bundles.first)
        XCTAssertEqual(blobs(first), [lacked], "the file the home holds is not carried")
        XCTAssertNil(first.manifest.custody["apple-photos:local:unit-0001"]?.lost)
        let lines = String(decoding: try await store.jsonl(.photos), as: UTF8.self)
        XCTAssertTrue(lines.contains(homes), "and is named in its entry")

        try await store.clearImportedPhotos(through: 2)
        let left = try await store.validatedBlobInventory()
        XCTAssertEqual(left.count, 0)

        let againMade = try await exporter.seal(plan(), held: held, hardware: .synthetic, appVersion: "1")
        let again = try XCTUnwrap(againMade.bundles.first)
        XCTAssertEqual(blobs(again), [])
        XCTAssertEqual(again.manifest.custody["apple-photos:local:unit-0001"]?.lost,
                       [Lost(items: 1, what: CaptureExporter.clearedPhotoCopies)], "only the copy the home lacks is lost")
        try artifact("phone-held.json", ["carried": blobs(first).sorted(), "named": [homes], "asked": asked.sorted(),
                                         "lost_after_clearing": again.manifest.custody["apple-photos:local:unit-0001"]?.lost?.map(\.items) ?? []])
    }

    func testAGoneCarriesNoFile() async throws {
        let (store, _) = try rig()
        let hash = SHA256Digest.tagged(Data("a photo".utf8))
        for kind in ["gone", "resource_availability"] {
            _ = try await store.append(domain: .photos, draft: .init(kind: kind, observedAt: "2026-09-01T00:00:00Z",
                payload: .object(["blob": .object(["hash": .string(hash)]), "kind": .string("gone")])))
        }
        let lines = try await store.jsonl(.photos).split(separator: 0x0A).map { Data($0) }
        XCTAssertEqual(try CaptureStore.blobHashes(in: lines[0]), [], "a gone's hash is identity, never a file")
        XCTAssertEqual(try CaptureStore.blobHashes(in: lines[1]), [hash], "a payload's own kind is not the entry's")
        let blob = "{\"hash\":\"\(hash)\"}"
        let laterKind = { (payload: String, kind: String) in Data("{\"payload\":{\"kind\":\"\(payload)\",\"blob\":\(blob)},\"kind\":\"\(kind)\"}".utf8) }
        XCTAssertEqual(try CaptureStore.blobHashes(in: laterKind("gone", "resource_availability")), [hash])
        XCTAssertEqual(try CaptureStore.blobHashes(in: laterKind("asset", "gone")), [])
    }

    func testASealInWhichEverySourceWithSomethingNewSatOutThrows() async throws {
        let (store, exporter) = try rig()
        let hash = try await store.storeBlob(Data("route bytes".utf8))
        try await append(store, .health, at: 0, blob: hash)
        let inventory = try await store.validatedBlobInventory()
        try Data("different bytes".utf8).write(to: try XCTUnwrap(inventory.first).url)
        do {
            let made = try await exporter.seal(plan(), hardware: .synthetic, appVersion: "1")
            XCTFail("a seal that sealed no source returned \(made)")
        } catch let error as CaptureError {
            XCTAssertTrue(String(describing: error).contains("apple-health:local:unit-0001"), "it names what sat out: \(error)")
        }
    }

    func testSemanticPayloadValidationIsLeftToTheMacAndBytesShipUnchanged() async throws {
        let (store, exporter) = try rig()
        try await append(store, .location, at: 0)
        let line = try await store.jsonl(.location).dropLast()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line)) as? [String: Any])
        object["schema_version"] = 2
        let changed = try JSONSerialization.data(withJSONObject: object)
        let database = try SQLiteDatabase(url: store.databaseURL)
        try database.run("UPDATE location SET line = ? WHERE sequence = 1", .blob(changed))
        let bundle = try await sealed(exporter)
        XCTAssertEqual(bundle.manifest.files[CaptureDomain.location.filename]?.sha256,
            SHA256Digest.tagged(changed + Data([0x0A])))
    }

    func testA600LineDeliverySealedMidWayLandsWholeInOneBundle() async throws {
        let (store, exporter) = try rig()
        let deliveries = 6
        let writer = Task {
            for delivery in 0..<deliveries {
                _ = try await store.appendBatch(domain: .health, drafts: (0..<600).map { member in
                    .init(kind: "sample", observedAt: "2026-09-01T00:00:00Z", payload: .object([
                        "uuid": .string(UUID().uuidString.lowercased()),
                        "delivery": .integer(Int64(delivery)), "member": .integer(Int64(member)),
                        "padding": .string(String(repeating: "x", count: 1_024)),
                    ]))
                })
            }
        }
        var seen = Set<UInt64>()
        while true {
            let finished = try await store.capturedThrough()[.health] == UInt64(600 * deliveries)
            if let bundle = try await exporter.sealEverything() {
                let health = bundle.manifest.files[CaptureDomain.health.filename]?.observations ?? 0
                XCTAssertEqual(health % 600, 0, "a seal split a delivery: \(health) lines")
                seen.insert(health)
                try FileManager.default.removeItem(at: bundle.url)
            }
            if finished { break }
        }
        try await writer.value
        XCTAssertTrue(seen.contains(UInt64(600 * deliveries)))
    }

    func testABundleTheDiskHasNoRoomForWaitsAndTheSmallOnesGo() async throws {
        let root = try temporaryDirectory()
        let free = Mutex<Int64?>(Room.keepBytes)
        let store = try CaptureStore(root: root.appendingPathComponent("capture"),
                                     volume: Volume(root, every: 0, read: { _ in free.withLock { $0 } }))
        let exporter = CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports"))
        let video = try await store.storeBlob(Data(repeating: 0x56, count: Int(CaptureExporter.sharedBytes)))
        try await append(store, .location, at: 0)
        try await append(store, .photos, at: 1, blob: video)

        free.withLock { $0 = Room.bottomBytes + 1_000_000 }
        let tight = try await exporter.seal(plan(), hardware: .synthetic, appVersion: "1")
        XCTAssertEqual(tight.bundles.map { Set($0.manifest.custody.keys) }, [["location:local:unit-0001"]], "location's bundle goes")
        XCTAssertEqual(tight.satOut, [:], "the photos waiting for room is no failure")
        XCTAssertEqual(tight.bundles.first?.manifest.satOut?.contains("apple-photos:local:unit-0001"), true,
                       "location's bundle cannot speak for photos")
        let toFree = try XCTUnwrap(tight.toFree, "the bytes to free are said")
        XCTAssertTrue((Int64(CaptureExporter.sharedBytes) - 1_000_000..<Int64(CaptureExporter.sharedBytes) - 800_000).contains(toFree),
                      "\(toFree)")
        do {
            _ = try await exporter.copy(hardware: .synthetic, appVersion: "1")
            XCTFail("the person's copy on a disk with no room for it")
        } catch { XCTAssertEqual(error as? CaptureError, .full) }

        free.withLock { $0 = Room.keepBytes }
        let roomy = try await exporter.seal(plan(after: [.location: 1]), hardware: .synthetic, appVersion: "1")
        XCTAssertEqual(roomy.bundles.map { Set($0.manifest.custody.keys) }, [["apple-photos:local:unit-0001"]])
        XCTAssertEqual(roomy.bundles.first.map(blobs), [video])
        XCTAssertNil(roomy.toFree, "every bundle made: nothing to free")
    }

    func testRemovingBundlesKeepsOnlyTheNamesKept() async throws {
        let root = try temporaryDirectory()
        let exports = root.appendingPathComponent("exports", isDirectory: true)
        let store = try CaptureStore(root: root.appendingPathComponent("capture", isDirectory: true))
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
        for name in ["lifestream-ios-000011-bbbbbbbbbbbb.zip", "lifestream-ios-000010-cccccccccccc.zip.receipt.json",
                     "shipper.json"] {
            try Data("old".utf8).write(to: exports.appendingPathComponent(name))
        }
        try CaptureExporter(store: store, exportsDirectory: exports).removeBundles(keeping: ["shipper.json"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: exports.path), ["shipper.json"])
    }

    private func plan(after: [CaptureDomain: UInt64] = [:], seal: Int = 1) -> [SealedSource] {
        CaptureDomain.allCases.map {
            SealedSource(domain: $0, source: "\($0.product):local:unit-0001", seal: seal, after: after[$0] ?? 0)
        }
    }

    private func sealed(_ exporter: CaptureExporter, after: [CaptureDomain: UInt64] = [:], seal: Int = 1,
                        now: Date? = nil) async throws -> BuiltExportBundle {
        let bundle = try await exporter.seal(plan(after: after, seal: seal), hardware: .synthetic, appVersion: "1", now: now).bundles.first
        return try XCTUnwrap(bundle)
    }

    private func rig() throws -> (CaptureStore, CaptureExporter) {
        let root = try temporaryDirectory()
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        return (store, CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
    }

    private func append(_ store: CaptureStore, _ domain: CaptureDomain, at second: Int, blob: String? = nil) async throws {
        let at = "2026-09-01T00:00:\(String(format: "%02d", second))Z"
        var payload: [String: JSONValue] = ["creation_date": .string(at)]
        if let blob { payload["blob"] = .object(["hash": .string(blob)]) }
        _ = try await store.append(domain: domain, draft: .init(kind: "synthetic", observedAt: at, payload: .object(payload)))
    }

    private func range(_ bundle: BuiltExportBundle, _ domain: CaptureDomain) -> [UInt64] {
        let file = bundle.manifest.files[domain.filename]
        return [file?.firstSequence, file?.lastSequence].compactMap { $0 }
    }

    private func blobs(_ bundle: BuiltExportBundle) -> Set<String> {
        Set(bundle.manifest.files.filter { $0.key.hasPrefix("blobs/") }.values.map(\.sha256))
    }

    private func artifact(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent(name))
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-seal-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}
