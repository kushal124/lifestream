import CryptoKit
import DeviceFiles
import Evidence
import Foundation
import XCTest
@testable import Audio

final class RecordingFolderKeyedTests: XCTestCase {
    private var root: URL!
    private let key = SymmetricKey(data: Data(repeating: 0x21, count: 32))
    private let stem = "20260930T090000.000Z.mic"
    private let bytes = Data("synthetic audio bytes".utf8)

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("recording-keyed-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var kept: URL { root.appendingPathComponent("audio") }
    private var scratch: URL { root.appendingPathComponent("scratch/audio") }

    private var sidecar: AudioSidecar {
        AudioSidecar(at: "2026-09-30T09:00:00.000Z", until: "2026-09-30T09:00:05.000Z", track: .mic,
                     detectedAt: "2026-09-30T08:59:59.800Z", latencyMs: 200, part: 1, endedBy: nil,
                     device: nil, room: [], camera: [], audio: nil, session: stem)
    }

    private func folder(_ files: DeviceFiles) throws -> RecordingFolder {
        let folder = RecordingFolder(url: kept, scratch: scratch, files: files, report: { _ in })
        try folder.create()
        return folder
    }

    private func onDisk(_ url: URL) throws -> Data {
        try XCTUnwrap(FileManager.default.contents(atPath: url.path))
    }

    func testASealPlacesTheRecordingFromScratchEncryptedAndMeasuresItsPlainBytes() throws {
        let files = DeviceFiles(.keyed(key))
        let folder = try folder(files)
        try bytes.write(to: folder.writing(stem))
        folder.writeOpen(sidecar, stem: stem)

        XCTAssertTrue(folder.seal(sidecar, stem: stem, durationMs: 5_000))

        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.writing(stem).path), "scratch holds nothing after")
        let disk = try onDisk(folder.kept(stem))
        XCTAssertNil(disk.range(of: bytes), "the kept recording is encrypted")
        XCTAssertEqual(try files.read(folder.kept(stem), maximumBytes: 1 << 20), bytes)
        let sealed = try AudioSidecar.decode(try XCTUnwrap(files.read(kept.appendingPathComponent(AudioSpool.sidecarName(stem)),
                                                                      maximumBytes: 1 << 20)))
        XCTAssertEqual(sealed.audio?.bytes, bytes.count)
        XCTAssertEqual(sealed.audio?.sha256, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual(AudioSpool.sealedRecordings(in: kept), [stem])
    }

    func testATornRecordingLeftInScratchIsEncryptedIntoTheFolderAtStartBeforeAnySweep() throws {
        let files = DeviceFiles(.keyed(key))
        let folder = try folder(files)
        try bytes.write(to: folder.writing(stem))
        folder.writeOpen(sidecar, stem: stem)

        folder.recoverLeftovers()

        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch.path), [], "nothing left for the sweep")
        let torn = kept.appendingPathComponent(AudioSpool.audioName(stem) + AudioSpool.tornSuffix)
        XCTAssertNil(try onDisk(torn).range(of: bytes), "the parked recording is encrypted")
        XCTAssertEqual(try files.read(torn, maximumBytes: 1 << 20), bytes)
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.appendingPathComponent(AudioSpool.openName(stem) + AudioSpool.tornSuffix).path))
    }

    func testAPlainSealFromScratchIsARenameOfTodaysBytes() throws {
        let folder = try folder(DeviceFiles(.plain))
        try bytes.write(to: folder.writing(stem))
        folder.writeOpen(sidecar, stem: stem)

        XCTAssertTrue(folder.seal(sidecar, stem: stem, durationMs: 5_000))

        XCTAssertEqual(try onDisk(folder.kept(stem)), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.writing(stem).path))
    }

    func testARecordingCutAfterItsPlaceIsRecoveredInBothForms() throws {
        for files in [DeviceFiles(.plain), DeviceFiles(.keyed(key))] {
            try? FileManager.default.removeItem(at: root)
            let folder = try folder(files)
            let writer = try AudioSegmentWriter(url: folder.writing(stem))
            for chunk in SyntheticAudio.chunks(seconds: 3, at: Date()) { try writer.append(chunk) }
            try writer.finish()
            try files.place(folder.writing(stem), at: folder.kept(stem), flush: .data)
            folder.writeOpen(sidecar, stem: stem)

            folder.recoverLeftovers()

            let sealed = try AudioSidecar.decode(try XCTUnwrap(files.read(kept.appendingPathComponent(AudioSpool.sidecarName(stem)),
                                                                          maximumBytes: 1 << 20)))
            XCTAssertEqual(sealed.endedBy, AudioSidecar.Ending.interrupted.rawValue)
            XCTAssertEqual(Double(try XCTUnwrap(sealed.audio?.durationMs)), 3_000, accuracy: 100)
            XCTAssertEqual(AudioSpool.sealedRecordings(in: kept), [stem])
            XCTAssertFalse(FileManager.default.fileExists(atPath: kept.appendingPathComponent(AudioSpool.audioName(stem) + AudioSpool.tornSuffix).path))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch.path), [], "no plain copy is left")
        }
    }

    func testAnAbsentOpenSidecarParksTheRecordingInBothForms() throws {
        for files in [DeviceFiles(.plain), DeviceFiles(.keyed(key))] {
            try? FileManager.default.removeItem(at: root)
            let folder = try folder(files)
            try bytes.write(to: folder.writing(stem))
            folder.recoverLeftovers()
            let torn = kept.appendingPathComponent(AudioSpool.audioName(stem) + AudioSpool.tornSuffix)
            XCTAssertEqual(try files.read(torn, maximumBytes: 1 << 20), bytes)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch.path), [])
        }
    }

    func testAFailedParkKeepsTheRecordingAndItsOpenSidecarForTheNextStartInBothForms() throws {
        for files in [DeviceFiles(.plain), DeviceFiles(.keyed(key))] {
            try? FileManager.default.removeItem(at: root)
            let folder = try folder(files)
            try bytes.write(to: folder.writing(stem))
            folder.writeOpen(sidecar, stem: stem)
            let open = kept.appendingPathComponent(AudioSpool.openName(stem))
            let torn = kept.appendingPathComponent(AudioSpool.audioName(stem) + AudioSpool.tornSuffix)
            try FileManager.default.createDirectory(at: torn, withIntermediateDirectories: true)
            try Data("in the way".utf8).write(to: torn.appendingPathComponent("blocker"))

            folder.recoverLeftovers()

            XCTAssertEqual(try onDisk(folder.writing(stem)), bytes, "the recording it failed to park is kept")
            XCTAssertTrue(FileManager.default.fileExists(atPath: open.path), "its open sidecar is kept")

            try FileManager.default.removeItem(at: torn)
            folder.recoverLeftovers()

            XCTAssertEqual(try files.read(torn, maximumBytes: 1 << 20), bytes, "the next start parks the same bytes")
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch.path), [])
            XCTAssertTrue(FileManager.default.fileExists(atPath: kept.appendingPathComponent(AudioSpool.openName(stem) + AudioSpool.tornSuffix).path))
        }
    }
}
