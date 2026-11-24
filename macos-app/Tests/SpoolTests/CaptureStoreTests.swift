import Foundation
import XCTest
import Evidence
@testable import Spool

class CaptureStoreTests: SpoolFormCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    private func observation(_ seconds: TimeInterval = 1_700_000_000) -> CaptureObservation {
        CaptureObservation(capturedAt: Date(timeIntervalSince1970: seconds), displayID: 1, width: 2, height: 2,
                           ocr: [TextObservation(text: "synthetic fixture", confidence: 0.8,
                                                bounds: CaptureRect(x: 0, y: 0, width: 1, height: 1))])
    }
    private func image(_ value: UInt8 = 17) -> CaptureImage {
        .raw(SpoolFixtures.frame(width: 2, height: 2, value: value))
    }
    func testDurableReopenPreservesObservationAndImageLink() throws {
        let stored: CaptureObservation
        do {
            let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
            stored = try writer.append(observation: observation(), image: image(90))
        }
        let reopened = try CaptureStore(directory: root, files: files, scratch: scratch)
        XCTAssertEqual(try reopened.read(), [stored])
        XCTAssertTrue(try XCTUnwrap(stored.imageFile).hasSuffix("image.open"))
        SpoolFixtures.assertPixels(try reopened.readImage(for: stored), near: 90)
        XCTAssertEqual(try reopened.status().recordCount, 1)
    }
    func testWriterContentionAndConcurrentReader() throws {
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
        try writer.append(observation: observation(), image: nil)
        XCTAssertThrowsError(try CaptureStore(directory: root, files: files, scratch: scratch))
        let reader = try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true)
        XCTAssertEqual(try reader.read().count, 1)
        XCTAssertThrowsError(try reader.append(observation: observation(), image: nil))
        withExtendedLifetime(writer) {}
    }
    func testReadOrdersAcrossPartitionsAndAppliesInclusiveLimit() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        for offset in [172800.0, 0, 86400, 1] {
            try store.append(observation: observation(1_700_000_000 + offset), image: nil)
        }
        let first = try store.read(limit: 2)
        XCTAssertEqual(first.map(\.capturedAt), [observation().capturedAt, observation(1_700_000_001).capturedAt])
        let later = try store.read(limit: 1, since: Date(timeIntervalSince1970: 1_700_086_400))
        XCTAssertEqual(later.first?.capturedAt, Date(timeIntervalSince1970: 1_700_086_400))
        XCTAssertEqual(try store.read(limit: 0), [])
    }
    func testCrashLeftoversIgnoredAndReported() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        try store.append(observation: observation(), image: nil)
        let entries = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        let day = try XCTUnwrap(entries.first { !$0.lastPathComponent.hasPrefix(".") })
        let partial = day.appendingPathComponent(".pending-interrupted")
        try FileManager.default.createDirectory(at: partial, withIntermediateDirectories: false)
        try keep(Data("unfinished".utf8), at: partial.appendingPathComponent("observation.lsm"))
        XCTAssertEqual(try store.read().count, 1)
        XCTAssertEqual(try store.status().incompleteCount, 1)
    }
    func testIndexedSinceSkipsValidOldNamesButFullScansStillAudit() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let old = try store.append(observation: observation(), image: image())
        let recent = try store.append(observation: observation(1_700_000_010), image: image())
        let bundle = root.appendingPathComponent(try XCTUnwrap(old.imageFile)).deletingLastPathComponent()
        try keep(Data("invalid packet".utf8), at: bundle.appendingPathComponent("observation.lsm"))
        XCTAssertEqual(try store.read(since: recent.capturedAt), [recent])
        XCTAssertThrowsError(try store.read())
        XCTAssertThrowsError(try store.status())
    }
    func testMalformedOldIndexNameStillValidated() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let old = try store.append(observation: observation(), image: image())
        let bundle = root.appendingPathComponent(try XCTUnwrap(old.imageFile)).deletingLastPathComponent()
        let malformed = bundle.deletingLastPathComponent().appendingPathComponent("00001700000000000000-not-a-uuid")
        try FileManager.default.moveItem(at: bundle, to: malformed)
        XCTAssertThrowsError(try store.read(since: Date(timeIntervalSince1970: 1_700_000_010)))
    }
    func testIndexedBoundaryGuardRetainsRoundedMicrosecondCandidates() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let seconds = 1_700_000_000.1234567
        let saved = try store.append(observation: observation(seconds), image: image())
        let decoded = try XCTUnwrap(store.read().first)
        XCTAssertEqual(try store.read(since: decoded.capturedAt), [decoded])
        let bundle = root.appendingPathComponent(try XCTUnwrap(saved.imageFile)).deletingLastPathComponent()
        try keep(Data("invalid packet".utf8), at: bundle.appendingPathComponent("observation.lsm"))
        XCTAssertThrowsError(try store.read(since: Date(timeIntervalSince1970: seconds + 0.0005)))
        XCTAssertEqual(try store.read(since: Date(timeIntervalSince1970: seconds + 0.01)), [])
    }
    func testSinceParsedFromAFramesPrintedTimeReadsThatFrame() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        for seconds in [1_700_000_000.1236, 1_700_006_399.9996] {
            let saved = try store.append(observation: observation(seconds), image: nil)
            let printed = UTCInstant.rfc3339(saved.capturedAt)
            let since = try XCTUnwrap(UTCInstant.date(rfc3339: printed))
            XCTAssertLessThan(saved.capturedAt, since, printed)
            XCTAssertEqual(try store.read(limit: 1, since: since), [saved], printed)
        }
    }
    func testMalformedCommittedBundleFailsLoudly() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let saved = try store.append(observation: observation(), image: image())
        let image = root.appendingPathComponent(try XCTUnwrap(saved.imageFile))
        let metadata = image.deletingLastPathComponent().appendingPathComponent("observation.lsm")
        try keep(MetadataCodec.encode(Data("invalid json".utf8)), at: metadata)
        XCTAssertThrowsError(try store.read())
        XCTAssertThrowsError(try store.status())
    }
    func testReadPreservesMetadataFailureAndBundleContext() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let saved = try store.append(observation: observation(), image: image())
        let bundle = root.appendingPathComponent(try XCTUnwrap(saved.imageFile)).deletingLastPathComponent()
        let metadata = bundle.appendingPathComponent("observation.lsm")
        var packet = try kept(metadata)
        packet[packet.count - 1] ^= 1
        try keep(packet, at: metadata)
        XCTAssertThrowsError(try store.read()) { error in
            guard case CaptureStoreError.bundleFailure(let name, let cause) = error else {
                return XCTFail("Expected the failing bundle and original typed cause")
            }
            XCTAssertEqual(name, bundle.lastPathComponent)
            XCTAssertEqual(cause as? MetadataCodecError, .integrityMismatch)
            XCTAssertTrue(String(describing: error).contains("checksum"))
        }
    }
    func testMissingImageFailsLoudly() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let saved = try store.append(observation: observation(), image: image())
        try FileManager.default.removeItem(at: root.appendingPathComponent(XCTUnwrap(saved.imageFile)))
        XCTAssertThrowsError(try store.read())
    }
    func testRejectsInvalidInputsWithoutPublishing() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        var invalid = observation()
        invalid.imageFile = "../outside.png"
        XCTAssertThrowsError(try store.append(observation: invalid, image: nil))
        invalid = observation()
        invalid.width = -1
        XCTAssertThrowsError(try store.append(observation: invalid, image: image()))
        XCTAssertThrowsError(try store.append(observation: observation(), image: .png(Data())))
        XCTAssertThrowsError(try store.append(observation: observation(), image: .png(Data([1, 2, 3]))),
                             "an image the encoder cannot take is refused")
        XCTAssertEqual(try store.status().recordCount, 0)
    }
    func testSymlinkPartitionCannotRedirectWrites() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let outside = root.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let day = root.appendingPathComponent("2023-11-14")
        try FileManager.default.createSymbolicLink(at: day, withDestinationURL: outside)
        XCTAssertThrowsError(try store.append(observation: observation(), image: image()))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
    }
    private func raw(_ value: UInt8 = 17) -> RawFrame {
        SpoolFixtures.frame(width: 64, height: 64, value: value)
    }
    private func admitted(_ store: CaptureStore, _ item: CaptureObservation) throws -> CaptureStore.CompactionFrame {
        try XCTUnwrap(store.admit([XCTUnwrap(item.imageFile)]).first)
    }
    private func rawObservation(_ seconds: TimeInterval = 1_700_000_000) -> CaptureObservation {
        CaptureObservation(capturedAt: Date(timeIntervalSince1970: seconds), displayID: 1, width: 64, height: 64)
    }
    func testImageAndAncestorSymlinksAreRejected() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let first = try store.append(observation: rawObservation(), image: .raw(raw()))
        let url = root.appendingPathComponent(try XCTUnwrap(first.imageFile))
        let outside = root.appendingPathComponent("other.open")
        try FileManager.default.moveItem(at: url, to: outside)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: outside)
        XCTAssertThrowsError(try store.readImage(for: first))
        try FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: outside, to: url)
        let bundle = url.deletingLastPathComponent()
        let moved = root.appendingPathComponent("moved")
        try FileManager.default.moveItem(at: bundle, to: moved)
        try FileManager.default.createSymbolicLink(at: bundle, withDestinationURL: moved)
        XCTAssertThrowsError(try store.readImage(for: first))
    }

    private func observedReader(_ count: ObservationDecodeCount) throws -> CaptureStore {
        try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true, observationDecoder: { data in
            count.increment()
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            return try decoder.decode(CaptureObservation.self, from: data)
        })
    }
    func testEachImageReadDecodesCurrentMetadataOnce() throws {
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
        let original = try writer.append(observation: rawObservation(), image: .raw(raw()))
        let count = ObservationDecodeCount(), reader = try observedReader(count)
        let first = try reader.readImage(for: original)
        SpoolFixtures.assertPixels(first, near: 17)
        count.reset()
        for invocation in 1...2 {
            XCTAssertEqual(try reader.readImage(for: original), first)
            XCTAssertEqual(count.value, invocation,
                           "Each invocation validates current metadata once; no repeated decode or retained cache")
        }
    }
    func testImageReadRejectsForgedHandlesAndChangedOrCorruptCurrentMetadata() throws {
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
        let original = try writer.append(observation: rawObservation(), image: .raw(raw()))
        let count = ObservationDecodeCount(), reader = try observedReader(count)
        XCTAssertNoThrow(try reader.readImage(for: original))
        var forged = original
        forged.reason = "synthetic forged handle"
        XCTAssertThrowsError(try reader.readImage(for: forged)) { error in
            guard case CaptureStoreError.corruptBundle("observation-mismatch") = error else {
                return XCTFail("Expected current metadata to reject the forged handle")
            }
        }
        let bundle = root.appendingPathComponent(try XCTUnwrap(original.imageFile)).deletingLastPathComponent()
        let metadata = bundle.appendingPathComponent("observation.lsm")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        var changed = original
        changed.reason = "synthetic changed metadata"
        var bytes = try MetadataCodec.encode(encoder.encode(changed))
        try keep(bytes, at: metadata)
        XCTAssertThrowsError(try reader.readImage(for: original)) { error in
            guard case CaptureStoreError.corruptBundle("observation-mismatch") = error else {
                return XCTFail("Expected a fresh per-read metadata check")
            }
        }
        bytes[bytes.count - 1] ^= 1
        try keep(bytes, at: metadata)
        XCTAssertThrowsError(try reader.readImage(for: original)) { error in
            guard case CaptureStoreError.bundleFailure(_, let cause) = error else {
                return XCTFail("Expected the current metadata integrity failure")
            }
            XCTAssertEqual(cause as? MetadataCodecError, .integrityMismatch)
        }
    }
    private func entry(_ path: String, capturedAt: Date, metadataSHA256: Data) -> ArchiveSidecar {
        let segment = SpoolLayout.segmentPath(id: UUID().uuidString.lowercased())
        let reference = SegmentReference(version: 1, segment: segment, segmentSHA256: Data(count: 32), ordinal: 0,
                                         frameCount: 1, capturedAt: capturedAt,
                                         encoding: CaptureVideoProvenance(width: 64, height: 64, quality: 1))
        return ArchiveSidecar(imagePath: path, metadataSHA256: metadataSHA256, reference: reference)
    }
    func testArchiveEntryRequiresCurrentMetadataBytesAndAPendingOrArchivedBundle() throws {
        for change in ["bytes", "valid-object", "missing-metadata", "metadata-symlink", "bundle-symlink",
                       "no-image"] {
            let directory = root.appendingPathComponent(change)
            let writer = try CaptureStore(directory: directory, files: files, scratch: scratch)
            let original = try writer.append(observation: rawObservation(), image: .raw(raw()))
            let admitted = try admitted(writer, original)
            let path = try XCTUnwrap(original.imageFile)
            let archiveEntry = entry(path, capturedAt: original.capturedAt, metadataSHA256: admitted.metadataSHA256)
            XCTAssertNoThrow(try writer.validateArchiveEntry(archiveEntry), change)
            let image = directory.appendingPathComponent(path), bundle = image.deletingLastPathComponent()
            let metadata = bundle.appendingPathComponent("observation.lsm")
            let bytes = try kept(metadata)
            switch change {
            case "bytes":
                let stamp = Date(timeIntervalSince1970: 1_700_000_000)
                let disk = try Data(contentsOf: metadata)
                try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: metadata.path)
                var changed = bytes
                changed[changed.count - 1] ^= 1
                try keep(changed, at: metadata)
                try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: metadata.path)
                let attributes = try FileManager.default.attributesOfItem(atPath: metadata.path)
                XCTAssertEqual((attributes[.size] as? NSNumber)?.intValue, disk.count)
                XCTAssertEqual(attributes[.modificationDate] as? Date, stamp)
            case "valid-object":
                var changed = original
                changed.reason = "synthetic changed observation"
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .millisecondsSince1970
                try keep(MetadataCodec.encode(encoder.encode(changed)), at: metadata)
            case "missing-metadata":
                try FileManager.default.removeItem(at: metadata)
            case "metadata-symlink":
                let target = directory.appendingPathComponent("redirected.lsm")
                try FileManager.default.moveItem(at: metadata, to: target)
                try FileManager.default.createSymbolicLink(at: metadata, withDestinationURL: target)
            case "bundle-symlink":
                let target = directory.appendingPathComponent("redirected-bundle")
                try FileManager.default.moveItem(at: bundle, to: target)
                try FileManager.default.createSymbolicLink(at: bundle, withDestinationURL: target)
            default:
                try FileManager.default.removeItem(at: image)
            }
            XCTAssertThrowsError(try writer.validateArchiveEntry(archiveEntry), change)
            XCTAssertEqual(FileManager.default.fileExists(atPath: image.path), change != "no-image",
                           "Verification must not delete original pixels")
        }
    }
    func testArchiveEntryCannotBeMatchedToAnotherBundle() throws {
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
        let first = try writer.append(observation: rawObservation(), image: .raw(raw()))
        let second = try writer.append(observation: rawObservation(1_700_000_001), image: .raw(raw(25)))
        let admitted = try admitted(writer, first)
        let firstPath = try XCTUnwrap(first.imageFile)
        XCTAssertThrowsError(try writer.validateArchiveEntry(
            entry(XCTUnwrap(second.imageFile), capturedAt: first.capturedAt, metadataSHA256: admitted.metadataSHA256)))
        XCTAssertThrowsError(try writer.validateArchiveEntry(
            entry(firstPath, capturedAt: first.capturedAt, metadataSHA256: Data(repeating: 0, count: 32))))
        XCTAssertNoThrow(try writer.validateArchiveEntry(
            entry(firstPath, capturedAt: first.capturedAt, metadataSHA256: admitted.metadataSHA256)))
        SpoolFixtures.assertPixels(try writer.readImage(for: admitted.observation), near: 17)
    }
    func testAdmissionFullyDecodesAccessibilityAndSkipsFailuresForThisStoreOnly() throws {
        var writer: CaptureStore? = try CaptureStore(directory: root, files: files, scratch: scratch)
        let original = try XCTUnwrap(writer).append(observation: rawObservation(), image: .raw(raw()))
        let metadata = root.appendingPathComponent(try XCTUnwrap(original.imageFile))
            .deletingLastPathComponent().appendingPathComponent("observation.lsm")
        let json = try MetadataCodec.decode(kept(metadata))
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        document["accessibility"] = "not an accessibility object"
        try keep(MetadataCodec.encode(JSONSerialization.data(withJSONObject: document)), at: metadata)
        XCTAssertTrue(try XCTUnwrap(writer).admit([XCTUnwrap(original.imageFile)]).isEmpty,
                      "Admission must fully validate AX, not just archive header fields")
        XCTAssertEqual(writer?.pendingVideoReport().skippedImageCount, 1)
        XCTAssertEqual(writer?.pendingVideoReport().pendingImageCount, 1)
        document.removeValue(forKey: "accessibility")
        document["reason"] = "synthetic new metadata"
        try keep(MetadataCodec.encode(JSONSerialization.data(withJSONObject: document)), at: metadata)
        writer = nil
        let reopened = try CaptureStore(directory: root, files: files, scratch: scratch)
        let admitted = try admitted(reopened, original)
        XCTAssertEqual(admitted.observation.reason, "synthetic new metadata")
        XCTAssertEqual(reopened.pendingVideoReport().skippedImageCount, 0, "A new store tries it once more")
        SpoolFixtures.assertPixels(try reopened.readImage(for: admitted.observation), near: 17)
    }
    func testIndependentFramesSurviveFailedAppendAndGap() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let first = try store.append(observation: rawObservation(), image: .raw(raw()))
        let outside = root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let nextDay = root.appendingPathComponent("2023-11-15")
        try FileManager.default.createSymbolicLink(at: nextDay, withDestinationURL: outside)
        XCTAssertThrowsError(try store.append(observation: rawObservation(1_700_086_400), image: .raw(raw(99))))
        try store.append(observation: observation(1_700_000_001), image: nil)
        let next = try store.append(observation: rawObservation(1_700_000_002), image: .raw(raw(99)))
        SpoolFixtures.assertPixels(try store.readImage(for: first), near: 17)
        SpoolFixtures.assertPixels(try store.readImage(for: next), near: 99)
    }
    func testMissingCorruptAndSymlinkMetadataRejected() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        let saved = try store.append(observation: observation(), image: image())
        let bundle = root.appendingPathComponent(try XCTUnwrap(saved.imageFile)).deletingLastPathComponent()
        let packetURL = bundle.appendingPathComponent("observation.lsm")
        let packet = try kept(packetURL)
        try keep(Data(packet.prefix(20)), at: packetURL)
        XCTAssertThrowsError(try store.status())
        try FileManager.default.removeItem(at: packetURL)
        XCTAssertThrowsError(try store.read())
        let other = root.appendingPathComponent("other.lsm")
        try keep(packet, at: other)
        try FileManager.default.createSymbolicLink(at: packetURL, withDestinationURL: other)
        XCTAssertThrowsError(try store.read())
    }
    private func writer(space: FreeSpaceFixture, decode: @escaping (Data) throws -> CaptureObservation = {
        try SpoolJSON.decode(CaptureObservation.self, from: $0)
    }) throws -> CaptureStore {
        try CaptureStore(directory: root, files: files, scratch: scratch, observationDecoder: decode, fits: { space.fits })
    }
    func testImagesWaitWhileTheDiskIsFullAndGapsAreAlwaysAdmitted() throws {
        let space = FreeSpaceFixture(true)
        let store = try writer(space: space)
        let admitted = try store.append(observation: rawObservation(), image: .raw(raw()))
        XCTAssertFalse(store.videoBackpressure())
        let gap = CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_001), displayID: 0,
                                     width: 0, height: 0, status: "gap", reason: "storage_backpressure")
        try store.append(observation: gap, image: nil)
        space.fits = false
        XCTAssertTrue(store.videoBackpressure())
        let refused = rawObservation(1_700_000_002)
        XCTAssertThrowsError(try store.append(observation: refused, image: .raw(raw()))) { error in
            guard case CaptureStoreError.archiveBacklogFull = error else { return XCTFail("Expected backpressure") }
            XCTAssertEqual(String(describing: error), "The capture volume is full; images wait for space")
        }
        try store.append(observation: gap, image: nil)
        SpoolFixtures.assertPixels(try store.readImage(for: admitted), near: 17)
        space.fits = true
        XCTAssertFalse(store.videoBackpressure())
        try store.append(observation: rawObservation(1_700_000_003), image: .raw(raw()))
        XCTAssertEqual(try store.status().recordCount, 4)
    }
    func testAppendIsNotBlockedWhileAdmissionDecodes() throws {
        let probe = AppendProbe()
        let store = try writer(space: FreeSpaceFixture(true)) { data in
            probe.runOnce()
            return try SpoolJSON.decode(CaptureObservation.self, from: data)
        }
        let frame = try store.append(observation: rawObservation(), image: .raw(raw()))
        let gap = observation(1_700_000_001)
        probe.arm {
            let finished = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                _ = try? store.append(observation: gap, image: nil)
                finished.signal()
            }
            return finished.wait(timeout: .now() + 30) == .success
        }
        XCTAssertEqual(store.admit([try XCTUnwrap(frame.imageFile)]).count, 1)
        XCTAssertEqual(probe.completed, true)
        XCTAssertEqual(try store.status().recordCount, 2)
    }

    func testAWriterOpensWithNoBundleReadOutsideItsOpenSegmentsLogs() throws {
        let logged: [CaptureObservation]
        do {
            let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
            for day in 0..<10 {
                try writer.append(observation: observation(1_700_000_000 + Double(day) * 86_400), image: nil)
            }
            try (1...2).forEach { try writer.append(observation: rawObservation(1_700_000_010 + Double($0)), image: .raw(raw())) }
            while try VideoCompaction.compact(store: writer, flush: true).imageCount > 0 {}
            logged = try (1...3).flatMap { display in
                try (0..<2).map { index in
                    var item = rawObservation(1_700_777_600 + Double(display * 10 + index))
                    item.displayID = UInt32(display)
                    return try writer.append(observation: item, image: .raw(raw()))
                }
            }
        }
        let open = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".video").path)
            .filter { $0.hasPrefix(".open-") }
        XCTAssertEqual(open.count, 3)
        let reads = ReadRecord(), decodes = ObservationDecodeCount()
        let reopened = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1, observationDecoder: { data in
            decodes.increment()
            return try SpoolJSON.decode(CaptureObservation.self, from: data)
        }, readFile: { url, maximum in
            reads.add(url)
            return try SpoolFiles.read(self.files, url, maximumBytes: maximum)
        })
        XCTAssertEqual(decodes.value, 1, "only the newest bundle's metadata is decoded")
        let opened = Set(try logged.map { try XCTUnwrap($0.imageFile) })
        let newest = try XCTUnwrap(logged.max { $0.capturedAt < $1.capturedAt })
        let newestMetadata = (try XCTUnwrap(newest.imageFile) as NSString).deletingLastPathComponent + "/" + SpoolLayout.metadata
        let video = root.appendingPathComponent(".video").standardizedFileURL.path + "/.open-"
        for url in reads.urls {
            let path = url.standardizedFileURL.path
            let relative = String(path.dropFirst(root.standardizedFileURL.path.count + 1))
            XCTAssertTrue(path.hasPrefix(video) || opened.contains(relative) || relative == newestMetadata,
                          "read outside the logs: \(relative)")
        }
        XCTAssertEqual(reads.urls.filter { $0.lastPathComponent == SpoolLayout.metadata }.count, 1)
        XCTAssertEqual(reopened.newestObservation, NewestObservation(capturedAt: newest.capturedAt, end: newest.capturedAt))
        XCTAssertEqual(reads.urls.filter { $0.lastPathComponent == "image.open" }.count, logged.count)
        XCTAssertEqual(Set(reopened.pendingImages.keys), opened)
    }

    func testAWriterOpensKnowingTheNewestObservationAcrossADay() throws {
        XCTAssertNil(try CaptureStore(directory: root, files: files, scratch: scratch).newestObservation, "an empty spool")
        do {
            let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
            try writer.append(observation: observation(1_700_006_399), image: nil)
            try writer.append(observation: observation(1_700_006_401), image: nil)
            var span = observation(1_700_006_402)
            span.status = "gap"
            span.capturedUntil = Date(timeIntervalSince1970: 1_700_006_500)
            try writer.append(observation: span, image: nil)
        }
        let later = root.appendingPathComponent(SpoolLayout.dayName(for: Date(timeIntervalSince1970: 1_700_100_000)))
        try FileManager.default.createDirectory(at: later.appendingPathComponent(SpoolLayout.stagingPrefix + "unfinished"),
                                                withIntermediateDirectories: true)
        let reopened = try CaptureStore(directory: root, files: files, scratch: scratch)
        XCTAssertEqual(reopened.newestObservation, NewestObservation(capturedAt: Date(timeIntervalSince1970: 1_700_006_402),
                                                                     end: Date(timeIntervalSince1970: 1_700_006_500)))
        XCTAssertNotEqual(SpoolLayout.dayName(for: Date(timeIntervalSince1970: 1_700_006_399)),
                          SpoolLayout.dayName(for: Date(timeIntervalSince1970: 1_700_006_402)))
        XCTAssertFalse(reopened.newestUnreadable)
        withExtendedLifetime(reopened) {}
        XCTAssertNil(try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true).newestObservation, "a reader reads none")
    }

    func testANewestBundleThatDoesNotReadIsToldApartFromAnEmptySpool() throws {
        do {
            let empty = try CaptureStore(directory: root, files: files, scratch: scratch)
            XCTAssertNil(empty.newestObservation)
            XCTAssertFalse(empty.newestUnreadable, "an empty spool")
            try empty.append(observation: observation(1_700_000_000), image: nil)
        }
        let unreadable = try CaptureStore(directory: root, files: files, scratch: scratch, observationDecoder: { _ in throw CaptureStoreError.io("read", EIO) })
        XCTAssertNil(unreadable.newestObservation)
        XCTAssertTrue(unreadable.newestUnreadable)
    }

    func testAFlushThatFailsAfterTheRenameSaysTheBundleWasPublished() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                     flushDay: { _ in throw CaptureStoreError.io("flush", EIO) })
        var span = observation(1_700_000_000)
        span.status = "gap"
        span.capturedUntil = Date(timeIntervalSince1970: 1_700_000_090)
        XCTAssertThrowsError(try store.append(observation: span, image: nil)) { error in
            guard case .publishedNotFlushed(let end, let cause)? = error as? CaptureStoreError else {
                return XCTFail("\(error)")
            }
            XCTAssertEqual(end, Date(timeIntervalSince1970: 1_700_000_090))
            guard case .io(_, let code)? = cause as? CaptureStoreError else { return XCTFail("\(cause)") }
            XCTAssertEqual(code, EIO)
        }
        XCTAssertEqual(try store.status().recordCount, 1, "visible: the rename landed")
    }

    func testACallerNamedAppendPublishesOneBundleOfItsName() throws {
        var span = observation(1_700_000_000.123_456)
        span.status = "gap"
        span.capturedUntil = Date(timeIntervalSince1970: 1_700_000_090)
        let name = CaptureStore.bundleName(for: span.capturedAt)
        let stored: CaptureObservation
        do {
            let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
            stored = try writer.append(observation: span, image: nil, bundle: name)
            XCTAssertEqual(try writer.append(observation: span, image: nil, bundle: name), stored, "done: the bundle as stored")
            XCTAssertEqual(try writer.status().recordCount, 1)
        }
        var inherited = span
        inherited.capturedAt = Date(timeIntervalSince1970: 1_700_000_000.123)
        let next = try CaptureStore(directory: root, files: files, scratch: scratch)
        XCTAssertEqual(try next.append(observation: inherited, image: nil, bundle: name), stored)
        XCTAssertEqual(try next.read(), [stored], "one bundle, not two")
        let day = root.appendingPathComponent(SpoolLayout.dayName(for: span.capturedAt))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: day.path), [name])
    }

    func testACallerNamedAppendPublishedButNotFlushedIsFlushedNotPublishedAgain() throws {
        var span = observation(1_700_000_000)
        span.status = "gap"
        span.capturedUntil = Date(timeIntervalSince1970: 1_700_000_090)
        let name = CaptureStore.bundleName(for: span.capturedAt)
        do {
            let failing = try CaptureStore(directory: root, files: files, scratch: scratch, observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                           flushDay: { _ in throw CaptureStoreError.io("flush", EIO) })
            XCTAssertThrowsError(try failing.append(observation: span, image: nil, bundle: name)) { error in
                guard case .publishedNotFlushed? = error as? CaptureStoreError else { return XCTFail("\(error)") }
            }
            XCTAssertThrowsError(try failing.append(observation: span, image: nil, bundle: name), "the flush fails again") { error in
                guard case .publishedNotFlushed? = error as? CaptureStoreError else { return XCTFail("\(error)") }
            }
            XCTAssertEqual(try failing.status().recordCount, 1)
        }
        let flushed = Counter()
        let next = try CaptureStore(directory: root, files: files, scratch: scratch, observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                    flushDay: { _ in flushed.add() })
        try next.append(observation: span, image: nil, bundle: name)
        XCTAssertEqual(flushed.value, 1, "its day flushed: durable on return")
        XCTAssertEqual(try next.status().recordCount, 1, "one bundle, not two")

        var later = span
        later.capturedAt = Date(timeIntervalSince1970: 1_700_000_100)
        let other = CaptureStore.bundleName(for: later.capturedAt)
        let day = root.appendingPathComponent(SpoolLayout.dayName(for: later.capturedAt))
        try FileManager.default.createDirectory(at: day.appendingPathComponent(SpoolLayout.stagingPrefix + other), withIntermediateDirectories: false)
        try next.append(observation: later, image: nil, bundle: other)
        XCTAssertEqual(try next.status().recordCount, 2)
        XCTAssertEqual(try next.status().incompleteCount, 0)
    }

    func testACallerNameMustBeABundleNameForItsInstant() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        var span = observation(1_700_000_000)
        span.status = "gap"
        for name in ["not-a-bundle", CaptureStore.bundleName(for: Date(timeIntervalSince1970: 1_700_000_001))] {
            XCTAssertThrowsError(try store.append(observation: span, image: nil, bundle: name)) { error in
                guard case .invalidObservation? = error as? CaptureStoreError else { return XCTFail("\(error)") }
            }
        }
        XCTAssertEqual(try store.status().recordCount, 0)
        XCTAssertEqual(try store.status().incompleteCount, 0)
    }

    func testAWriterRemovesDeadStagingAtOpenAndAReaderRemovesNothing() throws {
        let staged = try [1_700_000_000.0, 1_700_090_000].map { seconds -> URL in
            let date = Date(timeIntervalSince1970: seconds)
            let day = root.appendingPathComponent(SpoolLayout.dayName(for: date))
            let folder = day.appendingPathComponent(".pending-" + SpoolLayout.bundleName(capturedAt: date, id: UUID()))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try keep(Data("unfinished".utf8), at: folder.appendingPathComponent("observation.lsm"))
            return folder
        }
        let other = staged[0].deletingLastPathComponent().appendingPathComponent(".pending-not-a-bundle")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: false)
        let preparation = root.appendingPathComponent(".video/.pending-" + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: preparation, withIntermediateDirectories: true)
        try keep(Data("synthetic movie".utf8), at: preparation.appendingPathComponent("movie.mov"))
        let exists = { (url: URL) in FileManager.default.fileExists(atPath: url.path) }

        let reader = try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true)
        XCTAssertEqual(try reader.status().incompleteCount, 3)
        XCTAssertTrue(staged.allSatisfy(exists), "a read-only store removes nothing")
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch)
        XCTAssertFalse(staged.contains(where: exists), "every dead staging folder is gone")
        XCTAssertTrue(exists(other), "a name outside the grammar is not a staged append")
        XCTAssertTrue(exists(preparation.appendingPathComponent("movie.mov")), "compaction's preparations are its own")
        XCTAssertEqual(try writer.status().incompleteCount, 1)
    }
    func testAppendRejectsOversizeMetadataWithoutPublishing() throws {
        var invalid = observation()
        invalid.reason = String(repeating: "x", count: MetadataCodec.maximumJSONBytes)
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        XCTAssertThrowsError(try store.append(observation: invalid, image: nil))
        XCTAssertEqual(try store.status().recordCount, 0)
        XCTAssertEqual(try store.status().incompleteCount, 0, "refused before any staging: no dead staging under a living writer")
    }
}

private final class ObservationDecodeCount {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    func reset() {
        lock.lock()
        count = 0
        lock.unlock()
    }
}

private final class ReadRecord: @unchecked Sendable {
    private let lock = NSLock()
    private var read: [URL] = []

    var urls: [URL] { lock.withLock { read } }

    func add(_ url: URL) { lock.withLock { read.append(url) } }
}

private final class FreeSpaceFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool

    init(_ fits: Bool) {
        value = fits
    }

    var fits: Bool {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

private final class AppendProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var action: (() -> Bool)?
    private var result: Bool?

    var completed: Bool? {
        lock.lock()
        defer { lock.unlock() }
        return result
    }

    func arm(_ action: @escaping () -> Bool) {
        lock.lock()
        self.action = action
        lock.unlock()
    }

    func runOnce() {
        lock.lock()
        let pending = action
        action = nil
        lock.unlock()
        guard let pending else {
            return
        }
        let finished = pending()
        lock.lock()
        result = finished
        lock.unlock()
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}

final class CaptureStoreKeyedTests: CaptureStoreTests {
    override class var keyed: Bool { true }
}
