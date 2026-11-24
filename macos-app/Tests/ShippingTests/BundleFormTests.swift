import DeviceFiles
import Evidence
import XCTest
@testable import Shipping

class BundleFormTests: XCTestCase {
    class var form: DeviceFiles.Form { .plain }

    private var root: URL!
    private var files: DeviceFiles!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("bundle-form")
        files = DeviceFiles(type(of: self).form)
    }

    override func tearDownWithError() throws {
        DeviceFiles.meter = nil
        try? FileManager.default.removeItem(at: root)
    }

    private var out: URL { root.appendingPathComponent("out", isDirectory: true) }
    private var keyed: Bool { files.keyed }
    private static let pinned = ZipArchiveProbe.data(hex: BundleWriterTests.bundleHex)
    private static let facts: [(String, JSONText)] = [("batches", .int(1)),
                                                      ("newest_event_at", .string("2026-09-22T22:30:00.000Z")),
                                                      ("snapshot_taken_at", .string(BundleWriterTests.fetchedAt))]

    private func kept(_ name: String, _ text: String) throws -> URL {
        let file = root.appendingPathComponent(name)
        try files.writeNew(file, Data(text.utf8), flush: .data)
        return file
    }

    private func plain(_ name: String, _ text: String) throws -> URL {
        let file = root.appendingPathComponent(name)
        try Data(text.utf8).write(to: file)
        return file
    }

    private func write(_ listed: [BundleWriter.File], blobs: [BundleWriter.Blob]) throws -> BundleWriter.Written {
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        return try BundleWriter.write(
            into: out, sourceId: BundleWriterTests.sourceId, feeder: BundleWriterTests.feeder,
            fetchedAt: ShippingFixture.instant(BundleWriterTests.fetchedAt), files: listed, blobs: blobs,
            facts: Self.facts, custody: nil, through: files)
    }

    private func changeOnTheFirstWrite(_ change: @escaping () throws -> Void) {
        var changed = false
        DeviceFiles.meter = { metered in
            guard case .written = metered, !changed else { return }
            changed = true
            do { try change() } catch { XCTFail("the change between the reads failed: \(error)") }
        }
    }

    private func overwrite(_ file: URL, with text: String) throws {
        let handle = try FileHandle(forWritingTo: file)
        try handle.write(contentsOf: Data(text.utf8))
        try handle.close()
    }


    func testABundleOfKeptFilesOpensToThePlainBuildsPinnedBytes() throws {
        let listed = try kept("listed.jsonl", BundleWriterTests.listedBytes)
        let blob = try kept("blob.bin", BundleWriterTests.blobBytes)
        let written = try write([BundleWriter.File(name: BundleWriterTests.listedName, content: .kept(listed))],
                                blobs: [BundleWriter.Blob(sha256: BundleWriterTests.blobHash, file: blob, kept: true)])

        let disk = try Data(contentsOf: written.file)
        XCTAssertEqual(try files.read(written.file, maximumBytes: 1 << 20), Self.pinned, "the plain bytes are the pinned bundle")
        XCTAssertEqual(try files.size(of: written.file), Self.pinned.count)
        if keyed {
            XCTAssertNotEqual(disk, Self.pinned)
            XCTAssertNil(disk.range(of: Data(BundleWriterTests.listedBytes.utf8)), "no member is plain on disk")
            XCTAssertNil(disk.range(of: Data("manifest.json".utf8)))
        } else {
            XCTAssertEqual(disk, Self.pinned, "a plain Mac writes today's bundle, byte for byte")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path), [written.file.lastPathComponent])
    }

    func testAPlainFileAndABlobFromAnotherAppAreCarriedInBothForms() throws {
        let listed = try plain("listed.jsonl", BundleWriterTests.listedBytes)
        let blob = try plain("blob.bin", BundleWriterTests.blobBytes)
        let written = try write([BundleWriter.File(name: BundleWriterTests.listedName, content: .file(listed))],
                                blobs: [BundleWriter.Blob(sha256: BundleWriterTests.blobHash, file: blob)])
        XCTAssertEqual(try files.read(written.file, maximumBytes: 1 << 20), Self.pinned)
    }

    func testAKeptBlobChangedBetweenItsTwoReadsIsLeftOutAsUncarried() throws {
        let blob = try kept("blob.bin", BundleWriterTests.blobBytes)
        let files = self.files!
        changeOnTheFirstWrite {
            try FileManager.default.removeItem(at: blob)
            try files.writeNew(blob, Data("BLOB bytes\n".utf8), flush: .data)
        }
        XCTAssertThrowsError(try write([], blobs: [BundleWriter.Blob(sha256: BundleWriterTests.blobHash, file: blob, kept: true)])) {
            XCTAssertEqual($0 as? BundleWriterError, .blobMismatch(BundleWriterTests.blobHash))
            XCTAssertEqual(($0 as? BundleWriterError)?.uncarriedBlob?.sha256, BundleWriterTests.blobHash)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path), [], "the bundle is abandoned, no partial left")
    }

    func testABlobFromAnotherAppChangedBetweenItsTwoReadsIsLeftOutAsUncarried() throws {
        let blob = try plain("blob.bin", BundleWriterTests.blobBytes)
        changeOnTheFirstWrite { try self.overwrite(blob, with: "BLOB") }
        XCTAssertThrowsError(try write([], blobs: [BundleWriter.Blob(sha256: BundleWriterTests.blobHash, file: blob)])) {
            XCTAssertEqual(($0 as? BundleWriterError)?.uncarriedBlob?.sha256, BundleWriterTests.blobHash)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path), [])
    }

    func testAListedFileChangedBetweenItsTwoReadsIsNamed() throws {
        let listed = try plain("listed.jsonl", BundleWriterTests.listedBytes)
        changeOnTheFirstWrite { try self.overwrite(listed, with: "[") }
        XCTAssertThrowsError(try write([BundleWriter.File(name: BundleWriterTests.listedName, content: .file(listed))], blobs: [])) {
            XCTAssertEqual($0 as? BundleWriterError, .changed(BundleWriterTests.listedName))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path), [])
    }

    func testAStreamThatReadsDifferentlyTheSecondTimeIsRefused() throws {
        let writer = try ZipWriter(path: root.appendingPathComponent("twice.zip"), files: files)
        var reads = 0
        XCTAssertThrowsError(try writer.addStream("member") { emit in
            reads += 1
            try emit(Data(reads == 1 ? "first".utf8 : "other".utf8))
        }) { XCTAssertEqual($0 as? ZipWriterError, .changed("member")) }
        XCTAssertEqual(reads, 2, "a member is read once to measure and once to copy")
        writer.abort()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }

    func testTheHeldCopyOfAStoreIsMadeInScratchAndGoesWithTheRead() throws {
        let database = root.appendingPathComponent("store.sqlite")
        try DomainFixtures.sqlite(database, ["CREATE TABLE t (id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES (1)"])
        let scratch = root.appendingPathComponent("scratch/mac/app", isDirectory: true)
        let before = Self.inTemporary(SQLiteSource.workPrefix)

        let source = try SQLiteSource(database, scratch: scratch)
        XCTAssertTrue(source.url.path.hasPrefix(scratch.path + "/"), "the held copy is in the process's scratch")
        XCTAssertEqual(try scratch.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: scratch.path)[.posixPermissions] as? Int, 0o700)
        source.close()

        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch.path), [], "the copy goes with the read")
        XCTAssertEqual(Self.inTemporary(SQLiteSource.workPrefix), before, "nothing is copied outside scratch")
    }

    func testASealRequestCarriesTheProcessScratch() {
        let machine = root.appendingPathComponent("Lifestream", isDirectory: true)
        let scratch = SealWork.scratch(machine: machine, .app)
        XCTAssertEqual(scratch.path, machine.appendingPathComponent("scratch/mac/app").path)
        let request = SealRequest(fetchedAt: Date(), workDirectory: root, scratch: scratch, custody: ShippingFixture.first)
        XCTAssertEqual(request.scratch, scratch)
    }

    private static func inTemporary(_ prefix: String) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path)) ?? [])
            .filter { $0.hasPrefix(SealWork.named(prefix)) }.sorted()
    }
}

final class KeyedBundleFormTests: BundleFormTests {
    override class var form: DeviceFiles.Form { .keyed(ShippingFixture.macKey) }
}
